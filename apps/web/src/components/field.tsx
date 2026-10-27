import type { ReactNode } from "react"
import { Label } from "@/components/ui/label"

/** First message from a TanStack Form error list (strings or Standard Schema issues). */
export function firstError(errors: readonly unknown[]): string | undefined {
  for (const error of errors) {
    if (typeof error === "string") return error
    if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
      return error.message
    }
  }
  return undefined
}

type FieldMeta = { isTouched: boolean; errors: readonly unknown[] }

/** Error to show for a field once the user has interacted with it. */
export function visibleError(meta: FieldMeta): string | undefined {
  return meta.isTouched ? firstError(meta.errors) : undefined
}

/**
 * Label, control, and error line for one form field. `content-start` keeps the
 * rows packed when a sibling in the same grid row is taller (e.g. shows an
 * error), so labels and inputs stay aligned across columns.
 */
export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string
  label: string
  error?: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** aria attributes linking a control to the message rendered by Field. */
export function describedBy(id: string, error: string | undefined, hint?: string) {
  return {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${id}-error` : hint ? `${id}-hint` : undefined,
  }
}

/** Inline failure message with the ARIA role screen readers announce. */
export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  )
}
