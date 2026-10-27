# mcproxy implementation contract

Build a local MCP authentication proxy. A provider describes an HTTP MCP server or a stdio command. Each profile holds separate upstream authentication and exposes `/mcps/:providerSlug/:profileSlug` behind its own stable bearer token. Preserve upstream MCP names, schemas, results, errors, capabilities, notifications, and bidirectional requests wherever the transport supports them. Do not aggregate or rename tools.

## Ownership

- Backend agent owns root package/workspace/config files, `apps/server/`, backend tests, and `docs/research/`. It owns the root lockfile and README.
- UI agent owns `apps/web/` and `docs/demos/`. It must not edit root package/config files or the lockfile. Parent handles final workspace installation and integration.
- Parent owns this contract, integration fixes, and final verification. Agents do not commit, push, open PRs, or spawn children.

## Stack and runtime

Use pnpm, strict TypeScript, Effect v4, Drizzle with SQLite, and the official MCP TypeScript SDK. Use Node for the local daemon. Verify current package versions and APIs against primary sources. The UI uses React, TanStack Router, Query, Form, Vite, Tailwind, and shadcn components. Server defaults to `127.0.0.1:7433`; development UI uses `127.0.0.1:5173` and proxies `/api`, `/oauth`, and `/mcps` to the daemon. Production serves the built UI from the daemon.

Implement macOS now. Keep filesystem locations, credential storage, browser opening, and service installation behind explicit platform boundaries. Do not install or start a login service, change real MCP clients, or access production credentials. Tests use temporary state directories and synthetic upstreams.

## Management API

JSON request and response bodies. Errors are `{ error: { code: string, message: string } }`. All management fetches send `X-Mcproxy-Request: 1`. Server validates Host and browser Origin, allows the exact local development UI origin when needed, and rejects cross-origin control requests. No wildcard CORS. State-changing routes require the custom header. Do not return stored upstream secrets.

Types used below:

```ts
type ProviderInput = {
  name: string;
  slug: string;
  transport: { type: "http"; url: string }
    | { type: "stdio"; command: string; args: string[]; cwd?: string };
};
type Provider = ProviderInput & { id: string; createdAt: string };
type AuthInput = { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "headers"; headers: Record<string, string> }
  | { type: "env"; env: Record<string, string> }
  | { type: "oauth"; clientId?: string; clientSecret?: string; scopes?: string[] };
type ProfileInput = { name: string; slug: string; auth: AuthInput };
type Profile = {
  id: string;
  providerId: string;
  name: string;
  slug: string;
  authType: AuthInput["type"];
  status: "ready" | "needs_auth" | "error";
  oauthStatus?: "idle" | "pending" | "error";
  endpoint: string;
  createdAt: string;
  lastError?: string;
};
```

- `GET /api/health` returns `{ status: "ok", version: string, platform: string }`.
- `GET /api/providers` returns `{ providers: Provider[] }`.
- `POST /api/providers` takes `ProviderInput`, returns `{ provider: Provider }` with status 201.
- `DELETE /api/providers/:id` deletes its profiles and closes sessions, returns 204.
- `GET /api/providers/:id/profiles` returns `{ profiles: Profile[] }`.
- `POST /api/providers/:id/profiles` takes `ProfileInput`, returns `{ profile: Profile, accessToken: string }` with status 201. Show the access token once, store only its hash.
- `PATCH /api/profiles/:id` takes `{ name?: string, auth?: AuthInput }`, returns `{ profile: Profile }`. Profile URL remains stable.
- `DELETE /api/profiles/:id` returns 204 and closes sessions.
- `POST /api/profiles/:id/token` rotates the downstream token, returns `{ accessToken: string }`. Immediately invalidate the old token and existing sessions.
- `POST /api/profiles/:id/oauth/start` returns `{ authorizationUrl: string }`. UI opens the URL after the response. The daemon handles discovery, PKCE, callback, encrypted token storage, and refresh. Callback is `GET /oauth/callback`; return a minimal completion page, and UI polls profile state while authorization is pending.

OAuth authorization state is separate from connection readiness. A reconnect preserves usable current credentials and sessions while a new exchange is pending. Successful exchange replaces the credentials and closes existing sessions. Denial, failure, or expiration appears through `oauthStatus: "error"` and a safe `lastError`; it does not discard the current credentials. An unauthenticated resource probe discovers challenge-provided metadata before well-known fallback. Refresh stays bound to the saved issuer.
- `POST /api/profiles/:id/test` returns `{ ok: boolean, message: string, capabilities?: Record<string, unknown> }`. Test connection and initialization only, without invoking tools.

Validate slugs, uniqueness, body sizes, transport/auth compatibility, and forbidden hop-by-hop/custom routing headers. Protect credentials and refresh tokens at rest. Redact tokens from all logs and errors. Bind sessions to both provider and profile; authenticate every downstream HTTP request, including GET and DELETE. Prevent sharing upstream sessions or stdio processes across profiles or downstream clients unless correctness is proven. Dispose child processes and streams on termination.

## UI behavior

The user explicitly waived the mockup selection step. Implement directly using judgment. Dark mode, dense layout, minimal copy, no decorative cards or pills, no light-gray subtitle lines, no em dashes, no continuous CSS animations.

Use a provider list and a profile detail workspace. Support HTTP and stdio setup, all supported authentication forms, OAuth connection and reconnection, token generation/copy/rotation, endpoint copying, connection testing, and destructive-action confirmation. Distinguish upstream credentials from the downstream access token in labels. Never imply that a profile is connected before the API confirms it. Use accessible labels, keyboard navigation, loading/error/empty states, and responsive layout.

Record actual UI flow demos after integration, using fake fixture credentials. Cover HTTP provider creation, two profiles with distinct endpoints, OAuth connection states, and stdio setup. Recordings must identify simulated OAuth if a fixture is used. Never record real secrets or consent to a real external account as part of a demo.

## Verification

Focused integration tests must exercise MCP tools/resources/prompts preservation, HTTP and stdio transport, downstream token enforcement, isolation between two profiles, OAuth state/PKCE and token refresh, and cleanup. Record any unimplemented protocol features explicitly. Run typechecks, builds, and relevant tests. No placeholder backend, fake success handlers, or UI-only persistence.
