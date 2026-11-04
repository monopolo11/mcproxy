import { useSyncExternalStore } from "react"
import { z } from "zod"
import { CLIENT_IDS } from "./clients"

// UI-only preferences kept in localStorage: which nav sections and MCP
// profile lists are collapsed, and which clients show on profile pages. Nothing here is a secret.

const schema = z.object({
  collapsed: z.array(z.enum(["mcps", "toolkits", "settings"])).default([]),
  collapsedProviders: z.array(z.string()).default([]),
  hiddenClients: z.array(z.enum(CLIENT_IDS)).default([]),
})

export type Prefs = z.infer<typeof schema>
export type NavSectionId = Prefs["collapsed"][number]

const KEY = "mcproxy.prefs"
const listeners = new Set<() => void>()
let cached: Prefs | undefined

function read(): Prefs {
  if (cached) return cached
  let stored: unknown
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? "{}")
  } catch {
    stored = {}
  }
  const parsed = schema.safeParse(stored)
  cached = parsed.success ? parsed.data : schema.parse({})
  return cached
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function updatePrefs(patch: Partial<Prefs>) {
  cached = { ...read(), ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(cached))
  } catch {
    // Private mode or a full store: the change still applies for this session.
  }
  for (const listener of listeners) listener()
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, read, read)
}
