import { useQueries, type UseQueryResult } from "@tanstack/react-query"
import { ChevronRightIcon, WrenchIcon } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { errorMessage, type Tool } from "@/lib/api"
import { toolsQuery } from "@/lib/queries"
import { matchesTool, toolParams } from "@/lib/tools"
import { CopyButton } from "./copy-button"

/**
 * One profile whose tools the sheet lists. `prefix` renames them the way a
 * toolkit exposes them; `label` turns the list into a group with a header.
 */
export type ToolSource = { profileId: string; prefix?: string; label?: ReactNode }

type Group = { source: ToolSource; result: UseQueryResult<Tool[]>; visible?: Tool[] }

/**
 * Tool count, once known, and a "View" button that opens the sources' tools in
 * a side sheet. Tools load on first open unless a passing test already listed them.
 */
export function ToolsSheet({ sources }: { sources: readonly ToolSource[] }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const results = useQueries({
    queries: sources.map(({ profileId, prefix = "" }) => ({
      ...toolsQuery(profileId),
      enabled: open,
      select: (tools: Tool[]) => tools.map((tool) => ({ ...tool, name: prefix + tool.name })),
    })),
  })
  const groups: Group[] = sources.flatMap((source, index) => {
    const result = results[index]
    return result ? [{ source, result, visible: result.data?.filter((tool) => matchesTool(tool, query)) }] : []
  })
  const count = groups.every((group) => group.result.data)
    ? groups.reduce((sum, group) => sum + (group.result.data?.length ?? 0), 0)
    : undefined
  const anyTools = groups.some((group) => group.result.data?.length)
  const noMatches = anyTools && groups.every((group) => group.visible?.length === 0)

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery("")
      }}
    >
      {count !== undefined ? <span>{count} {count === 1 ? "tool" : "tools"}</span> : null}
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <WrenchIcon /> View
        </Button>
      </SheetTrigger>
      <SheetContent aria-describedby={undefined}>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4 pr-10">
          <SheetTitle>Tools</SheetTitle>
          {count !== undefined ? <span className="text-muted-foreground">{count}</span> : null}
        </header>
        {anyTools ? (
          <div className="border-b px-4 py-2">
            <Input
              id="tools-filter"
              aria-label="Filter tools"
              className="h-8"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter tools"
              spellCheck={false}
            />
          </div>
        ) : null}
        <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
          {groups.map((group) => (
            <ToolGroup key={group.source.profileId} group={group} filtering={query.trim() !== ""} />
          ))}
          {noMatches ? <li className="px-4 py-3 text-muted-foreground">No matching tools</li> : null}
        </ul>
      </SheetContent>
    </Sheet>
  )
}

/**
 * One source's tools. A labelled source gets a sticky header that collapses the
 * group; filtering keeps every group open so matches are never hidden.
 */
function ToolGroup({ group: { source, result, visible }, filtering }: { group: Group; filtering: boolean }) {
  const [expanded, setExpanded] = useState(true)
  // Filtered out entirely: the sheet shows a single "No matching tools" instead.
  if (result.data?.length && visible?.length === 0) return null
  return (
    <li>
      <Collapsible open={!source.label || expanded || filtering} onOpenChange={setExpanded} className="group/source">
        {source.label ? (
          <CollapsibleTrigger
            disabled={filtering}
            className="sticky top-0 z-10 flex h-8 w-full items-center gap-2 bg-background group-data-[state=open]/source:border-b px-4 text-left text-xs hover:bg-accent/40"
          >
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground group-data-[state=open]/source:rotate-90" />
            {source.label}
            {result.data ? <span className="ml-auto text-muted-foreground">{result.data.length}</span> : null}
          </CollapsibleTrigger>
        ) : null}
        <CollapsibleContent>
          {visible?.length ? (
            <ul className="divide-y">
              {visible.map((tool) => (
                <ToolItem key={tool.name} tool={tool} />
              ))}
            </ul>
          ) : result.data ? (
            <p className="px-4 py-3 text-muted-foreground">This upstream has no tools</p>
          ) : result.isError ? (
            <div className="grid justify-items-start gap-2 px-4 py-3">
              <p role="alert" className="text-destructive">{errorMessage(result.error)}</p>
              <Button variant="outline" size="sm" onClick={() => void result.refetch()}>
                Retry
              </Button>
            </div>
          ) : (
            <p className="px-4 py-3 text-muted-foreground">Connecting to upstream</p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

function ToolItem({ tool }: { tool: Tool }) {
  const params = toolParams(tool)
  const readOnly = tool.annotations?.readOnlyHint === true
  const destructive = !readOnly && tool.annotations?.destructiveHint === true

  return (
    <li>
      <Collapsible className="group">
        <CollapsibleTrigger className="flex w-full items-baseline gap-2 px-4 py-2 text-left hover:bg-accent/40">
          <ChevronRightIcon className="size-3.5 shrink-0 self-center text-muted-foreground group-data-[state=open]:rotate-90" />
          <span className="min-w-0 truncate font-mono text-xs font-semibold">{tool.name}</span>
          {readOnly ? <span className="ml-auto text-xs text-success">read-only</span> : null}
          {destructive ? <span className="ml-auto text-xs text-destructive">destructive</span> : null}
        </CollapsibleTrigger>
        <CollapsibleContent className="grid gap-2 px-4 pb-3 pl-9.5">
          {tool.description ? (
            <p className="whitespace-pre-line text-muted-foreground">{tool.description}</p>
          ) : null}
          {params.length > 0 ? (
            <table className="w-full text-left">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="py-1 pr-3 font-normal">Parameter</th>
                  <th className="py-1 font-normal">Type</th>
                </tr>
              </thead>
              <tbody>
                {params.map((param) => (
                  <tr key={param.name} className="align-top">
                    <td className="py-1 pr-3">
                      <span className="font-mono text-xs">{param.name}</span>
                      {param.required ? <span className="text-warning" title="Required"> *</span> : null}
                      {param.description ? (
                        <p className="text-xs text-muted-foreground">{param.description}</p>
                      ) : null}
                    </td>
                    <td className="py-1 font-mono text-xs break-words text-muted-foreground">{param.type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-muted-foreground">No parameters</p>
          )}
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            JSON definition
            <CopyButton value={JSON.stringify(tool, null, 2)} label={`Copy ${tool.name} definition`} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
