// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { api, type Profile, type Provider, type Toolkit } from "@/lib/api"
import { ToolkitDialog } from "./toolkit-dialog"
import { ToolkitPage } from "./toolkit-page"

vi.mock("@tanstack/react-router", async (original) => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  useNavigate: () => async () => undefined,
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}))

const linear: Provider = {
  id: "linear", name: "Linear", slug: "linear", createdAt: "2026-10-27",
  transport: { type: "http", url: "https://linear.example/mcp" },
}
const profile = (id: string, name: string): Profile => ({
  id, providerId: linear.id, name, slug: name.toLowerCase(), authType: "none", status: "ready",
  createdAt: "2026-10-27", endpoint: `http://127.0.0.1:7433/mcps/linear/${name.toLowerCase()}`,
})
const acme = profile("acme", "Acme")
const personal = profile("personal", "Personal")
const toolkit: Toolkit = {
  id: "kit", name: "Work", slug: "work", endpoint: "http://127.0.0.1:7433/toolkits/work",
  tokenIssuedAt: "2026-10-27", createdAt: "2026-10-27",
  members: [{ profileId: acme.id, providerId: linear.id, prefix: "linear_" }],
}
let client: QueryClient
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  // Radix checkboxes measure themselves; jsdom has no ResizeObserver.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  vi.spyOn(api, "listProviders").mockResolvedValue({ providers: [linear] })
  vi.spyOn(api, "listProfiles").mockResolvedValue({ profiles: [acme, personal] })
  vi.spyOn(api, "listToolkits").mockResolvedValue({ toolkits: [toolkit] })
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
const render = async (node: React.ReactNode) => {
  await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>))
  await flush()
}
const toggle = async (profileId: string) => {
  const box = document.getElementById(`member-${profileId}`)
  expect(box, profileId).not.toBeNull()
  await act(async () => box!.click())
  await flush()
}

it("creates a toolkit from checked profiles and previews prefixes as the selection changes", async () => {
  vi.spyOn(api, "createToolkit").mockResolvedValue({ toolkit, accessToken: "synthetic-toolkit-token" })
  await render(<ToolkitDialog mode={{ kind: "create" }} trigger={<button>Add toolkit</button>} />)
  await click("Add toolkit")
  await fill("toolkit-name", "Work")
  const dialog = () => document.querySelector('[role="dialog"]')?.textContent ?? ""
  await toggle(acme.id)
  expect(dialog()).toContain("linear_")
  expect(dialog()).not.toContain("linear_acme_")
  await toggle(personal.id)
  expect(dialog()).toContain("linear_acme_")
  expect(dialog()).toContain("linear_personal_")
  await toggle(personal.id)
  await click("Create toolkit")
  expect(api.createToolkit).toHaveBeenCalledWith({ name: "Work", slug: "work", profileIds: [acme.id] })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.body.textContent).not.toContain("synthetic-toolkit-token")
  expect(client.getMutationCache().getAll()).toHaveLength(0)
})

it("lists prefixed tools per member and copies client commands with the toolkit token", async () => {
  vi.spyOn(api, "listTools").mockResolvedValue({
    tools: [{ name: "save_issue", inputSchema: { type: "object" } }],
  })
  vi.spyOn(api, "revealToken").mockResolvedValue({ accessToken: "synthetic-revealed-token" })
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
  await render(<ToolkitPage toolkitId={toolkit.id} />)
  // Profiles load after their providers, so members resolve on a second pass.
  await flush()
  expect(container.textContent).toContain("Linear")
  expect(container.textContent).toContain("linear_*")
  await click("View")
  const sheet = document.querySelector('[role="dialog"]')?.textContent ?? ""
  expect(sheet).toContain("Acme")
  expect(sheet).toContain("linear_save_issue")
  await click("Close")
  await click("Copy Claude Code command")
  expect(api.revealToken).toHaveBeenCalledWith({ kind: "toolkit", id: toolkit.id })
  const copied = writeText.mock.calls[0]?.[0]
  expect(copied).toContain("claude mcp add --transport http work http://127.0.0.1:7433/toolkits/work")
  expect(copied).toContain("Bearer synthetic-revealed-token")
  expect(container.textContent).not.toContain("synthetic-revealed-token")
})
