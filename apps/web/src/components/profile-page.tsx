import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { PencilIcon, PlugZapIcon, RotateCwIcon, Trash2Icon } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { absoluteEndpoint, errorMessage, type Profile, type Provider } from "@/lib/api"
import { AUTH_LABELS } from "@/lib/forms"
import {
  profilesQuery,
  providersQuery,
  useDeleteProfile,
  useRotateToken,
  useTestProfile,
} from "@/lib/queries"
import { ConfirmDialog } from "./confirm-dialog"
import { CopyButton } from "./copy-button"
import { Notice } from "./notice"
import { OAuthControl } from "./oauth-control"
import { ProfileDialog } from "./profile-dialog"
import { ProfileStatus } from "./status"
import { TokenReveal } from "./token-reveal"

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
  const endpoint = absoluteEndpoint(profile.endpoint)

  return (
    <div className="grid gap-6 p-4 lg:p-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="text-base font-semibold">{profile.name}</h2>
        <span className="text-sm">
          <ProfileStatus status={profile.status} showLabel />
        </span>
        <div className="ml-auto flex flex-wrap gap-1">
          <Button variant="outline" size="sm" onClick={() => test.mutate(profile)} disabled={test.isPending}>
            <PlugZapIcon /> {test.isPending ? "Testing" : "Test"}
          </Button>
          <ProfileDialog
            provider={provider}
            mode={{ kind: "edit", profile }}
            onSaved={test.reset}
            trigger={
              <Button variant="ghost" size="sm">
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
        </div>
      </header>

      {profile.lastError && profile.status === "error" ? (
        <p role="alert" className="border-l-2 border-destructive pl-3 text-sm text-destructive">
          {profile.lastError}
        </p>
      ) : null}

      <TestOutcome test={test} />

      <Section title="Downstream">
        <Row label="Endpoint">
          <div className="flex min-w-0 items-center gap-1">
            <code className="min-w-0 truncate font-mono text-xs" title={endpoint}>
              {endpoint}
            </code>
            <CopyButton value={endpoint} label="Copy endpoint" />
          </div>
        </Row>
        <Row label="Access token">
          <AccessToken profile={profile} endpoint={endpoint} onRotated={test.reset} />
        </Row>
      </Section>

      <Section title="Upstream">
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
        {profile.authType === "oauth" ? (
          <Row label="Authorization">
            <OAuthControl profile={profile} onConnectionChange={test.reset} />
          </Row>
        ) : null}
      </Section>

      <Section title="Details">
        <Row label="Slug">
          <code className="font-mono text-xs">{profile.slug}</code>
        </Row>
        <Row label="Created">
          <time dateTime={profile.createdAt}>{new Date(profile.createdAt).toLocaleString()}</time>
        </Row>
      </Section>
    </div>
  )
}

function TestOutcome({ test }: { test: ReturnType<typeof useTestProfile> }) {
  if (test.isError) {
    return (
      <p role="alert" className="border-l-2 border-destructive pl-3 text-sm text-destructive">
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
      className={`grid gap-1 border-l-2 pl-3 text-sm ${ok ? "border-success" : "border-destructive text-destructive"}`}
    >
      <p>{message}</p>
      {ok && names.length > 0 ? (
        <p className="font-mono text-xs">capabilities: {names.join(", ")}</p>
      ) : null}
    </div>
  )
}

/** Downstream token: hashed at rest, so only rotation can produce a visible value. */
function AccessToken({ profile, endpoint, onRotated }: { profile: Profile; endpoint: string; onRotated: () => void }) {
  const rotate = useRotateToken()
  const [token, setToken] = useState<string>()

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs"><span aria-hidden="true">••••••••••••</span><span className="sr-only">Hidden</span></span>
      <ConfirmDialog
        trigger={
          <Button variant="ghost" size="xs">
            <RotateCwIcon /> Rotate
          </Button>
        }
        title={`Rotate token for ${profile.name}?`}
        description="The current token stops working immediately and connected clients are disconnected. Update clients with the new token."
        confirmLabel="Rotate token"
        pendingLabel="Rotating"
        onConfirm={async () => {
          const result = await rotate.mutateAsync(profile.id)
          setToken(result.accessToken)
          rotate.reset()
          onRotated()
        }}
      />
      <Dialog open={token !== undefined} onOpenChange={(open) => !open && setToken(undefined)}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-xl" onInteractOutside={(event) => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>New access token</DialogTitle>
          </DialogHeader>
          {token ? <TokenReveal token={token} endpoint={endpoint} /> : null}
          <DialogFooter>
            <Button onClick={() => setToken(undefined)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-2">
      <h3 className="border-b pb-1.5 text-xs font-medium tracking-wide uppercase">{title}</h3>
      <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-[8rem_1fr]">{children}</dl>
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground sm:leading-8">{label}</dt>
      <dd className="flex min-h-8 min-w-0 items-center">{children}</dd>
    </>
  )
}
