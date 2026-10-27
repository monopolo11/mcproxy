import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { errorMessage } from "@/lib/api"
import { healthQuery, providersQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { ProviderDialog } from "./provider-dialog"

/** Provider navigation plus daemon health. */
export function Sidebar() {
  const providers = useQuery(providersQuery)

  return (
    <nav
      aria-label="Providers"
      className="flex max-h-56 shrink-0 flex-col border-b bg-sidebar md:h-full md:max-h-none md:w-60 md:border-r md:border-b-0"
    >
      <div className="flex h-11 items-center justify-between border-b pr-1.5 pl-3">
        <Link to="/" className="font-mono text-sm font-semibold tracking-tight">
          mcproxy
        </Link>
        <ProviderDialog
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label="Add provider" title="Add provider">
              <PlusIcon />
            </Button>
          }
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {providers.isPending ? (
          <p className="px-3 py-2 text-muted-foreground">Loading</p>
        ) : providers.isError ? (
          <div className="grid gap-2 px-3 py-2">
            <p role="alert" className="text-destructive">{errorMessage(providers.error)}</p>
            <Button variant="outline" size="xs" className="justify-self-start" onClick={() => providers.refetch()}>
              Retry
            </Button>
          </div>
        ) : providers.data.length === 0 ? (
          <p className="px-3 py-2 text-muted-foreground">No providers</p>
        ) : (
          <ul>
            {providers.data.map((provider) => (
              <li key={provider.id}>
                <Link
                  to="/providers/$providerId"
                  params={{ providerId: provider.id }}
                  className={cn(
                    "mx-1 flex h-8 items-center justify-between gap-2 rounded-md px-2 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    "data-[status=active]:bg-accent data-[status=active]:font-medium",
                  )}
                >
                  <span className="truncate">{provider.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{provider.transport.type}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <DaemonStatus />
    </nav>
  )
}

function DaemonStatus() {
  const health = useQuery(healthQuery)
  const online = health.isSuccess
  return (
    <div className="flex h-9 items-center gap-2 border-t px-3 font-mono text-xs" role="status">
      <span aria-hidden className={cn("size-1.5 rounded-full", online ? "bg-success" : health.isPending ? "bg-muted-foreground" : "bg-destructive")} />
      {online
        ? `daemon ${health.data.version} ${health.data.platform}`
        : health.isPending
          ? "daemon"
          : "daemon offline"}
    </div>
  )
}
