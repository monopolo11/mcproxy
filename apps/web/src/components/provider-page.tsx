import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { ChevronRightIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { absoluteEndpoint, errorMessage, type Provider } from "@/lib/api"
import { AUTH_LABELS } from "@/lib/forms"
import { profilesQuery, providersQuery, useDeleteProvider } from "@/lib/queries"
import { ConfirmDialog } from "./confirm-dialog"
import { Notice } from "./notice"
import { ListGroup, Page, PageBody, PageHeader, Row, Rows, Section } from "./page"
import { ProfileDialog } from "./profile-dialog"
import { ProfileStatus } from "./status"

/** One MCP: its profiles and the upstream server configuration. */
export function ProviderPage({ providerId }: { providerId: string }) {
  const providers = useQuery(providersQuery)
  const provider = providers.data?.find((item) => item.id === providerId)

  if (providers.isPending) return <Notice>Loading</Notice>
  if (providers.isError) return <Notice error>{errorMessage(providers.error)}</Notice>
  if (!provider) {
    return (
      <Notice>
        MCP not found.{" "}
        <Link to="/" className="underline underline-offset-4">
          Back
        </Link>
      </Notice>
    )
  }
  return <ProviderDetail key={provider.id} provider={provider} />
}

function ProviderDetail({ provider }: { provider: Provider }) {
  const navigate = useNavigate()
  const remove = useDeleteProvider()
  const profiles = useQuery(profilesQuery(provider.id))
  const count = profiles.data?.length
  const { transport } = provider

  return (
    <Page>
      <PageHeader
        crumbs={[provider.name]}
        status={<span className="font-mono text-xs text-muted-foreground">{transport.type}</span>}
        actions={
          <>
            <ProfileDialog
              provider={provider}
              mode={{ kind: "create" }}
              trigger={
                <Button size="sm">
                  <PlusIcon /> New profile
                </Button>
              }
            />
            <ConfirmDialog
              trigger={
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                  <Trash2Icon /> Delete
                </Button>
              }
              title={`Delete ${provider.name}?`}
              description={
                count === undefined
                  ? "Its profiles are deleted, their sessions close, and their endpoints stop working."
                  : `${count} ${count === 1 ? "profile is" : "profiles are"} deleted, sessions close, and endpoints stop working.`
              }
              confirmLabel="Delete MCP"
              pendingLabel="Deleting"
              onConfirm={async () => {
                await remove.mutateAsync(provider.id)
                await navigate({ to: "/" })
              }}
            />
          </>
        }
      />
      <PageBody>
        <Section title="Profiles">
          {profiles.isPending ? (
            <p className="text-muted-foreground">Loading</p>
          ) : profiles.isError ? (
            <div className="flex items-center gap-3">
              <p role="alert" className="text-destructive">
                {errorMessage(profiles.error)}
              </p>
              <Button variant="outline" size="xs" onClick={() => profiles.refetch()}>
                Retry
              </Button>
            </div>
          ) : profiles.data.length === 0 ? (
            <div className="flex items-center gap-3 rounded-lg border px-3.5 py-3">
              <p className="text-muted-foreground">No profiles yet. Each profile gets its own endpoint and token.</p>
              <ProfileDialog
                provider={provider}
                mode={{ kind: "create" }}
                trigger={
                  <Button variant="outline" size="sm">
                    <PlusIcon /> New profile
                  </Button>
                }
              />
            </div>
          ) : (
            <ListGroup>
              {profiles.data.map((profile) => (
                <li key={profile.id}>
                  <Link
                    to="/providers/$providerId/profiles/$profileId"
                    params={{ providerId: provider.id, profileId: profile.id }}
                    className="flex h-10 items-center gap-3 px-3.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    <ProfileStatus status={profile.status} />
                    <span className="min-w-0 flex-1 truncate font-medium">{profile.name}</span>
                    <span className="text-xs text-muted-foreground">{AUTH_LABELS[profile.authType]}</span>
                    <code className="hidden max-w-72 truncate font-mono text-[11px] text-muted-foreground md:block">
                      {absoluteEndpoint(profile.endpoint)}
                    </code>
                    <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ListGroup>
          )}
        </Section>

        <Section title="Server">
          <Rows>
            <Row label="Slug">
              <code className="font-mono text-xs">{provider.slug}</code>
            </Row>
            {transport.type === "http" ? (
              <Row label="URL">
                <code className="font-mono text-xs break-all">{transport.url}</code>
              </Row>
            ) : (
              <>
                <Row label="Command">
                  <code className="font-mono text-xs break-all">{[transport.command, ...transport.args].join(" ")}</code>
                </Row>
                {transport.cwd ? (
                  <Row label="Working directory">
                    <code className="font-mono text-xs break-all">{transport.cwd}</code>
                  </Row>
                ) : null}
              </>
            )}
            <Row label="Created">
              <time dateTime={provider.createdAt}>{new Date(provider.createdAt).toLocaleString()}</time>
            </Row>
          </Rows>
        </Section>
      </PageBody>
    </Page>
  )
}
