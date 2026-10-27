# Proxy and authentication research

Verified 2026-10-26 against primary sources and installed package declarations.

- [MCPJungle](https://github.com/mcpjungle/MCPJungle) centralizes tools, prompts and resources behind an aggregated endpoint. mcproxy instead keeps one upstream per profile endpoint and does not rename protocol objects.
- [Executor](https://github.com/UsefulSoftwareCo/executor) separates integrations from authenticated connections. The provider/profile split uses that useful distinction without its catalog, policy or code execution layers.
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) requires protected-resource and authorization-server discovery, PKCE, resource binding and safe token handling. Downstream static tokens are a separate local authentication mechanism, never upstream credentials.
- [Official SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x/src/client) 1.32.2 exports `auth`, `OAuthClientProvider`, Streamable HTTP and stdio transports. The provider persists client registration, issuer-bound tokens, discovery state and PKCE verifier. `auth` handles registration, discovery, code exchange and refresh. Application code must validate callback state itself.
- [SDK transport interface](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/shared/transport.ts) relays JSON-RPC messages in both directions. Bridging transports preserves discovery, resources, prompts, notifications and server requests without a tools-only facade. Transport resumption histories are local to each hop.
- [Effect source](https://github.com/Effect-TS/effect) and the npm registry publish stable `effect@4.0.6`. Installed v4 declarations use `Context.Service`, `Effect.acquireRelease`, `Scope.make`, `Scope.close` and `Effect.runPromise`; v3 Tag examples are not applicable. Effect scopes own database, HTTP listener and per-client transport resources.

Pinned dependencies are in apps/server/package.json. OAuth tokens and pending flow state are encrypted with AES-256-GCM; downstream tokens use SHA-256 hashes of 256-bit random values. Platform paths and key storage are injectable. The default local key file is owner-only, with an owner-only state directory. This protects against other local users, not compromise of the account running the daemon.
