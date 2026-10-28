// Typed client for the daemon management API (docs/implementation-contract.md).
// Every request is same-origin and carries the CSRF marker header.

export type Transport =
  | { type: "http"; url: string }
  | { type: "stdio"; command: string; args: string[]; cwd?: string }

export type TransportType = Transport["type"]

export type ProviderInput = { name: string; slug: string; transport: Transport }
export type Provider = ProviderInput & { id: string; createdAt: string }

export type AuthInput =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "headers"; headers: Record<string, string> }
  | { type: "env"; env: Record<string, string> }
  | { type: "oauth"; clientId?: string; clientSecret?: string; scopes?: string[] }

export type AuthType = AuthInput["type"]

export type ProfileInput = { name: string; slug: string; auth: AuthInput }
export type ProfilePatch = { name?: string; auth?: AuthInput }

export type Profile = {
  id: string
  providerId: string
  name: string
  slug: string
  authType: AuthType
  status: "ready" | "needs_auth" | "error"
  oauthStatus?: "idle" | "pending" | "error"
  endpoint: string
  createdAt: string
  /** Absent for profiles created before tokens were stored for reveal. */
  tokenIssuedAt?: string
  lastError?: string
}

export type Health = { status: "ok"; version: string; platform: string }

export const UPDATE_CHANNELS = ["stable", "nightly"] as const
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

/** The daemon's release, its channel and the last update check. */
export type UpdateStatus = {
  /** Absent for a development build. */
  version?: string
  commit?: string
  /** Tracked files differ from the checked-out commit. */
  modified: boolean
  /** Development builds other than a clean main are never offered updates. */
  updatable: boolean
  channel: UpdateChannel
  available?: { version: string; url: string }
  checkedAt?: string
  checkError?: string
  applying: boolean
  applyError?: string
}

/** Several profiles behind one endpoint; tools carry each member's prefix. */
export type Toolkit = {
  id: string
  name: string
  slug: string
  endpoint: string
  tokenIssuedAt: string
  createdAt: string
  members: ToolkitMember[]
}
export type ToolkitMember = { profileId: string; providerId: string; prefix: string }
export type ToolkitInput = { name: string; slug: string; profileIds: string[] }
export type ToolkitPatch = { name?: string; profileIds?: string[] }

/** Profiles and toolkits both issue a downstream token through the same routes. */
export type TokenOwner = { kind: "profile" | "toolkit"; id: string }

/** JSON Schema object as the upstream sent it; unvalidated, so read it defensively. */
export type JsonSchema = { [key: string]: unknown }

/** A tool as advertised by the upstream's tools/list. */
export type Tool = {
  name: string
  title?: string
  description?: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
}

export type TestResult = {
  ok: boolean
  message: string
  capabilities?: Record<string, unknown>
  /** Present on success; empty when the upstream has no tools capability. */
  tools?: Tool[]
}

/** Failure from the daemon, or from reaching it at all (`status` 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

function isErrorBody(body: unknown): body is { error: { code: string; message: string } } {
  if (typeof body !== "object" || body === null || !("error" in body)) return false
  const { error } = body
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  )
}

/**
 * Sends one management request. The response type is declared per endpoint
 * below; `undefined` covers 204 responses.
 */
export async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const headers: Record<string, string> = { "X-Mcproxy-Request": "1" }
  if (body !== undefined) headers["Content-Type"] = "application/json"

  let response: Response
  try {
    response = await fetcher(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    })
  } catch {
    throw new ApiError(0, "unreachable", "Cannot reach the mcproxy daemon.")
  }

  if (response.status === 204) return undefined as T

  const parsed: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    if (isErrorBody(parsed)) {
      throw new ApiError(response.status, parsed.error.code, parsed.error.message)
    }
    // Vite's dev proxy answers 5xx without a JSON body when the daemon is down.
    throw response.status >= 500
      ? new ApiError(response.status, "unreachable", "Cannot reach the mcproxy daemon.")
      : new ApiError(response.status, "http_error", `Request failed with HTTP ${response.status}.`)
  }
  if (parsed === undefined) {
    throw new ApiError(response.status, "invalid_response", "The daemon returned an unreadable response.")
  }
  return parsed as T
}

const id = encodeURIComponent

export const api = {
  health: () => request<Health>("GET", "/api/health"),

  update: () => request<UpdateStatus>("GET", "/api/update"),
  setUpdateChannel: (channel: UpdateChannel) =>
    request<UpdateStatus>("PATCH", "/api/update", { channel }),
  checkUpdate: () => request<UpdateStatus>("POST", "/api/update/check"),
  /** Returns at once; the daemon builds, then restarts itself. */
  applyUpdate: () => request<UpdateStatus>("POST", "/api/update/apply"),

  listProviders: () => request<{ providers: Provider[] }>("GET", "/api/providers"),
  createProvider: (input: ProviderInput) =>
    request<{ provider: Provider }>("POST", "/api/providers", input),
  deleteProvider: (providerId: string) =>
    request<undefined>("DELETE", `/api/providers/${id(providerId)}`),

  listProfiles: (providerId: string) =>
    request<{ profiles: Profile[] }>("GET", `/api/providers/${id(providerId)}/profiles`),
  createProfile: (providerId: string, input: ProfileInput) =>
    request<{ profile: Profile; accessToken: string }>(
      "POST",
      `/api/providers/${id(providerId)}/profiles`,
      input,
    ),
  updateProfile: (profileId: string, patch: ProfilePatch) =>
    request<{ profile: Profile }>("PATCH", `/api/profiles/${id(profileId)}`, patch),
  deleteProfile: (profileId: string) =>
    request<undefined>("DELETE", `/api/profiles/${id(profileId)}`),
  rotateToken: (owner: TokenOwner) =>
    request<{ accessToken: string }>("POST", `/api/${owner.kind}s/${id(owner.id)}/token`),
  revealToken: (owner: TokenOwner) =>
    request<{ accessToken: string }>("GET", `/api/${owner.kind}s/${id(owner.id)}/token`),
  startOAuth: (profileId: string) =>
    request<{ authorizationUrl: string }>("POST", `/api/profiles/${id(profileId)}/oauth/start`),
  testProfile: (profileId: string) =>
    request<TestResult>("POST", `/api/profiles/${id(profileId)}/test`),
  /** Connects upstream to list tools; slow, so callers fetch on demand. */
  listTools: (profileId: string) =>
    request<{ tools: Tool[] }>("GET", `/api/profiles/${id(profileId)}/tools`),

  listToolkits: () => request<{ toolkits: Toolkit[] }>("GET", "/api/toolkits"),
  createToolkit: (input: ToolkitInput) =>
    request<{ toolkit: Toolkit; accessToken: string }>("POST", "/api/toolkits", input),
  updateToolkit: (toolkitId: string, patch: ToolkitPatch) =>
    request<{ toolkit: Toolkit }>("PATCH", `/api/toolkits/${id(toolkitId)}`, patch),
  deleteToolkit: (toolkitId: string) =>
    request<undefined>("DELETE", `/api/toolkits/${id(toolkitId)}`),
}

/** Human readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return "Unexpected error."
}

/** Absolute endpoint URL, tolerating a path-only value from the daemon. */
export function absoluteEndpoint(endpoint: string): string {
  return new URL(endpoint, window.location.origin).toString()
}
