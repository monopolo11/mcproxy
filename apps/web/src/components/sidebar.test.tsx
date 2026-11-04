// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { api, type Profile, type Provider } from "@/lib/api"
import { Sidebar } from "./sidebar"

vi.mock("@tanstack/react-router", async (original) => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}))

const linear: Provider = {
  id: "linear", name: "Linear", slug: "linear", createdAt: "2026-10-27",
  transport: { type: "http", url: "https://linear.example/mcp" },
}
const beruna: Profile = {
  id: "beruna", providerId: linear.id, name: "Beruna", slug: "beruna", authType: "oauth", status: "ready",
  createdAt: "2026-10-27", endpoint: "http://127.0.0.1:7433/mcps/linear/beruna",
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  localStorage.clear()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  vi.spyOn(api, "listProviders").mockResolvedValue({ providers: [linear] })
  vi.spyOn(api, "listProfiles").mockResolvedValue({ profiles: [beruna] })
  vi.spyOn(api, "listToolkits").mockResolvedValue({ toolkits: [] })
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it("collapses and expands an MCP's profiles with its chevron", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={client}><Sidebar /></QueryClientProvider>)
    // Providers load first, then each provider's profiles.
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  expect(container.textContent).toContain("Beruna")

  const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-label$="Linear profiles"]')!
  await act(async () => toggle().click())
  expect(container.textContent).not.toContain("Beruna")
  expect(toggle().getAttribute("aria-label")).toBe("Expand Linear profiles")

  await act(async () => toggle().click())
  expect(container.textContent).toContain("Beruna")
})
