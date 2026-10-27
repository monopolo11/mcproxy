// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { api, type Profile, type Provider } from "@/lib/api"
import { profilesQuery } from "@/lib/queries"
import { OAuthControl } from "./oauth-control"
import { ProfileDialog } from "./profile-dialog"
import { ProfilePage } from "./profile-page"

vi.mock("@tanstack/react-router", async (original) => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  useNavigate: () => async () => undefined,
}))

const provider: Provider = {
  id: "provider", name: "Fixture", slug: "fixture", createdAt: "2026-10-27",
  transport: { type: "http", url: "https://fixture.example/mcp" },
}
const profile: Profile = {
  id: "profile", providerId: provider.id, name: "Work", slug: "work", authType: "oauth",
  status: "ready", oauthStatus: "idle", createdAt: "2026-10-27",
  endpoint: "http://127.0.0.1:7433/mcps/fixture/work",
}
let client: QueryClient
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  vi.spyOn(window, "open").mockReturnValue(null)
  vi.spyOn(api, "listProviders").mockResolvedValue({ providers: [provider] })
  vi.spyOn(api, "listProfiles").mockResolvedValue({ profiles: [profile] })
})
afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)
  expect(button, `Button ${label}`).toBeDefined()
  await act(async () => button!.click())
  await flush()
}
async function fill(id: string, value: string) {
  const input = document.getElementById(id)
  expect(input).toBeInstanceOf(HTMLInputElement)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input!.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
async function chooseAuth(value: string) {
  const select = document.querySelector("select")
  expect(select).not.toBeNull()
  await act(async () => {
    select!.value = value
    select!.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

it("keeps reconnect pending while ready and displays denial or successful completion", async () => {
  let current = profile
  vi.mocked(api.listProfiles).mockImplementation(async () => ({ profiles: [current] }))
  vi.spyOn(api, "startOAuth").mockImplementation(async () => {
    current = { ...profile, oauthStatus: "pending" }
    return { authorizationUrl: "https://fixture.example/authorize" }
  })
  const authorized = vi.spyOn(toast, "success")
  function Harness() {
    const query = useQuery(profilesQuery(provider.id))
    return query.data?.[0] ? <OAuthControl profile={query.data[0]} /> : null
  }
  await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>))
  await flush()
  await click("Reconnect")
  expect(container.textContent).toContain("Waiting for authorization")
  expect(authorized).not.toHaveBeenCalled()
  current = { ...profile, oauthStatus: "error", lastError: "Authorization was denied. Connect again to retry" }
  await act(async () => { client.setQueryData(profilesQuery(provider.id).queryKey, [current]) })
  await flush()
  expect(container.textContent).not.toContain("Waiting for authorization")
  expect(container.textContent).toContain("Authorization was denied")
  await click("Reconnect")
  current = profile
  await act(async () => { client.setQueryData(profilesQuery(provider.id).queryKey, [current]) })
  await flush()
  expect(container.textContent).not.toContain("Waiting for authorization")
  expect(authorized).toHaveBeenCalledWith("Work authorized")
})

it("keeps the stored auth label when cancelling replacement and clears stale connection tests after saving", async () => {
  const stored: Profile = { ...profile, authType: "headers", oauthStatus: undefined }
  vi.mocked(api.listProfiles).mockResolvedValue({ profiles: [stored] })
  vi.spyOn(api, "testProfile").mockResolvedValue({ ok: true, message: "Upstream initialized" })
  vi.spyOn(api, "updateProfile").mockResolvedValue({ profile: { ...stored, authType: "none" } })
  await act(async () => root.render(<QueryClientProvider client={client}><ProfilePage providerId={provider.id} profileId={profile.id} /></QueryClientProvider>))
  await flush()
  await click("Test")
  expect(container.textContent).toContain("Upstream initialized")
  await click("Edit")
  await click("Replace")
  await chooseAuth("none")
  await click("Keep current")
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Custom headers. Stored values stay hidden")
  await click("Replace")
  await click("Save")
  expect(api.updateProfile).toHaveBeenCalledWith(profile.id, { name: "Work", auth: { type: "none" } })
  expect(container.textContent).not.toContain("Upstream initialized")
})

it("discards upstream credentials and generated tokens from mutation cache after creation", async () => {
  vi.spyOn(api, "createProfile").mockResolvedValue({ profile, accessToken: "synthetic-downstream-token" })
  await act(async () => root.render(<QueryClientProvider client={client}><ProfileDialog provider={provider} mode={{ kind: "create" }} trigger={<button>Add profile</button>} /></QueryClientProvider>))
  await click("Add profile")
  await fill("profile-name", "Work")
  await chooseAuth("bearer")
  await fill("profile-bearer", "synthetic-upstream-secret")
  await click("Create profile")
  expect(api.createProfile).toHaveBeenCalledWith(provider.id, { name: "Work", slug: "work", auth: { type: "bearer", token: "synthetic-upstream-secret" } })
  expect(document.body.textContent).toContain("synthetic-downstream-token")
  await click("Done")
  expect(document.body.textContent).not.toContain("synthetic-downstream-token")
  expect(client.getMutationCache().getAll()).toHaveLength(0)
})

it("drops the rotated token from mutation cache while the profile stays mounted", async () => {
  vi.spyOn(api, "rotateToken").mockResolvedValue({ accessToken: "synthetic-rotated-token" })
  await act(async () => root.render(<QueryClientProvider client={client}><ProfilePage providerId={provider.id} profileId={profile.id} /></QueryClientProvider>))
  await flush()
  await click("Rotate")
  await click("Rotate token")
  expect(document.body.textContent).toContain("synthetic-rotated-token")
  await click("Done")
  expect(container.textContent).toContain("Work")
  expect(document.body.textContent).not.toContain("synthetic-rotated-token")
  expect(client.getMutationCache().getAll()).toHaveLength(0)
})
