import { useQuery } from "@tanstack/react-query"
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/sonner"
import { Notice } from "@/components/notice"
import { ProfilePage } from "@/components/profile-page"
import { ProviderDialog } from "@/components/provider-dialog"
import { ProviderPage } from "@/components/provider-page"
import { Sidebar } from "@/components/sidebar"
import { providersQuery } from "@/lib/queries"

// Code-based routes: providers in the sidebar, profiles nested under a provider.

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

const providerIndexRoute = createRoute({
  getParentRoute: () => providerRoute,
  path: "/",
  component: () => <Notice>Select or create a profile.</Notice>,
})

const profileRoute = createRoute({
  getParentRoute: () => providerRoute,
  path: "/profiles/$profileId",
  component: function ProfileRouteComponent() {
    const { providerId, profileId } = profileRoute.useParams()
    return <ProfilePage providerId={providerId} profileId={profileId} />
  },
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  providerRoute.addChildren([providerIndexRoute, profileRoute]),
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
        <p>No providers yet.</p>
        <ProviderDialog
          trigger={
            <Button size="sm">
              <PlusIcon /> Add provider
            </Button>
          }
        />
      </div>
    )
  }
  return <Notice>Select a provider.</Notice>
}
