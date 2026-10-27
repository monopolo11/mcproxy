import { Fragment, type ReactNode } from "react"
import { cn } from "@/lib/utils"

/** Full-height page: fixed header bar, scrolling body. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col">{children}</div>
}

/** 44px bar with a breadcrumb trail, optional status, and actions on the right. */
export function PageHeader({
  crumbs,
  status,
  actions,
}: {
  crumbs: ReactNode[]
  status?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b px-5">
      <h1 className="flex min-w-0 items-center gap-1.5">
        {crumbs.map((crumb, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <span aria-hidden className="text-muted-foreground">
                /
              </span>
            ) : null}
            <span
              className={cn(
                "truncate",
                index === crumbs.length - 1 ? "font-semibold" : "text-muted-foreground",
              )}
            >
              {crumb}
            </span>
          </Fragment>
        ))}
      </h1>
      {status}
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </header>
  )
}

export function PageBody({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid max-w-4xl gap-6 p-5">{children}</div>
    </div>
  )
}

/** Titled block of a page body. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-1.5">
      <h2 className="text-xs font-semibold">{title}</h2>
      {children}
    </section>
  )
}

/** Grouped key/value rows: hairline frame, label column, value column. */
export function Rows({ children }: { children: ReactNode }) {
  return <dl className="divide-y overflow-hidden rounded-lg border">{children}</dl>
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-10 items-center gap-x-4 gap-y-1 px-3.5 py-1.5 sm:grid-cols-[150px_1fr]">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</dd>
    </div>
  )
}

/** Same frame as Rows for link lists. */
export function ListGroup({ children }: { children: ReactNode }) {
  return <ul className="divide-y overflow-hidden rounded-lg border">{children}</ul>
}
