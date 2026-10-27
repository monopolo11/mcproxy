import { useQuery } from "@tanstack/react-query"
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/sonner"
import { Notice } from "@/components/notice"
import { ProfilePage } from "@/components/profile-page"
import { ProviderDialog } from "@/components/provider-dialog"
import { ProviderPage } from "@/components/provider-page"
import { ClientSettings, DaemonSettings } from "@/components/settings-page"
import { Sidebar } from "@/components/sidebar"
import { providersQuery } from "@/lib/queries"

// Code-based routes. The sidebar lists every MCP with its profiles, so pages
// are flat: an MCP, a profile, or a settings section.

const rootRoute = createRootRoute({
  component: () => (
    <>
      <div className="flex h-full flex-col md:flex-row">
        <Sidebar />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
      </div>
      <Toaster position="bottom-right" />
    </>
  ),
  notFoundComponent: () => <Notice>Page not found.</Notice>,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
})

const providerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/providers/$providerId",
  component: function ProviderRouteComponent() {
    const { providerId } = providerRoute.useParams()
    return <ProviderPage providerId={providerId} />
  },
})

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/providers/$providerId/profiles/$profileId",
  component: function ProfileRouteComponent() {
    const { providerId, profileId } = profileRoute.useParams()
    return <ProfilePage providerId={providerId} profileId={profileId} />
  },
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
})

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/settings/daemon" })
  },
})

const daemonSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/daemon",
  component: DaemonSettings,
})

const clientSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/clients",
  component: ClientSettings,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  providerRoute,
  profileRoute,
  settingsRoute.addChildren([settingsIndexRoute, daemonSettingsRoute, clientSettingsRoute]),
])

export const router = createRouter({ routeTree, defaultPreload: "intent" })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

function Home() {
  const providers = useQuery(providersQuery)
  if (providers.isSuccess && providers.data.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
        <p className="text-muted-foreground">No MCPs yet.</p>
        <ProviderDialog
          trigger={
            <Button size="sm">
              <PlusIcon /> Add MCP
            </Button>
          }
        />
      </div>
    )
  }
  return <Notice>Select an MCP.</Notice>
}
