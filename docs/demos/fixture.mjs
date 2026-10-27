// Demo fixture for recording the mcproxy UI. Everything here is synthetic.
//
//   pnpm --filter @mcproxy/server exec tsx ../../docs/demos/fixture.mjs
//
// Starts:
//   - a synthetic HTTP MCP upstream on 127.0.0.1:7999
//       /static/mcp  accepts `Authorization: Bearer demo-...` tokens
//       /oauth/mcp   protected by a SIMULATED OAuth server (no real account)
//   - the mcproxy daemon on 127.0.0.1:7433 with a throwaway state directory,
//     serving the built UI from apps/web/dist
// The stdio provider in the demo runs docs/demos/stdio-notes.mjs.
// Ctrl-C stops both and deletes the state directory.

import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const UPSTREAM_PORT = Number(process.env.FIXTURE_PORT ?? 7999)
const DAEMON_PORT = Number(process.env.PORT ?? 7433)
const base = `http://127.0.0.1:${UPSTREAM_PORT}`

const codes = new Map() // code -> { challenge, redirectUri }
const accessTokens = new Set()
const refreshTokens = new Set()

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers })
  res.end(JSON.stringify(body))
}

const readBody = async (req) => {
  let raw = ""
  for await (const chunk of req) raw += chunk
  return raw
}

const escapeHtml = (value) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function consentPage(params) {
  const approve = new URLSearchParams({ ...Object.fromEntries(params), approve: "1" })
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Simulated OAuth</title>
<style>body{font:14px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:28rem;border:1px solid #444;padding:24px}h1{font-size:16px;color:#fbbf24}
a{display:inline-block;margin-top:12px;padding:8px 14px;background:#eee;color:#111;text-decoration:none;border-radius:4px}</style>
</head><body><main><h1>SIMULATED OAUTH. Demo fixture, no real account.</h1>
<p>Client <code>${escapeHtml(params.get("client_id") ?? "")}</code> requests access to the Acme Notes fixture.</p>
<a href="/authorize?${escapeHtml(approve.toString())}">Approve (simulated)</a></main></body></html>`
}

// Minimal Streamable HTTP MCP server answering with JSON bodies.
async function mcp(req, res, label) {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" })
    res.end()
    return
  }
  const message = JSON.parse(await readBody(req))
  if (!("id" in message)) {
    res.writeHead(202)
    res.end()
    return
  }
  const result =
    message.method === "initialize"
      ? {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: `acme-notes-${label}`, version: "1.0.0" },
        }
      : message.method === "tools/list"
        ? {
            tools: [
              {
                name: "search_notes",
                description: "Search demo notes",
                inputSchema: { type: "object", properties: { query: { type: "string" } } },
              },
            ],
          }
        : message.method === "resources/list"
          ? { resources: [{ uri: "notes://welcome", name: "Welcome note" }] }
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: `demo result from ${label}` }] }
            : {}
  const headers = message.method === "initialize" ? { "mcp-session-id": randomUUID() } : {}
  json(res, 200, { jsonrpc: "2.0", id: message.id, result }, headers)
}

const upstream = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", base)
  const auth = req.headers.authorization ?? ""

  if (url.pathname === "/static/mcp") {
    if (!auth.startsWith("Bearer demo-")) {
      json(res, 401, { error: "Expected a demo- bearer token" })
      return
    }
    return mcp(req, res, "static")
  }

  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return json(res, 200, { resource: `${base}/oauth/mcp`, authorization_servers: [base] })
  }
  if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
    return json(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    })
  }
  if (url.pathname === "/register" && req.method === "POST") {
    const body = JSON.parse(await readBody(req))
    return json(res, 201, {
      ...body,
      client_id: "demo-simulated-client",
      token_endpoint_auth_method: "none",
    })
  }
  if (url.pathname === "/authorize") {
    if (url.searchParams.get("approve") !== "1") {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(consentPage(url.searchParams))
      return
    }
    const code = randomBytes(16).toString("hex")
    const redirectUri = url.searchParams.get("redirect_uri") ?? ""
    codes.set(code, { challenge: url.searchParams.get("code_challenge"), redirectUri })
    const target = new URL(redirectUri)
    target.searchParams.set("code", code)
    const state = url.searchParams.get("state")
    if (state) target.searchParams.set("state", state)
    res.writeHead(302, { location: target.toString() })
    res.end()
    return
  }
  if (url.pathname === "/token" && req.method === "POST") {
    const params = new URLSearchParams(await readBody(req))
    if (params.get("grant_type") === "authorization_code") {
      const entry = codes.get(params.get("code") ?? "")
      codes.delete(params.get("code") ?? "")
      const verifier = params.get("code_verifier") ?? ""
      if (!entry || createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) {
        return json(res, 400, { error: "invalid_grant" })
      }
    } else if (params.get("grant_type") === "refresh_token") {
      if (!refreshTokens.has(params.get("refresh_token") ?? "")) {
        return json(res, 400, { error: "invalid_grant" })
      }
    } else {
      return json(res, 400, { error: "unsupported_grant_type" })
    }
    const access = `demo-sim-access-${randomBytes(6).toString("hex")}`
    const refresh = `demo-sim-refresh-${randomBytes(6).toString("hex")}`
    accessTokens.add(access)
    refreshTokens.add(refresh)
    return json(res, 200, {
      access_token: access,
      token_type: "Bearer",
      refresh_token: refresh,
      expires_in: 3600,
    })
  }
  if (url.pathname === "/oauth/mcp") {
    if (!accessTokens.has(auth.replace(/^Bearer /, ""))) {
      res.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/oauth/mcp"`,
      })
      res.end()
      return
    }
    return mcp(req, res, "oauth")
  }
  res.writeHead(404)
  res.end()
})

await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", resolve))

const stateDir = await mkdtemp(join(tmpdir(), "mcproxy-demo-"))
const { createProxyServer } = await import("../../apps/server/src/server.ts")
const daemon = await createProxyServer({
  stateDir,
  port: DAEMON_PORT,
  webDir: fileURLToPath(new URL("../../apps/web/dist", import.meta.url)),
})

const stdioScript = fileURLToPath(new URL("./stdio-notes.mjs", import.meta.url))
console.log(`fixture upstream  ${base}  (static: /static/mcp, simulated OAuth: /oauth/mcp)`)
console.log(`mcproxy daemon    ${daemon.url}  state ${stateDir}`)
console.log(`stdio command     node ${stdioScript}`)

let stopping = false
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (stopping) return
    stopping = true
    await daemon.close()
    upstream.closeAllConnections()
    upstream.close()
    await rm(stateDir, { recursive: true, force: true })
    process.exit(0)
  })
}
