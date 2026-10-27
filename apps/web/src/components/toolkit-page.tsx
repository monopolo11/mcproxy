import { useQueries, useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { ChevronRightIcon, PencilIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { absoluteEndpoint, errorMessage, type Profile, type Provider, type Toolkit } from "@/lib/api"
import { profilesQuery, providersQuery, toolkitsQuery, useDeleteToolkit } from "@/lib/queries"
import { AccessTokenField, useAccessToken } from "./access-token"
import { ClientCommands } from "./client-commands"
import { ConfirmDialog } from "./confirm-dialog"
import { CopyButton } from "./copy-button"
import { Notice } from "./notice"
import { ListGroup, Page, PageBody, PageHeader, Row, Rows, Section } from "./page"
import { ProfileStatus } from "./status"
import { ToolkitDialog } from "./toolkit-dialog"
import { ToolsSheet } from "./tools-sheet"

/** Detail workspace for one toolkit. */
export function ToolkitPage({ toolkitId }: { toolkitId: string }) {
  const toolkits = useQuery(toolkitsQuery)
  const toolkit = toolkits.data?.find((item) => item.id === toolkitId)

  if (toolkits.isPending) return <Notice>Loading</Notice>
  if (toolkits.isError) return <Notice error>{errorMessage(toolkits.error)}</Notice>
  if (!toolkit) {
    return (
      <Notice>
        Toolkit not found.{" "}
        <Link to="/" className="underline underline-offset-4">
          Back
        </Link>
      </Notice>
    )
  }
  // Keyed so transient state (revealed token, open sheet) never crosses toolkits.
  return <ToolkitDetail key={toolkit.id} toolkit={toolkit} />
}

/** A member resolved against the provider and profile lists. */
type Resolved = { profileId: string; prefix: string; provider?: Provider; profile?: Profile }

function ToolkitDetail({ toolkit }: { toolkit: Toolkit }) {
  const navigate = useNavigate()
  const remove = useDeleteToolkit()
  const owner = { kind: "toolkit", id: toolkit.id, name: toolkit.name } as const
  const token = useAccessToken(owner)
  const endpoint = absoluteEndpoint(toolkit.endpoint)
  const providers = useQuery(providersQuery)
  const providerIds = [...new Set(toolkit.members.map((member) => member.providerId))]
  const profiles = useQueries({ queries: providerIds.map((id) => profilesQuery(id)) })
  const members: Resolved[] = toolkit.members.map((member) => ({
    ...member,
    provider: providers.data?.find((item) => item.id === member.providerId),
    profile: profiles[providerIds.indexOf(member.providerId)]?.data?.find((item) => item.id === member.profileId),
  }))

  return (
    <Page>
      <PageHeader
        crumbs={["Toolkits", toolkit.name]}
        status={
          <span className="text-xs text-muted-foreground">
            {toolkit.members.length} {toolkit.members.length === 1 ? "profile" : "profiles"}
          </span>
        }
        actions={
          <>
            <ToolkitDialog
              mode={{ kind: "edit", toolkit }}
              trigger={
                <Button variant="outline" size="sm">
                  <PencilIcon /> Edit
                </Button>
              }
            />
            <ConfirmDialog
              trigger={
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                  <Trash2Icon /> Delete
                </Button>
              }
              title={`Delete ${toolkit.name}?`}
              description="Its endpoint and access token stop working and open sessions close. Member profiles are kept."
              confirmLabel="Delete toolkit"
              pendingLabel="Deleting"
              onConfirm={async () => {
                await remove.mutateAsync(toolkit)
                await navigate({ to: "/" })
              }}
            />
          </>
        }
      />
      <PageBody>
        <Section title="Downstream">
          <Rows>
            <Row label="Endpoint">
              <code className="min-w-0 truncate font-mono text-xs" title={endpoint}>
                {endpoint}
              </code>
              <CopyButton value={endpoint} label="Copy endpoint" />
            </Row>
            <Row label="Access token">
              <AccessTokenField owner={owner} token={token} />
            </Row>
            {members.length > 0 ? (
              <Row label="Tools">
                <ToolsSheet
                  sources={members.map((member) => ({
                    profileId: member.profileId,
                    prefix: member.prefix,
                    label: <MemberLabel member={member} />,
                  }))}
                />
              </Row>
            ) : null}
            <Row label="Token issued">
              <time dateTime={toolkit.tokenIssuedAt}>{new Date(toolkit.tokenIssuedAt).toLocaleString()}</time>
            </Row>
          </Rows>
        </Section>

        <ClientCommands name={toolkit.slug} endpoint={endpoint} token={token} />

        <Section title="Profiles">
          {members.length === 0 ? (
            <div className="flex items-center gap-3 rounded-lg border px-3.5 py-3">
              <p className="text-muted-foreground">No profiles yet. The endpoint exposes no tools until some are added.</p>
              <ToolkitDialog
                mode={{ kind: "edit", toolkit }}
                trigger={
                  <Button variant="outline" size="sm">
                    <PencilIcon /> Choose profiles
                  </Button>
                }
              />
            </div>
          ) : (
            <ListGroup>
              {members.map((member) => (
                <li key={member.profileId}>
                  <MemberRow member={member} />
                </li>
              ))}
            </ListGroup>
          )}
        </Section>

        <Section title="Details">
          <Rows>
            <Row label="Slug">
              <code className="font-mono text-xs">{toolkit.slug}</code>
            </Row>
            <Row label="Created">
              <time dateTime={toolkit.createdAt}>{new Date(toolkit.createdAt).toLocaleString()}</time>
            </Row>
          </Rows>
        </Section>
      </PageBody>
    </Page>
  )
}

/** Status dot and "Provider / Profile" for a member. */
function MemberLabel({ member: { provider, profile } }: { member: Resolved }) {
  return (
    <>
      {profile ? <ProfileStatus status={profile.status} /> : null}
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground">{provider?.name ?? "Unknown"}</span>
        <span aria-hidden className="mx-1.5 text-muted-foreground">
          /
        </span>
        <span className="font-medium">{profile?.name ?? "Unknown"}</span>
      </span>
    </>
  )
}

function MemberRow({ member }: { member: Resolved }) {
  const { provider, profile } = member
  const body = (
    <>
      <MemberLabel member={member} />
      <code className="font-mono text-[11px] text-muted-foreground">{member.prefix}*</code>
    </>
  )
  const className =
    "flex h-10 items-center gap-3 px-3.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
  if (!provider || !profile) return <div className={className}>{body}</div>
  return (
    <Link
      to="/providers/$providerId/profiles/$profileId"
      params={{ providerId: provider.id, profileId: profile.id }}
      className={className}
    >
      {body}
      <ChevronRightIcon className="size-3.5 text-muted-foreground" />
    </Link>
  )
}
