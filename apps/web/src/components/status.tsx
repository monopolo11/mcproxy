import type { Profile } from "@/lib/api"
import { cn } from "@/lib/utils"

const STATUS = {
  ready: { label: "Ready", dot: "bg-success" },
  needs_auth: { label: "Needs authorization", dot: "bg-warning" },
  error: { label: "Error", dot: "bg-destructive" },
} as const satisfies Record<Profile["status"], { label: string; dot: string }>

/** Static status dot, optionally with its label. */
export function ProfileStatus({ status, showLabel = false }: { status: Profile["status"]; showLabel?: boolean }) {
  const { label, dot } = STATUS[status]
  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      {showLabel ? <span>{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  )
}
