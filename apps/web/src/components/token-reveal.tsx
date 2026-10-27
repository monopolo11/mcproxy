import { CopyButton } from "./copy-button"

/**
 * One-time display of a downstream access token. The token lives only in the
 * parent's component state and is dropped when the dialog closes.
 */
export function TokenReveal({ token, endpoint }: { token: string; endpoint: string }) {
  const header = `Authorization: Bearer ${token}`
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        Copy this access token now. mcproxy stores only a hash and cannot show it again.
      </p>
      <Row label="Access token" value={token} />
      <Row label="Header" value={header} />
      <Row label="Endpoint" value={endpoint} />
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium">{label}</span>
      <div className="flex items-center gap-1 rounded-md border bg-muted/40 pl-2">
        <code className="min-w-0 flex-1 overflow-x-auto py-1.5 font-mono text-xs whitespace-nowrap select-all">
          {value}
        </code>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  )
}
