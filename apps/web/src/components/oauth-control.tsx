import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { errorMessage, type Profile } from "@/lib/api"
import { profilesQuery, useStartOAuth } from "@/lib/queries"
import { ErrorText } from "./field"

const POLL_MS = 2_000
const TIMEOUT_MS = 10 * 60_000

type Pending = { url: string; from: Profile["status"] }

/**
 * Starts the daemon's OAuth flow in a new tab and polls profile state until the
 * daemon reports the outcome. The UI never marks a profile connected itself.
 */
export function OAuthControl({ profile }: { profile: Profile }) {
  const client = useQueryClient()
  const start = useStartOAuth()
  const [pending, setPending] = useState<Pending>()
  const [outcome, setOutcome] = useState<string>()

  // Faster refetch for this provider's profiles while authorization is open.
  useQuery({ ...profilesQuery(profile.providerId), refetchInterval: pending ? POLL_MS : false })

  // Resolve from daemon-reported status changes.
  useEffect(() => {
    if (!pending) return
    if (profile.status === "ready" && pending.from !== "ready") {
      setPending(undefined)
      setOutcome(undefined)
      toast.success(`${profile.name} authorized`)
    } else if (profile.status === "error" && pending.from !== "error") {
      setPending(undefined)
      setOutcome(profile.lastError ?? "Authorization failed.")
    }
  }, [pending, profile.status, profile.lastError, profile.name])

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
          // Read the daemon's pending state before opening consent. This also
          // lets reconnect observe needs_auth -> ready without using stale cache.
          await client.cancelQueries({ queryKey: profilesQuery(profile.providerId).queryKey })
          const profiles = await client.fetchQuery({ ...profilesQuery(profile.providerId), staleTime: 0 })
          const current = profiles.find((item) => item.id === profile.id)
          if (!current) throw new Error("Profile no longer exists.")
          setPending({ url: authorizationUrl, from: current.status })
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
              {pending.from === "ready" ? "Done" : "Stop waiting"}
            </Button>
          </>
        ) : (
          <Button size="sm" variant={profile.status === "ready" ? "outline" : "default"} onClick={begin} disabled={start.isPending}>
            {start.isPending ? "Starting" : label}
          </Button>
        )}
      </div>
      {start.error ? <ErrorText>{errorMessage(start.error)}</ErrorText> : null}
      {outcome ? <ErrorText>{outcome}</ErrorText> : null}
    </div>
  )
}
