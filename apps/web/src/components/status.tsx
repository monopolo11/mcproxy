import type { Profile } from "@/lib/api"
import { cn } from "@/lib/utils"

const STATUS = {
  ready: { label: "Ready", dot: "bg-success" },
  needs_auth: { label: "Needs authorization", dot: "bg-warning" },
  error: { label: "Error", dot: "bg-destructive" },
} as const satisfies Record<Profile["status"], { label: string; dot: string }>

/** Static 8px dot; no status renders a neutral one. */
export function StatusDot({ status, className }: { status?: Profile["status"]; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", status ? STATUS[status].dot : "bg-muted-foreground/40", className)}
    />
  )
}

/** Status dot with its label, visible or screen-reader only. */
export function ProfileStatus({ status, showLabel = false }: { status: Profile["status"]; showLabel?: boolean }) {
  const { label } = STATUS[status]
  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      <StatusDot status={status} />
      {showLabel ? <span>{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  )
}

/** Worst status across a provider's profiles; undefined when it has none. */
export function aggregateStatus(profiles: readonly Profile[]): Profile["status"] | undefined {
  if (profiles.some((profile) => profile.status === "error")) return "error"
  if (profiles.some((profile) => profile.status === "needs_auth")) return "needs_auth"
  return profiles.length > 0 ? "ready" : undefined
}
