import { useQuery } from "@tanstack/react-query"
import { Link, Outlet, useNavigate } from "@tanstack/react-router"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { errorMessage, type Provider } from "@/lib/api"
import { AUTH_LABELS } from "@/lib/forms"
import { profilesQuery, providersQuery, useDeleteProvider } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { ConfirmDialog } from "./confirm-dialog"
import { Notice } from "./notice"
import { ProfileDialog } from "./profile-dialog"
import { ProfileStatus } from "./status"

/** Provider header, its profile list, and the selected profile workspace. */
export function ProviderPage({ providerId }: { providerId: string }) {
  const providers = useQuery(providersQuery)
  const provider = providers.data?.find((item) => item.id === providerId)

  if (providers.isPending) return <Notice>Loading</Notice>
  if (providers.isError) return <Notice error>{errorMessage(providers.error)}</Notice>
  if (!provider) {
    return (
      <Notice>
        Provider not found.{" "}
        <Link to="/" className="underline underline-offset-4">
          Back
        </Link>
      </Notice>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ProviderHeader provider={provider} />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <ProfileList provider={provider} />
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function transportSummary(provider: Provider): string {
  const { transport } = provider
  if (transport.type === "http") return transport.url
  return [transport.command, ...transport.args].join(" ")
}

function ProviderHeader({ provider }: { provider: Provider }) {
  const navigate = useNavigate()
  const remove = useDeleteProvider()
  const profiles = useQuery(profilesQuery(provider.id))
  const count = profiles.data?.length

  return (
    <header className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2">
      <h1 className="text-sm font-semibold">{provider.name}</h1>
      <dl className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs">
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">slug</dt>
          <dd>{provider.slug}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">{provider.transport.type}</dt>
          <dd className="truncate" title={transportSummary(provider)}>
            {transportSummary(provider)}
          </dd>
        </div>
        {provider.transport.type === "stdio" && provider.transport.cwd ? (
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">cwd</dt>
            <dd className="truncate">{provider.transport.cwd}</dd>
          </div>
        ) : null}
      </dl>
      <ConfirmDialog
        trigger={
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
            <Trash2Icon /> Delete provider
          </Button>
        }
        title={`Delete ${provider.name}?`}
        description={
          count === undefined
            ? "Its profiles are deleted, their sessions close, and their endpoints stop working."
            : `${count} ${count === 1 ? "profile is" : "profiles are"} deleted, sessions close, and endpoints stop working.`
        }
        confirmLabel="Delete provider"
        pendingLabel="Deleting"
        onConfirm={async () => {
          await remove.mutateAsync(provider.id)
          await navigate({ to: "/" })
        }}
      />
    </header>
  )
}

function ProfileList({ provider }: { provider: Provider }) {
  const profiles = useQuery(profilesQuery(provider.id))

  return (
    <section
      aria-label="Profiles"
      className="flex max-h-64 shrink-0 flex-col border-b lg:max-h-none lg:w-64 lg:border-r lg:border-b-0"
    >
      <div className="flex h-10 items-center justify-between pr-1.5 pl-3">
        <h2 className="text-xs font-medium tracking-wide uppercase">Profiles</h2>
        <ProfileDialog
          provider={provider}
          mode={{ kind: "create" }}
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label="New profile" title="New profile">
              <PlusIcon />
            </Button>
          }
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {profiles.isPending ? (
          <p className="px-3 py-1 text-muted-foreground">Loading</p>
        ) : profiles.isError ? (
          <div className="grid gap-2 px-3 py-1">
            <p role="alert" className="text-destructive">{errorMessage(profiles.error)}</p>
            <Button variant="outline" size="xs" className="justify-self-start" onClick={() => profiles.refetch()}>
              Retry
            </Button>
          </div>
        ) : profiles.data.length === 0 ? (
          <p className="px-3 py-1 text-muted-foreground">No profiles</p>
        ) : (
          <ul>
            {profiles.data.map((profile) => (
              <li key={profile.id}>
                <Link
                  to="/providers/$providerId/profiles/$profileId"
                  params={{ providerId: provider.id, profileId: profile.id }}
                  className={cn(
                    "mx-1 flex h-8 items-center gap-2 rounded-md px-2 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    "data-[status=active]:bg-accent data-[status=active]:font-medium",
                  )}
                >
                  <ProfileStatus status={profile.status} />
                  <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                  <span className="text-xs text-muted-foreground">{AUTH_LABELS[profile.authType]}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
