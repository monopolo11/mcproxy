# mcproxy

Local MCP authentication proxy. Each provider/profile exposes an independent HTTP endpoint, with its own downstream bearer token and upstream credentials. MCP names, capabilities, tools, resources, prompts, errors and bidirectional messages pass through without aggregation. Toolkits are the one exception: a toolkit groups several profiles behind a single endpoint and token and exposes their tools under a per-profile prefix.

Requires Node 22 and pnpm 11. The daemon binds only `127.0.0.1`, default port `7433`.

```sh
pnpm install
pnpm dev
```

Development runs both workspace apps. Vite listens on `127.0.0.1:5173` and proxies `/api`, `/oauth`, and `/mcps`. For production, check out the latest release and build it; Settings then keeps it updated (see [Releases and updates](#releases-and-updates)):

```sh
git checkout "$(gh release view --json tagName --jq .tagName)"
pnpm install
pnpm build
node apps/server/dist/main.js
```

The daemon serves `apps/web/dist`. `PORT` overrides the default daemon port. Do not run two daemons against the same state directory.

To start the daemon at login instead, build it and install the service:

```sh
pnpm build
pnpm service install
```

`pnpm service` takes `install`, `uninstall`, `start`, `stop`, `restart` and `status`. It registers a launchd agent on macOS, a systemd user unit on Linux and a `HKCU\...\Run` entry on Windows; none needs elevation. Install records the current `node`, `PATH` and `PORT` (from the shell or `.env`), so stdio profiles find the same commands as the shell that installed it, and updates find `git`, `gh` and `pnpm`. Install, start and restart refuse while something else listens on the port, such as a foreground `pnpm dev`. Run `pnpm service restart` after `pnpm build`; it keeps the installed definition, so re-run `install` to change `PORT`. On macOS and Linux the daemon comes back after a crash; on every platform `pnpm service stop` keeps it down until the next login. Logs go to `~/Library/Logs/mcproxy/mcproxy.log` on macOS, the user journal on Linux (`journalctl --user -u mcproxy`) and `%LOCALAPPDATA%\mcproxy\mcproxy.log` plus `mcproxy.err.log` on Windows, where they are replaced at each start. Linux install also enables lingering so the daemon starts at boot and survives logout, and prints the `loginctl` command when that needs a password. On Windows a PowerShell window may flash at logon, stop is a forced kill and nothing restarts the daemon after a crash. macOS is verified; Linux and Windows are implemented but not tested here.

Behind a TLS-inspecting proxy (Cloudflare WARP, Zscaler, ...) connecting to an HTTPS upstream fails with `SELF_SIGNED_CERT_IN_CHAIN` and the test reports an untrusted certificate. Put the proxy's CA bundle in a `.env` at the repo root, which `pnpm dev` and `pnpm start` load, then restart:

```sh
NODE_EXTRA_CA_CERTS=/path/to/ca.pem
```

```sh
pnpm typecheck
pnpm build
pnpm test
```

## Releases and updates

Releases are GitHub Releases on tags; the version lives only in the tag, never in `package.json`. `.github/workflows/release.yml` runs typecheck, tests and build, then publishes:

- **Stable**: every push to `main`, tagged with a patch bump of the latest stable (`v0.1.0` first) and marked latest. Notes cover the commits since the previous stable. A commit that already has a stable tag is skipped.
- **Nightly**: by hand, from Actions > Release > Run workflow, with any branch, tag or commit as `ref` (default `main`), so an unmerged branch can reach nightly testers. Tagged `vX.Y.(Z+1)-nightly.YYYYMMDD.<run>` on top of the latest stable `vX.Y.Z`, published as a prerelease, never latest. Notes cover the changes since the previous nightly.

The daemon's version is the release tag at the checkout's HEAD. A checkout with modified tracked files, or with no release tag at HEAD, is a development build: Settings shows its commit and offers no updates. The exception is a clean checkout of `main`, which is offered the latest stable once that release contains it.

Settings > Daemon shows the version, the channel and any available update. Stable sees stable releases only; nightly sees both and offers the higher. A lower version is never offered, so moving from nightly to stable waits for the next stable newer than the installed nightly. The daemon checks at start and hourly, and the channel is kept in its state. The repo is private, so checks call `gh api` when `gh` is signed in, else use `GH_TOKEN` or `GITHUB_TOKEN` from the environment or `.env`; with neither, Settings says it can't check and why.

Update and restart fetches tags with git's own credentials, checks out the release tag (detached), runs `pnpm install` if the lockfile changed and `pnpm build`, with their output in the daemon log. If any step fails it checks out the previous version, rebuilds it and shows the error. Then the daemon restarts: through the login service when that runs it, otherwise by respawning the same command line in the background, which leaves the terminal that started it; stop that one by pid. A build that succeeds but then fails to start is not rolled back. Migrations run at startup.

Tests use temporary directories, synthetic credentials, an HTTP MCP server, a stdio subprocess and a deterministic OAuth authorization server. They exercise discovery, resources, prompts, two-profile isolation, downstream authentication, token rotation, process cleanup, notifications, server-to-client requests, OAuth state, PKCE, registration and durable refresh after restart.

Recorded UI walkthroughs and disposable fixture instructions are in [docs/demos/README.md](docs/demos/README.md). They cover HTTP profiles, simulated OAuth consent, and local stdio configuration. No real provider accounts were used.

## API

The management API follows [the implementation contract](docs/implementation-contract.md). POST, PATCH and DELETE require `X-Mcproxy-Request: 1`. Browser Origin must match the daemon or the exact local Vite origin. Host must match the daemon's listening address. There is no wildcard CORS.

Create a provider with `POST /api/providers`, then create profiles with `POST /api/providers/:id/profiles`. Profile creation returns the downstream `accessToken`, and `GET /api/profiles/:id/token` returns it again; like mutations, that read requires `X-Mcproxy-Request: 1`. Configure an MCP client with the returned `profile.endpoint` and `Authorization: Bearer <accessToken>`. Token rotation at `POST /api/profiles/:id/token` invalidates the previous token and closes existing sessions. Every MCP request, including GET and DELETE, requires authentication.

Put secrets in profile authentication fields. Provider URLs, command arguments and names are configuration returned by the management API.

HTTP upstream profiles support no auth, bearer auth, validated custom headers and OAuth. Stdio profiles support no auth or an environment map. Stdio commands use an argument array without a shell and the SDK's limited default environment, with explicit PATH, HOME, and profile environment values. Child stderr is discarded to prevent credential leakage.

`POST /api/profiles/:id/oauth/start` returns an authorization URL for the UI to open. The daemon handles protected-resource and authorization-server discovery, dynamic registration or configured client credentials, PKCE, callback state validation and encrypted token persistence. Refresh is serialized per profile, runs before expired-token requests and retries once after a 401. The callback is `/oauth/callback`. Pending flows expire after ten minutes and callbacks cannot be replayed.

Discovery honors upstream `WWW-Authenticate` metadata URLs as well as well-known locations. Reconnect stages new authorization separately, keeping working credentials and sessions until the exchange succeeds. A denied, failed, or abandoned reconnect leaves the current connection intact. Successful replacement closes existing sessions so clients reinitialize with the new credentials. Refresh uses the saved issuer discovery; reconnect explicitly if the upstream changes authorization servers.

OAuth profiles expose `oauthStatus` independently of connection readiness: `pending`, `error`, or `idle`. Safe `lastError` messages report failed or expired authorization without exposing upstream error descriptions. The UI clears sensitive mutation data after forms and token dialogs finish.

Connection testing initializes the upstream without calling tools. Non-OAuth profiles initially report `ready` to mean their configuration can be used; this does not claim a successful connection. Use the test endpoint to verify connectivity.

## Toolkits

A toolkit is a named set of profiles served at `/toolkits/:slug` behind its own bearer token. `POST /api/toolkits` takes `{ name, slug, profileIds }` and returns `{ toolkit, accessToken }`; `PATCH /api/toolkits/:id` changes the name or members, `DELETE` removes it, and `GET`/`POST /api/toolkits/:id/token` reveal or rotate the token with the same rules as profiles. `POST /api/toolkits/:id/test` connects to every member once and returns its prefixed tool names. Deleting a profile removes it from every toolkit.

Tools are the union of the members' tools, renamed `<prefix><tool>`. The prefix is the provider slug when the provider contributes one profile to the toolkit, or `<provider>_<profile>` when it contributes several, with hyphens turned into underscores: `prepare_attachment_upload` from Linear becomes `linear_prepare_attachment_upload`, or `linear_acme_prepare_attachment_upload` once a second Linear profile joins. Tool definitions, call arguments, results and upstream error codes pass through unchanged apart from the name. Members connect lazily on the first `tools/list` or `tools/call`; an unreachable member contributes no tools, and `tools/list` fails only when no member is reachable. Upstream `tools/list_changed` notifications are forwarded. Resources, prompts and other upstream capabilities are not merged. Each downstream session opens its own upstream connections, as profile sessions do, and toolkit sessions close when the toolkit is deleted, its token rotates, its membership changes, or a member profile's credentials change.

## State and platform boundaries

macOS defaults to `~/Library/Application Support/mcproxy`. Linux uses `$XDG_STATE_HOME/mcproxy` or `~/.local/state/mcproxy`. Windows uses `%LOCALAPPDATA%/mcproxy`. macOS is the verified platform; Linux and Windows paths are implemented but not tested here. `pnpm service install` registers a login service; otherwise run the daemon in the foreground.

`createProxyServer({ stateDir, port: 0, platform, webDir, updates })` in `apps/server/src/server.ts` supports isolated embedding and tests. `updates` enables `/api/update` with an `UpdateSource` (`update.ts`); the daemon passes the git checkout it runs from, tests a fake, and embeddings without it report `version: "development"`. The returned handle exposes `url`, `port`, `close()` and `sessionCount()`. `Platform` and `CredentialStore` in `platform.ts` make filesystem locations and key storage injectable. The daemon does not launch a browser; service installation lives in `startup.ts`, outside the daemon, which only asks the service to restart it after an update.

Upstream credentials, OAuth tokens, discovery state, client registration and pending PKCE state use AES-256-GCM encryption in SQLite. The random encryption key is an owner-only `master.key` in an owner-only state directory. The database is owner-only. This default protects against other local users, not compromise of the current user or a backup containing both the key and database. Keychain integration is not implemented. Keep the complete state directory when moving or backing up profiles. Downstream tokens are random 256-bit values. The daemon stores a SHA-256 hash for authentication and a vault-sealed copy so the UI can show the token again; profiles created before that copy existed must rotate before reveal works.

Effect v4 services and scopes own the database, HTTP listener and each pair of transports. Drizzle defines the SQLite schema and performs application queries; versioned SQL migrations run transactionally at startup. Sessions are isolated per downstream client and profile, expire after thirty minutes of inactivity and close on DELETE, profile/provider removal, credential changes, rotation or daemon shutdown. Standard SDK stdio shutdown escalates to terminate/kill when needed. Detached grandchildren are not tracked.

## Protocol and operational limits

HTTP upstreams must support single-message Streamable HTTP requests and responses. Legacy HTTP+SSE transport is not implemented. HTTP POST responses retain their originating request association, including notifications, progress and server-to-client requests during initialization or concurrent tool calls. These messages use the corresponding downstream POST SSE stream and do not require a separate downstream GET. JSON responses are also supported. The adapter does not resume interrupted upstream POST streams.

Genuinely unsolicited HTTP messages and stdio notifications/requests use the downstream GET SSE channel. Before GET opens or while it is disconnected, each session queues at most 128 messages and 1 MiB of serialized message data. Exceeding either limit closes the session and clears its queue; session deletion, expiry and shutdown also clear it. Clients must open GET to receive these messages. Stdio has no HTTP request association, so stdio server requests cannot be routed safely to concurrent downstream POST streams. A stdio server that waits for a client callback during initialization is not supported; callbacks after initialization require GET. MCP contents are preserved, but transport behavior is not an exact mirror in these cases.

Downstream event-ID replay, end-to-end SSE resumption and replay across daemon restarts are not provided. A disconnect can lose messages already handed to a stream. Clients must reconnect and initialize after restart or queue overflow. Authentication scope challenges do not automatically add new scopes; reconnect with the required scopes in the profile.

There are at most 256 active downstream sessions. Request bodies are limited to 1 MiB. The proxy does not log request bodies, headers, stderr, authorization URLs or upstream error text. Protocol error objects from an upstream are intentionally preserved, so an upstream remains responsible for keeping secrets out of its own MCP results and errors. Only configure upstream servers and stdio commands you trust.

## Logs

The daemon writes one timestamped line per event to stdout (warnings and errors to stderr), greppable by scope and `key=value` fields:

```
2026-10-27 12:48:13.488 INFO  [toolkit] session closed session=2e4bcb32-... toolkit=work reason=members-changed
2026-10-27 12:48:13.643 WARN  [http] request rejected method=POST path=/api/toolkits status=409 code=conflict
```

Scopes are `server`, `http` (rejected and failed requests), `proxy` and `toolkit` (sessions opened and closed with a `reason`, upstream connection failures), `oauth` (authorization, refresh) and `update` (failed checks, updates and restarts). Profiles show as `provider/profile`. Errors log a code or name such as `TypeError:ECONNREFUSED`, never their message. `src/log.ts` holds the format.

Primary-source findings are in [docs/research/proxy-auth.md](docs/research/proxy-auth.md).
