# UI demos

Browser recordings of the mcproxy UI driving a real daemon. All credentials are synthetic and the daemon used a throwaway state directory. The OAuth flow is **simulated**: the authorization server is the local fixture in `fixture.mjs`, not a real provider, and no real account was used.

| File | Shows |
| --- | --- |
| `01-http-provider-two-profiles.mp4` | Add an HTTP provider, create a bearer profile and a custom header profile with distinct endpoints, one-time token reveal, connection tests, token rotation with confirmation |
| `02-simulated-oauth-ui.mp4` | OAuth profile starts as Needs authorization, Connect, waiting state, status flips to Ready by polling after consent, test, Reconnect available |
| `02b-simulated-oauth-consent.mp4` | The simulated consent page approved in a second tab, then the daemon callback page |
| `03-stdio-provider.mp4` | Add a stdio provider, transport-aware auth choices, env credential profile, test, delete confirmation (cancelled) |

The recordings capture one browser tab each. The OAuth consent tab was recorded separately as `02b`.

## Reproduce

```sh
pnpm install
pnpm --filter @mcproxy/web build
pnpm --filter @mcproxy/server exec tsx ../../docs/demos/fixture.mjs
```

The fixture prints three lines: the upstream base, the daemon URL with its temp state dir, and the stdio command. Open `http://127.0.0.1:7433` and follow:

1. Add provider `Acme Notes`, HTTP, `http://127.0.0.1:7999/static/mcp`.
2. Profile `Work`, Bearer token `demo-work-token-0001`. Done, Test.
3. Profile `Personal`, Custom headers `Authorization: Bearer demo-personal-0002`. Done, Test, Rotate.
4. Add provider `Simulated OAuth Notes`, HTTP, `http://127.0.0.1:7999/oauth/mcp`. Profile `Team`, OAuth. Connect, then click `Approve (simulated)` in the opened tab. The profile turns Ready on its own.
5. Add provider `Local Notes`, stdio, command `node`, argument = the printed `stdio-notes.mjs` path. Profile `Default`, Environment variables `DEMO_NOTES_KEY=demo-local-0003`. Test.

Ctrl-C stops the fixture and deletes the state directory. Ports: upstream `FIXTURE_PORT` (7999), daemon `PORT` (7433).

`/static/mcp` accepts only `Bearer demo-*` tokens, and `stdio-notes.mjs` fails initialization without a `demo-*` `DEMO_NOTES_KEY`, so a passing test shows that the upstream credentials actually reached the upstream.
