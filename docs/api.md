# mcproxy management API

The daemon UI talks to this API. Server defaults to `127.0.0.1:7433`; the development UI runs on `127.0.0.1:5173` and proxies `/api`, `/oauth`, `/mcps` and `/toolkits` to the daemon.

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

- `GET /api/health` returns `{ status: "ok", version: string, platform: string }`. `version` is the release at HEAD, or `"development"`.
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

Toolkits group profiles behind `/toolkits/:slug` with one bearer token:

```ts
type ToolkitInput = { name: string; slug: string; profileIds: string[] };
type Toolkit = {
  id: string; name: string; slug: string; endpoint: string;
  tokenIssuedAt: string; createdAt: string;
  members: { profileId: string; providerId: string; prefix: string }[];
};
```

- `GET /api/toolkits` returns `{ toolkits: Toolkit[] }`; `POST /api/toolkits` returns `{ toolkit, accessToken }` with 201.
- `PATCH /api/toolkits/:id` takes `{ name?, profileIds? }`; `DELETE` returns 204. Both close affected sessions.
- `GET`/`POST /api/toolkits/:id/token` reveal or rotate the token like profile tokens.
- `POST /api/toolkits/:id/test` returns `{ members: { profileId, ok, message, tools: string[] }[] }` with prefixed names.

Member tools are exposed as `<prefix><name>`: `provider_` when the provider has one profile in the toolkit, `provider_profile_` when it has several, hyphens replaced by underscores. Only tools are merged.

Updates move the daemon's own checkout between release tags:

```ts
type UpdateStatus = {
  version?: string; commit?: string; modified: boolean; updatable: boolean;
  channel: "stable" | "nightly";
  available?: { version: string; url: string };
  checkedAt?: string; checkError?: string;
  applying: boolean; applyError?: string;
};
```

- `GET /api/update` returns `UpdateStatus` from the last check.
- `PATCH /api/update` takes `{ channel }` and returns `UpdateStatus`.
- `POST /api/update/check` checks GitHub now and returns `UpdateStatus`.
- `POST /api/update/apply` returns `UpdateStatus` with 202 and `applying: true`, then builds the release and restarts the daemon; 409 when nothing is available or an update is running.

Validate slugs, uniqueness, body sizes, transport/auth compatibility, and forbidden hop-by-hop/custom routing headers. Protect credentials and refresh tokens at rest. Redact tokens from all logs and errors. Bind sessions to both provider and profile; authenticate every downstream HTTP request, including GET and DELETE. Prevent sharing upstream sessions or stdio processes across profiles or downstream clients unless correctness is proven. Dispose child processes and streams on termination.

