// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { api, type Profile, type Provider } from "@/lib/api"
import { ProviderDialog } from "./provider-dialog"

vi.mock("@tanstack/react-router", async (original) => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  useNavigate: () => async () => undefined,
}))

const provider: Provider = {
  id: "provider", name: "linear", slug: "linear", createdAt: "2026-10-27",
  transport: { type: "http", url: "https://mcp.linear.app/mcp" },
}
const profile: Profile = {
  id: "profile", providerId: provider.id, name: "Work", slug: "work", authType: "bearer",
  status: "ready", oauthStatus: "idle", createdAt: "2026-10-27",
  endpoint: "http://127.0.0.1:7433/mcps/linear/work",
}
let client: QueryClient
let root: Root
let container: HTMLDivElement

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  client = new QueryClient()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  vi.spyOn(api, "createProvider").mockResolvedValue({ provider })
  vi.spyOn(api, "createProfile").mockResolvedValue({ profile, accessToken: "downstream" })
  await act(async () => root.render(
    <QueryClientProvider client={client}><ProviderDialog trigger={<button>Add</button>} /></QueryClientProvider>,
  ))
  await click("Add")
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
const input = (id: string) => document.getElementById(id) as HTMLInputElement
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)
  expect(button, `Button ${label}`).toBeDefined()
  await act(async () => button!.click())
  await flush()
}
async function paste(target: Element, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } })
  await act(async () => target.dispatchEvent(event))
  return event
}

it("fills the form from a pasted command and carries its token into the first profile", async () => {
  await paste(
    document.querySelector('[role="dialog"]')!,
    `claude mcp add --transport http linear https://mcp.linear.app/mcp --header "Authorization: Bearer upstream"`,
  )
  expect(input("provider-name").value).toBe("linear")
  expect(input("provider-url").value).toBe("https://mcp.linear.app/mcp")
  expect(document.body.textContent).toContain("Filled from Claude Code")

  await click("Add MCP")
  expect(api.createProvider).toHaveBeenCalledWith({
    name: "linear", slug: "linear", transport: { type: "http", url: "https://mcp.linear.app/mcp" },
  })
  expect(document.body.textContent).toContain("New linear profile")
  expect(input("profile-bearer").value).toBe("upstream")
})

it("leaves single words pasted into a field alone, and undoes a fill", async () => {
  const event = await paste(input("provider-name"), "https://mcp.linear.app/mcp")
  expect(event.defaultPrevented).toBe(false)

  await paste(input("provider-name"), "codex mcp add everything -- npx -y server-everything")
  expect(input("provider-command").value).toBe("npx")
  await click("Undo")
  expect(input("provider-name").value).toBe("")
  expect(input("provider-url")).not.toBeNull()
})
