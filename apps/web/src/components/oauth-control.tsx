import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { errorMessage, type Profile } from "@/lib/api"
import { profilesQuery, useStartOAuth } from "@/lib/queries"
import { ErrorText } from "./field"

const POLL_MS = 2_000
const TIMEOUT_MS = 10 * 60_000

type Pending = { url: string; observedAt: number }

/**
 * Starts the daemon's OAuth flow in a new tab and polls profile state until the
 * daemon reports the outcome. The UI never marks a profile connected itself.
 */
export function OAuthControl({ profile, onConnectionChange }: { profile: Profile; onConnectionChange?: () => void }) {
  const client = useQueryClient()
  const start = useStartOAuth()
  const [pending, setPending] = useState<Pending>()
  const [outcome, setOutcome] = useState<string>()

  // Faster refetch for this provider's profiles while authorization is open.
  const profiles = useQuery({ ...profilesQuery(profile.providerId), refetchInterval: pending ? POLL_MS : false })
  const current = profiles.data?.find((item) => item.id === profile.id)

  // Authorization has its own state: a reconnect can keep the old connection ready.
  useEffect(() => {
    // Query notifications can lag setPending. Only a later fetch can finish this attempt.
    if (!pending || profiles.dataUpdatedAt <= pending.observedAt || !current) return
    if (current.oauthStatus === "idle") {
      setPending(undefined)
      onConnectionChange?.()
      if (current.status === "ready") {
        setOutcome(undefined)
        toast.success(`${profile.name} authorized`)
      } else {
        setOutcome("Authorization was reset. Connect again.")
      }
    } else if (current.oauthStatus === "error") {
      setPending(undefined)
      onConnectionChange?.()
      setOutcome(current.lastError ?? "Authorization failed.")
    }
  }, [pending, profiles.dataUpdatedAt, current, profile.name, onConnectionChange])

  // The wait also ends on timeout or when the user stops it. `popup.closed` is not trusted:
  // authorization servers with COOP report it closed immediately.
  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => {
      setPending(undefined)
      setOutcome("Authorization timed out. Try again.")
    }, TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [pending])

  const finish = () => {
    setPending(undefined)
    void client.invalidateQueries({ queryKey: profilesQuery(profile.providerId).queryKey })
  }

  const begin = () => {
    setOutcome(undefined)
    // Open synchronously inside the click so popup blockers allow it.
    const popup = window.open("about:blank", "_blank")
    start.mutate(profile.id, {
      onSuccess: async ({ authorizationUrl }) => {
        try {
          // Read the new attempt before opening consent, avoiding the old idle state.
          await client.cancelQueries({ queryKey: profilesQuery(profile.providerId).queryKey })
          const profiles = await client.fetchQuery({ ...profilesQuery(profile.providerId), staleTime: 0 })
          const current = profiles.find((item) => item.id === profile.id)
          if (!current) throw new Error("Profile no longer exists.")
          if (current.oauthStatus !== "pending") throw new Error(current.lastError ?? "Authorization did not start.")
          onConnectionChange?.()
          setPending({
            url: authorizationUrl,
            observedAt: client.getQueryState(profilesQuery(profile.providerId).queryKey)?.dataUpdatedAt ?? Date.now(),
          })
          start.reset()
          if (popup && !popup.closed) {
            popup.opener = null
            popup.location.href = authorizationUrl
          }
        } catch (error) {
          popup?.close()
          setOutcome(errorMessage(error))
        }
      },
      onError: () => popup?.close(),
    })
  }

  const label = profile.status === "ready" ? "Reconnect" : "Connect"
  const authorizationError = outcome ?? (current?.oauthStatus === "error" ? current.lastError : undefined)

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {pending ? (
          <>
            <span role="status" className="text-sm">
              Waiting for authorization in your browser
            </span>
            <Button variant="link" size="sm" className="h-auto px-0" asChild>
              <a href={pending.url} target="_blank" rel="noopener noreferrer">
                Open page
              </a>
            </Button>
            <Button variant="ghost" size="sm" onClick={finish}>
              Stop waiting
            </Button>
          </>
        ) : (
          <Button size="sm" variant={profile.status === "ready" ? "outline" : "default"} onClick={begin} disabled={start.isPending}>
            {start.isPending ? "Starting" : label}
          </Button>
        )}
      </div>
      {start.error ? <ErrorText>{errorMessage(start.error)}</ErrorText> : null}
      {authorizationError ? <ErrorText>{authorizationError}</ErrorText> : null}
    </div>
  )
}
