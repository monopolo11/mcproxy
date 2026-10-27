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
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
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
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  )
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
const renderProfilePage = async () => {
  await act(async () => root.render(<QueryClientProvider client={client}><ProfilePage providerId={provider.id} profileId={profile.id} /></QueryClientProvider>))
  await flush()
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
  await renderProfilePage()
  await click("Test connection")
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

it("creates a profile without keeping credentials or the token in the mutation cache", async () => {
  vi.spyOn(api, "createProfile").mockResolvedValue({ profile, accessToken: "synthetic-downstream-token" })
  await act(async () => root.render(<QueryClientProvider client={client}><ProfileDialog provider={provider} mode={{ kind: "create" }} trigger={<button>Add profile</button>} /></QueryClientProvider>))
  await click("Add profile")
  await fill("profile-name", "Work")
  await chooseAuth("bearer")
  await fill("profile-bearer", "synthetic-upstream-secret")
  await click("Create profile")
  expect(api.createProfile).toHaveBeenCalledWith(provider.id, { name: "Work", slug: "work", auth: { type: "bearer", token: "synthetic-upstream-secret" } })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.body.textContent).not.toContain("synthetic-downstream-token")
  expect(client.getMutationCache().getAll()).toHaveLength(0)
})

it("validates on submit only, and clears an error once the field is edited", async () => {
  vi.spyOn(api, "createProfile").mockResolvedValue({ profile, accessToken: "synthetic-downstream-token" })
  await act(async () => root.render(<QueryClientProvider client={client}><ProfileDialog provider={provider} mode={{ kind: "create" }} trigger={<button>Add profile</button>} /></QueryClientProvider>))
  await click("Add profile")
  await fill("profile-name", "Work")
  await fill("profile-name", "")
  expect(document.body.textContent).not.toContain("Required")
  await click("Create profile")
  expect(document.body.textContent).toContain("Required")
  expect(api.createProfile).not.toHaveBeenCalled()
  await fill("profile-name", "Work")
  expect(document.body.textContent).not.toContain("Required")
})

it("shows the rotated token in place and drops it on hide", async () => {
  vi.spyOn(api, "rotateToken").mockResolvedValue({ accessToken: "synthetic-rotated-token" })
  await renderProfilePage()
  await click("Rotate")
  await click("Rotate token")
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(container.textContent).toContain("synthetic-rotated-token")
  await click("Hide token")
  expect(container.textContent).not.toContain("synthetic-rotated-token")
  expect(client.getMutationCache().getAll()).toHaveLength(0)
})

const tools = [
  { name: "list_issues", description: "Find issues", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { limit: { type: "integer" } } } },
  { name: "delete_comment", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
]

it("loads tools on demand into a filterable sheet", async () => {
  vi.spyOn(api, "listTools").mockResolvedValue({ tools })
  await renderProfilePage()
  expect(api.listTools).not.toHaveBeenCalled()
  await click("View")
  const sheet = document.querySelector('[role="dialog"]')
  expect(sheet?.textContent).toContain("list_issues")
  expect(container.textContent).toContain("2 tools")
  await fill("tools-filter", "delete")
  expect(sheet!.textContent).not.toContain("list_issues")
  await click("delete_comment")
  expect(sheet!.textContent).toContain("id *string")
})

it("reuses the tools from a passing test instead of reconnecting", async () => {
  vi.spyOn(api, "testProfile").mockResolvedValue({ ok: true, message: "Upstream initialized", tools })
  vi.spyOn(api, "listTools").mockResolvedValue({ tools: [] })
  await renderProfilePage()
  await click("Test connection")
  expect(container.textContent).toContain("2 tools")
  await click("View")
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("list_issues")
  expect(api.listTools).not.toHaveBeenCalled()
})

it("copies client commands with the real token while it stays masked, and reveals on show", async () => {
  vi.spyOn(api, "revealToken").mockResolvedValue({ accessToken: "synthetic-revealed-token" })
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
  await renderProfilePage()
  expect(container.textContent).not.toContain("synthetic-revealed-token")
  await click("Copy Claude Code command")
  expect(writeText).toHaveBeenCalledTimes(1)
  const copied = writeText.mock.calls[0]?.[0]
  expect(copied).toContain("claude mcp add --transport http fixture-work http://127.0.0.1:7433/mcps/fixture/work")
  expect(copied).toContain("Bearer synthetic-revealed-token")
  expect(container.textContent).not.toContain("synthetic-revealed-token")
  await click("Show token")
  expect(api.revealToken).toHaveBeenCalledTimes(1)
  expect(container.querySelectorAll("code, pre")).toSatisfy((nodes: NodeListOf<Element>) =>
    [...nodes].filter((node) => node.textContent?.includes("synthetic-revealed-token")).length >= 2,
  )
  expect(client.getMutationCache().getAll()).toHaveLength(0)
})
