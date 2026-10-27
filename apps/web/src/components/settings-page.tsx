import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage, UPDATE_CHANNELS, type UpdateChannel, type UpdateStatus } from "@/lib/api"
import { CLIENT_IDS, CLIENT_LABELS, clientServerName } from "@/lib/clients"
import { updatePrefs, usePrefs } from "@/lib/prefs"
import { healthQuery, updateQuery, useApplyUpdate, useCheckUpdate, useSetUpdateChannel } from "@/lib/queries"
import { ClientLogo } from "./client-logos"
import { CopyButton } from "./copy-button"
import { ErrorText } from "./field"
import { Page, PageBody, PageHeader, Row, Rows, Section } from "./page"
import { StatusDot } from "./status"

/** What the daemon reports about itself, and its updates. */
export function DaemonSettings() {
  const health = useQuery(healthQuery)
  const update = useQuery(updateQuery)
  const origin = window.location.origin

  return (
    <Page>
      <PageHeader crumbs={["Settings", "Daemon"]} />
      <PageBody>
        <Section title="Daemon">
          <Rows>
            <Row label="Status">
              {health.isSuccess ? (
                <>
                  <StatusDot status="ready" /> Online
                </>
              ) : health.isPending ? (
                <>
                  <StatusDot /> Checking
                </>
              ) : (
                <>
                  <StatusDot status="error" /> Offline
                  <Button variant="outline" size="xs" onClick={() => health.refetch()}>
                    Retry
                  </Button>
                </>
              )}
            </Row>
            <Row label="Version">
              {update.data ? <Version status={update.data} /> : (health.data?.version ?? "Unknown")}
            </Row>
            <Row label="Platform">
              <code className="font-mono text-xs">{health.data?.platform ?? "Unknown"}</code>
            </Row>
            <Row label="Base URL">
              <code className="font-mono text-xs">{origin}</code>
              <CopyButton value={origin} label="Copy base URL" />
            </Row>
          </Rows>
        </Section>
        {update.data ? <Updates status={update.data} /> : null}
      </PageBody>
    </Page>
  )
}

const CHANNEL_LABELS: Record<UpdateChannel, string> = { stable: "Stable", nightly: "Nightly" }

/** Identifies the running build: a release changes on update, a commit for development. */
const buildOf = (status: UpdateStatus) => status.version ?? status.commit

function Version({ status }: { status: UpdateStatus }) {
  if (status.version) return status.version
  return (
    <>
      Development build
      {status.commit ? (
        <code className="font-mono text-xs text-muted-foreground">
          {status.commit}
          {status.modified ? " modified" : ""}
        </code>
      ) : null}
    </>
  )
}

function Updates({ status }: { status: UpdateStatus }) {
  const setChannel = useSetUpdateChannel()
  const check = useCheckUpdate()
  const apply = useApplyUpdate()
  // The build an update started from; the page reloads once the daemon runs another.
  const [from, setFrom] = useState<string>()
  useEffect(() => {
    if (from !== undefined && !status.applying && buildOf(status) !== from) window.location.reload()
  }, [from, status])

  const error = setChannel.error ?? check.error ?? apply.error
  const checkButton = (
    <Button variant="outline" size="xs" onClick={() => check.mutate()} disabled={check.isPending}>
      {check.isPending ? "Checking" : "Check"}
    </Button>
  )

  return (
    <Section title="Updates">
      <Rows>
        <Row label="Channel">
          <Select
            value={status.channel}
            disabled={status.applying}
            onValueChange={(value) => {
              const next = UPDATE_CHANNELS.find((channel) => channel === value)
              if (next) setChannel.mutate(next)
            }}
          >
            <SelectTrigger size="sm" aria-label="Update channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UPDATE_CHANNELS.map((channel) => (
                <SelectItem key={channel} value={channel}>
                  {CHANNEL_LABELS[channel]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label="Available">
          {status.applying ? (
            <span role="status">Updating to {status.available?.version ?? "the new version"}, then restarting</span>
          ) : !status.updatable ? (
            <span className="text-muted-foreground">Development builds are not updated</span>
          ) : !status.checkedAt ? (
            <span className="text-muted-foreground">Checking</span>
          ) : status.checkError ? (
            <>
              <span className="text-destructive">{status.checkError}</span>
              {checkButton}
            </>
          ) : status.available ? (
            <>
              {status.available.version}
              <Button variant="link" size="xs" className="h-auto px-0" asChild>
                <a href={status.available.url} target="_blank" rel="noopener noreferrer">
                  Release notes
                </a>
              </Button>
              <Button
                size="xs"
                disabled={apply.isPending}
                onClick={() => {
                  setFrom(buildOf(status))
                  apply.mutate()
                }}
              >
                Update and restart
              </Button>
            </>
          ) : (
            <>
              Up to date
              {checkButton}
            </>
          )}
        </Row>
      </Rows>
      {error ? <ErrorText>{errorMessage(error)}</ErrorText> : null}
      {status.applyError ? <ErrorText>{status.applyError}</ErrorText> : null}
    </Section>
  )
}

/** Which clients appear in the Add to client tabs. Stored in this browser only. */
export function ClientSettings() {
  const prefs = usePrefs()

  return (
    <Page>
      <PageHeader crumbs={["Settings", "Clients"]} />
      <PageBody>
        <Section title="Add to client">
          <Rows>
            {CLIENT_IDS.map((id) => {
              const checked = !prefs.hiddenClients.includes(id)
              const inputId = `client-${id}`
              return (
                <Row
                  key={id}
                  label={
                    <span className="flex items-center gap-2 text-foreground">
                      <ClientLogo id={id} /> {CLIENT_LABELS[id]}
                    </span>
                  }
                >
                  <Checkbox
                    id={inputId}
                    checked={checked}
                    onCheckedChange={(next) =>
                      updatePrefs({
                        hiddenClients:
                          next === true
                            ? prefs.hiddenClients.filter((item) => item !== id)
                            : [...prefs.hiddenClients, id],
                      })
                    }
                  />
                  <Label htmlFor={inputId} className="font-normal text-muted-foreground">
                    Show on profile pages
                  </Label>
                </Row>
              )
            })}
          </Rows>
        </Section>

        <Section title="Server name">
          <Rows>
            <Row label="Pattern">
              <code className="font-mono text-xs">{clientServerName("provider", "profile")}</code>
              <span className="text-muted-foreground">for example {clientServerName("linear", "work")}</span>
            </Row>
          </Rows>
        </Section>
      </PageBody>
    </Page>
  )
}
