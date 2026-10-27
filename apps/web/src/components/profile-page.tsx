import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { PencilIcon, PlugZapIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { absoluteEndpoint, errorMessage, type Profile, type Provider } from "@/lib/api"
import { clientServerName } from "@/lib/clients"
import { AUTH_LABELS } from "@/lib/forms"
import { profilesQuery, providersQuery, useDeleteProfile, useTestProfile } from "@/lib/queries"
import { AccessTokenField, useAccessToken } from "./access-token"
import { ClientCommands } from "./client-commands"
import { ConfirmDialog } from "./confirm-dialog"
import { CopyButton } from "./copy-button"
import { Notice } from "./notice"
import { OAuthControl } from "./oauth-control"
import { Page, PageBody, PageHeader, Row, Rows, Section } from "./page"
import { ProfileDialog } from "./profile-dialog"
import { ProfileStatus } from "./status"
import { ToolsSheet } from "./tools-sheet"

/** Detail workspace for one profile. */
export function ProfilePage({ providerId, profileId }: { providerId: string; profileId: string }) {
  const providers = useQuery(providersQuery)
  const profiles = useQuery(profilesQuery(providerId))
  const provider = providers.data?.find((item) => item.id === providerId)
  const profile = profiles.data?.find((item) => item.id === profileId)

  if (profiles.isPending || providers.isPending) return <Notice>Loading</Notice>
  if (profiles.isError) return <Notice error>{errorMessage(profiles.error)}</Notice>
  if (!provider || !profile) {
    return (
      <Notice>
        Profile not found.{" "}
        <Link to="/providers/$providerId" params={{ providerId }} className="underline underline-offset-4">
          Back
        </Link>
      </Notice>
    )
  }
  // Keyed so transient state (test result, revealed token) never crosses profiles.
  return <ProfileDetail key={profile.id} provider={provider} profile={profile} />
}

function ProfileDetail({ provider, profile }: { provider: Provider; profile: Profile }) {
  const navigate = useNavigate()
  const remove = useDeleteProfile()
  const test = useTestProfile()
  const token = useAccessToken({ kind: "profile", id: profile.id, name: profile.name })
  const endpoint = absoluteEndpoint(profile.endpoint)

  return (
    <Page>
      <PageHeader
        crumbs={[
          <Link key="provider" to="/providers/$providerId" params={{ providerId: provider.id }} className="hover:text-foreground">
            {provider.name}
          </Link>,
          profile.name,
        ]}
        status={
          <span className="text-xs text-muted-foreground">
            <ProfileStatus status={profile.status} showLabel />
          </span>
        }
        actions={
          <>
            <Button size="sm" onClick={() => test.mutate(profile)} disabled={test.isPending}>
              <PlugZapIcon /> {test.isPending ? "Testing" : "Test connection"}
            </Button>
            <ProfileDialog
              provider={provider}
              mode={{ kind: "edit", profile }}
              onSaved={test.reset}
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
              title={`Delete ${profile.name}?`}
              description="Its endpoint and access token stop working, open sessions close, and stored upstream credentials are removed."
              confirmLabel="Delete profile"
              pendingLabel="Deleting"
              onConfirm={async () => {
                await remove.mutateAsync(profile)
                await navigate({ to: "/providers/$providerId", params: { providerId: provider.id } })
              }}
            />
          </>
        }
      />
      <PageBody>
        {profile.lastError && profile.status === "error" ? (
          <p role="alert" className="border-l-2 border-destructive pl-3 text-destructive">
            {profile.lastError}
          </p>
        ) : null}

        <TestOutcome test={test} />

        <Section title="Downstream">
          <Rows>
            <Row label="Endpoint">
              <code className="min-w-0 truncate font-mono text-xs" title={endpoint}>
                {endpoint}
              </code>
              <CopyButton value={endpoint} label="Copy endpoint" />
            </Row>
            <Row label="Access token">
              <AccessTokenField owner={{ kind: "profile", id: profile.id, name: profile.name }} token={token} onRotated={test.reset} />
            </Row>
            {profile.tokenIssuedAt ? (
              <Row label="Token issued">
                <time dateTime={profile.tokenIssuedAt}>{new Date(profile.tokenIssuedAt).toLocaleString()}</time>
              </Row>
            ) : null}
          </Rows>
        </Section>

        <ClientCommands name={clientServerName(provider.slug, profile.slug)} endpoint={endpoint} token={token} />

        <Section title="Upstream">
          <Rows>
            <Row label="Server">
              <code className="font-mono text-xs break-all">
                {provider.transport.type === "http"
                  ? provider.transport.url
                  : [provider.transport.command, ...provider.transport.args].join(" ")}
              </code>
            </Row>
            <Row label="Credentials">
              <span>{AUTH_LABELS[profile.authType]}</span>
            </Row>
            <Row label="Tools">
              <ToolsSheet profileId={profile.id} />
            </Row>
            {profile.authType === "oauth" ? (
              <Row label="Authorization">
                <OAuthControl profile={profile} onConnectionChange={test.reset} />
              </Row>
            ) : null}
          </Rows>
        </Section>

        <Section title="Details">
          <Rows>
            <Row label="Slug">
              <code className="font-mono text-xs">{profile.slug}</code>
            </Row>
            <Row label="Created">
              <time dateTime={profile.createdAt}>{new Date(profile.createdAt).toLocaleString()}</time>
            </Row>
          </Rows>
        </Section>
      </PageBody>
    </Page>
  )
}

function TestOutcome({ test }: { test: ReturnType<typeof useTestProfile> }) {
  if (test.isError) {
    return (
      <p role="alert" className="border-l-2 border-destructive pl-3 text-destructive">
        Test failed: {errorMessage(test.error)}
      </p>
    )
  }
  if (!test.data) return null
  const { ok, message, capabilities } = test.data
  const names = capabilities ? Object.keys(capabilities) : []
  return (
    <div
      role="status"
      className={`grid gap-0.5 border-l-2 pl-3 ${ok ? "border-success" : "border-destructive text-destructive"}`}
    >
      <p>{message}</p>
      {ok && names.length > 0 ? (
        <p className="text-xs text-muted-foreground">Capabilities: {names.join(", ")}</p>
      ) : null}
    </div>
  )
}
