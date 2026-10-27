import { EyeIcon, EyeOffIcon, RotateCwIcon } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { errorMessage, type Profile } from "@/lib/api"
import { useRevealToken, useRotateToken } from "@/lib/queries"
import { ConfirmDialog } from "./confirm-dialog"
import { CopyButton } from "./copy-button"
import { ErrorText } from "./field"

export const TOKEN_MASK = "••••••••••••••••••••••••••••••••••••••••••"

/**
 * Downstream token for one profile. The value is fetched on demand and lives
 * only in component state; hiding it drops the copy, rotating replaces it.
 */
export function useAccessToken(profile: Profile) {
  const reveal = useRevealToken()
  const rotate = useRotateToken()
  const [token, setToken] = useState<string>()
  const [shown, setShown] = useState(false)
  const [error, setError] = useState<string>()

  /** Current token, fetching it when needed. Lets copy work while masked. */
  const ensure = async () => {
    if (token) return token
    const { accessToken } = await reveal.mutateAsync(profile.id)
    reveal.reset()
    setToken(accessToken)
    return accessToken
  }

  return {
    /** Visible value, undefined while masked. */
    token: shown ? token : undefined,
    shown,
    error,
    pending: reveal.isPending,
    ensure,
    show: async () => {
      try {
        await ensure()
        setShown(true)
        setError(undefined)
      } catch (cause) {
        setError(errorMessage(cause))
      }
    },
    hide: () => {
      setShown(false)
      setToken(undefined)
    },
    rotate: async () => {
      const { accessToken } = await rotate.mutateAsync(profile.id)
      rotate.reset()
      setToken(accessToken)
      setShown(true)
      setError(undefined)
    },
  }
}

export type AccessToken = ReturnType<typeof useAccessToken>

/** Masked field with show, copy and rotate. */
export function AccessTokenField({
  profile,
  token,
  onRotated,
}: {
  profile: Profile
  token: AccessToken
  onRotated?: () => void
}) {
  return (
    <div className="grid w-full gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-0.5 border-b border-input bg-field pr-0.5 pl-3 sm:max-w-xl">
          <code className="min-w-0 flex-1 truncate font-mono text-xs">
            {token.token ?? (
              <>
                <span aria-hidden="true">{TOKEN_MASK}</span>
                <span className="sr-only">Hidden</span>
              </>
            )}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={token.shown ? "Hide token" : "Show token"}
            title={token.shown ? "Hide token" : "Show token"}
            disabled={token.pending}
            onClick={token.shown ? token.hide : token.show}
          >
            {token.shown ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
          <CopyButton value={token.ensure} label="Copy token" />
        </div>
        <ConfirmDialog
          trigger={
            <Button variant="outline" size="sm">
              <RotateCwIcon /> Rotate
            </Button>
          }
          title={`Rotate token for ${profile.name}?`}
          description="The current token stops working immediately and connected clients are disconnected. Update clients with the new token."
          confirmLabel="Rotate token"
          pendingLabel="Rotating"
          onConfirm={async () => {
            await token.rotate()
            onRotated?.()
          }}
        />
      </div>
      {token.error ? <ErrorText>{token.error}</ErrorText> : null}
    </div>
  )
}
