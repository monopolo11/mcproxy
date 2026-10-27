import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** Centered single-line state for loading, empty, and failure views. */
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <p role={error ? "alert" : undefined} className={cn("text-sm", error ? "text-destructive" : "text-muted-foreground")}>
        {children}
      </p>
    </div>
  )
}
