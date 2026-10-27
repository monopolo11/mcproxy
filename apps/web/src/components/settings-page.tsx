import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { CLIENT_IDS, CLIENT_LABELS, clientServerName } from "@/lib/clients"
import { updatePrefs, usePrefs } from "@/lib/prefs"
import { healthQuery } from "@/lib/queries"
import { ClientLogo } from "./client-logos"
import { CopyButton } from "./copy-button"
import { Page, PageBody, PageHeader, Row, Rows, Section } from "./page"
import { StatusDot } from "./status"

/** What the daemon reports about itself. */
export function DaemonSettings() {
  const health = useQuery(healthQuery)
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
            <Row label="Version">{health.data?.version ?? "Unknown"}</Row>
            <Row label="Platform">
              <code className="font-mono text-xs">{health.data?.platform ?? "Unknown"}</code>
            </Row>
            <Row label="Base URL">
              <code className="font-mono text-xs">{origin}</code>
              <CopyButton value={origin} label="Copy base URL" />
            </Row>
          </Rows>
        </Section>
      </PageBody>
    </Page>
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
