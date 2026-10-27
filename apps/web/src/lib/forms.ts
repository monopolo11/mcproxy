import { z } from "zod"
import type { AuthInput, AuthType, ProfileInput, ProfilePatch, ProviderInput, TransportType } from "./api"

// Form value shapes, validation, and conversion into API request bodies.
// The daemon stays authoritative; these rules catch mistakes before submit.

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const HEADER_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Headers the proxy controls itself; mirrors the daemon's forbidden list. */
export const RESERVED_HEADER =
  /^(host|connection|content-length|transfer-encoding|upgrade|keep-alive|te|trailer|proxy-.*|mcp-.*|origin|accept|content-type|cookie|set-cookie|x-mcproxy-.*)$/i

/** Upstream auth forms each transport can carry. */
export const AUTH_TYPES_BY_TRANSPORT = {
  http: ["none", "bearer", "headers", "oauth"],
  stdio: ["none", "env"],
} as const satisfies Record<TransportType, readonly AuthType[]>

export const AUTH_LABELS: Record<AuthType, string> = {
  none: "None",
  bearer: "Bearer token",
  headers: "Custom headers",
  env: "Environment variables",
  oauth: "OAuth",
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "")
}

const name = z.string().trim().min(1, "Required").max(160, "160 characters max")
const slug = z
  .string()
  .min(1, "Required")
  .max(80, "80 characters max")
  .regex(SLUG, "Lowercase letters, digits, and single hyphens")

// Provider -------------------------------------------------------------------

export const providerFormSchema = z
  .object({
    name,
    slug,
    transport: z.enum(["http", "stdio"]),
    url: z.string(),
    command: z.string(),
    args: z.string(),
    cwd: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.transport === "http") {
      const url = URL.parse(value.url.trim())
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
        ctx.addIssue({ code: "custom", path: ["url"], message: "Enter an http or https URL" })
      }
    } else if (!value.command.trim()) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "Required" })
    }
  })

export type ProviderFormValues = z.input<typeof providerFormSchema>

export const emptyProviderForm: ProviderFormValues = {
  name: "",
  slug: "",
  transport: "http",
  url: "",
  command: "",
  args: "",
  cwd: "",
}

/** Arguments are entered one per line so values may contain spaces. */
export function parseArgs(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
}

export function toProviderInput(values: ProviderFormValues): ProviderInput {
  const base = { name: values.name.trim(), slug: values.slug }
  if (values.transport === "http") {
    return { ...base, transport: { type: "http", url: values.url.trim() } }
  }
  const cwd = values.cwd.trim()
  return {
    ...base,
    transport: {
      type: "stdio",
      command: values.command.trim(),
      args: parseArgs(values.args),
      ...(cwd ? { cwd } : {}),
    },
  }
}

// Profile --------------------------------------------------------------------

const pairs = z.array(z.object({ key: z.string(), value: z.string() }))
type Pair = z.infer<typeof pairs>[number]

export const profileFormSchema = z.object({
  name,
  slug,
  /** Edit mode only: false keeps the stored upstream credentials untouched. */
  replaceAuth: z.boolean(),
  authType: z.enum(["none", "bearer", "headers", "env", "oauth"]),
  bearerToken: z.string(),
  headers: pairs,
  env: pairs,
  clientId: z.string(),
  clientSecret: z.string(),
  scopes: z.string(),
})

export type ProfileFormValues = z.input<typeof profileFormSchema>

export const emptyProfileForm: ProfileFormValues = {
  name: "",
  slug: "",
  replaceAuth: true,
  authType: "none",
  bearerToken: "",
  headers: [{ key: "", value: "" }],
  env: [{ key: "", value: "" }],
  clientId: "",
  clientSecret: "",
  scopes: "",
}

function checkPairs(
  rows: Pair[],
  field: "headers" | "env",
  ctx: z.RefinementCtx,
) {
  const seen = new Set<string>()
  const filled = rows.filter((row) => row.key.trim() || row.value)
  if (filled.length === 0) {
    ctx.addIssue({ code: "custom", path: [field], message: "Add at least one entry" })
  }
  rows.forEach((row, index) => {
    const key = row.key.trim()
    if (!key && !row.value) return
    const path = [field, index, "key"]
    const normalized = field === "headers" ? key.toLowerCase() : key
    if (!key) {
      ctx.addIssue({ code: "custom", path, message: "Name required" })
    } else if (field === "headers" && !HEADER_NAME.test(key)) {
      ctx.addIssue({ code: "custom", path, message: "Invalid header name" })
    } else if (field === "headers" && RESERVED_HEADER.test(key)) {
      ctx.addIssue({ code: "custom", path, message: `${key} is managed by the proxy` })
    } else if (field === "env" && !ENV_NAME.test(key)) {
      ctx.addIssue({ code: "custom", path, message: "Letters, digits, underscore; no leading digit" })
    } else if (seen.has(normalized)) {
      ctx.addIssue({ code: "custom", path, message: "Duplicate name" })
    }
    seen.add(normalized)
  })
}

/** Profile validation depends on the provider transport. */
export function profileSchemaFor(transport: TransportType) {
  const allowed: readonly AuthType[] = AUTH_TYPES_BY_TRANSPORT[transport]
  return profileFormSchema.superRefine((value, ctx) => {
    if (!value.replaceAuth) return
    if (!allowed.includes(value.authType)) {
      ctx.addIssue({
        code: "custom",
        path: ["authType"],
        message: `${AUTH_LABELS[value.authType]} is not available for ${transport} providers`,
      })
      return
    }
    if (value.authType === "bearer" && !value.bearerToken.trim()) {
      ctx.addIssue({ code: "custom", path: ["bearerToken"], message: "Required" })
    }
    if (value.authType === "headers") checkPairs(value.headers, "headers", ctx)
    if (value.authType === "env") checkPairs(value.env, "env", ctx)
  })
}

function toRecord(rows: Pair[]): Record<string, string> {
  return Object.fromEntries(
    rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]),
  )
}

export function toAuthInput(values: ProfileFormValues): AuthInput {
  switch (values.authType) {
    case "none":
      return { type: "none" }
    case "bearer":
      return { type: "bearer", token: values.bearerToken.trim() }
    case "headers":
      return { type: "headers", headers: toRecord(values.headers) }
    case "env":
      return { type: "env", env: toRecord(values.env) }
    case "oauth": {
      const clientId = values.clientId.trim()
      const clientSecret = values.clientSecret.trim()
      const scopes = values.scopes.split(/[\s,]+/).filter(Boolean)
      return {
        type: "oauth",
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
        ...(scopes.length ? { scopes } : {}),
      }
    }
  }
}

export function toProfileInput(values: ProfileFormValues): ProfileInput {
  return { name: values.name.trim(), slug: values.slug, auth: toAuthInput(values) }
}

export function toProfilePatch(values: ProfileFormValues): ProfilePatch {
  return {
    name: values.name.trim(),
    ...(values.replaceAuth ? { auth: toAuthInput(values) } : {}),
  }
}
