import { useQueries, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronRightIcon, PlusIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { errorMessage, type Provider, type Toolkit } from "@/lib/api"
import { type NavSectionId, updatePrefs, usePrefs } from "@/lib/prefs"
import { healthQuery, profilesQuery, providersQuery, toolkitsQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { ProviderDialog } from "./provider-dialog"
import { aggregateStatus, StatusDot } from "./status"
import { ToolkitDialog } from "./toolkit-dialog"

/** Collapsible MCP tree, toolkits, settings links, daemon health. */
export function Sidebar() {
  const providers = useQuery(providersQuery)
  const toolkits = useQuery(toolkitsQuery)

  return (
    <nav
      aria-label="Main"
      className="flex max-h-72 shrink-0 flex-col border-b bg-sidebar md:h-full md:max-h-none md:w-60 md:border-r md:border-b-0"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3.5">
        <span aria-hidden className="size-3.5 rounded-[3px] bg-indicator" />
        <Link to="/" className="font-semibold tracking-tight">
          mcproxy
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <NavSection id="mcps" label="MCPs" count={providers.data?.length}>
          <McpTree providers={providers} />
        </NavSection>

        <NavSection id="toolkits" label="Toolkits" count={toolkits.data?.length}>
          <ToolkitList toolkits={toolkits} />
        </NavSection>

        <NavSection id="settings" label="Settings">
          <Link to="/settings/daemon" className={navItem(1)}>
            Daemon
          </Link>
          <Link to="/settings/clients" className={navItem(1)}>
            Clients
          </Link>
        </NavSection>
      </div>

      <DaemonStatus />
    </nav>
  )
}

const navItem = (depth: 0 | 1) =>
  cn(
    "flex h-7 items-center gap-2 rounded-md pr-2 outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring",
    "data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium",
    depth === 0 ? "pl-3.5" : "pl-7",
  )

function NavSection({
  id,
  label,
  count,
  children,
}: {
  id: NavSectionId
  label: string
  count?: number
  children: ReactNode
}) {
  const prefs = usePrefs()
  const open = !prefs.collapsed.includes(id)
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) =>
        updatePrefs({
          collapsed: next ? prefs.collapsed.filter((item) => item !== id) : [...prefs.collapsed, id],
        })
      }
    >
      <CollapsibleTrigger className="group flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon className="size-3.5 transition-transform duration-150 group-data-[state=open]:rotate-90" />
        {label}
        {count !== undefined ? <span className="ml-auto tabular-nums">{count}</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-px pt-0.5 pb-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function McpTree({ providers }: { providers: ReturnType<typeof useQuery<Provider[]>> }) {
  const list = providers.data ?? []
  const profiles = useQueries({ queries: list.map((provider) => profilesQuery(provider.id)) })

  if (providers.isPending) return <p className="px-3.5 py-1 text-muted-foreground">Loading</p>
  if (providers.isError) {
    return (
      <div className="grid gap-2 px-3.5 py-1">
        <p role="alert" className="text-destructive">
          {errorMessage(providers.error)}
        </p>
        <Button variant="outline" size="xs" className="justify-self-start" onClick={() => providers.refetch()}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <>
      {list.length === 0 ? <p className="px-3.5 py-1 text-muted-foreground">No MCPs yet</p> : null}
      {list.map((provider, index) => {
        const nested = profiles[index]?.data ?? []
        return (
          <div key={provider.id} className="grid gap-px">
            <Link
              to="/providers/$providerId"
              params={{ providerId: provider.id }}
              activeOptions={{ exact: true }}
              className={navItem(0)}
            >
              <StatusDot status={aggregateStatus(nested)} />
              <span className="min-w-0 flex-1 truncate">{provider.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{provider.transport.type}</span>
            </Link>
            {nested.map((profile) => (
              <Link
                key={profile.id}
                to="/providers/$providerId/profiles/$profileId"
                params={{ providerId: provider.id, profileId: profile.id }}
                className={navItem(1)}
              >
                <StatusDot status={profile.status} />
                <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{profile.authType}</span>
              </Link>
            ))}
          </div>
        )
      })}
      <ProviderDialog
        trigger={
          <button type="button" className={cn(navItem(0), "w-full text-link")}>
            <PlusIcon className="size-3.5" /> Add MCP
          </button>
        }
      />
    </>
  )
}

function ToolkitList({ toolkits }: { toolkits: ReturnType<typeof useQuery<Toolkit[]>> }) {
  if (toolkits.isPending) return <p className="px-3.5 py-1 text-muted-foreground">Loading</p>
  if (toolkits.isError) {
    return (
      <p role="alert" className="px-3.5 py-1 text-destructive">
        {errorMessage(toolkits.error)}
      </p>
    )
  }
  return (
    <>
      {toolkits.data.map((toolkit) => (
        <Link key={toolkit.id} to="/toolkit/$toolkitId" params={{ toolkitId: toolkit.id }} className={navItem(0)}>
          <span className="min-w-0 flex-1 truncate">{toolkit.name}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{toolkit.members.length}</span>
        </Link>
      ))}
      <ToolkitDialog
        mode={{ kind: "create" }}
        trigger={
          <button type="button" className={cn(navItem(0), "w-full text-link")}>
            <PlusIcon className="size-3.5" /> Add toolkit
          </button>
        }
      />
    </>
  )
}

function DaemonStatus() {
  const health = useQuery(healthQuery)
  const online = health.isSuccess
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-t px-3.5 text-xs text-muted-foreground" role="status">
      <span
        aria-hidden
        className={cn("size-2 rounded-full", online ? "bg-success" : health.isPending ? "bg-muted-foreground/40" : "bg-destructive")}
      />
      {online ? (
        <>
          Daemon {health.data.version}
          <span className="ml-auto font-mono">{health.data.platform}</span>
        </>
      ) : health.isPending ? (
        "Daemon"
      ) : (
        "Daemon offline"
      )}
    </div>
  )
}
