import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAuth } from "../src/discover.js";
import { createProxyServer } from "../src/server.js";

test("auth discovery tells none, OAuth and bearer upstreams apart", async () => {
  let base = "";
  let mode: "open" | "challenge" | "resource" | "legacy" | "bearer" | "missing" = "open";
  const closed: string[] = [];
  const upstream = createServer((req, res) => {
    const json = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const issuer = { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"] };
    if (req.url === "/mcp" && req.method === "DELETE") {
      closed.push(String(req.headers["mcp-session-id"]));
      res.writeHead(204).end();
    } else if (req.url === "/mcp") {
      assert.equal(req.headers.authorization, undefined);
      if (mode === "open") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "probe" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 0, result: {} }));
      } else if (mode === "challenge" || mode === "resource") {
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/meta"` }).end();
      } else if (mode === "missing") {
        res.writeHead(404).end();
      } else res.writeHead(401).end();
    } else if (req.url === "/meta" && (mode === "challenge" || mode === "resource")) {
      json({ resource: `${base}/mcp`, authorization_servers: [`${base}/issuer`] });
    } else if (req.url === "/.well-known/oauth-authorization-server/issuer" && mode === "challenge") {
      json({ ...issuer, issuer: `${base}/issuer` });
    } else if (req.url === "/.well-known/oauth-authorization-server" && mode === "legacy") {
      json(issuer);
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  const dir = await mkdtemp(join(tmpdir(), "discover-"));
  const daemon = await createProxyServer({ stateDir: dir, port: 0 });
  try {
    const expected = { open: "none", challenge: "oauth", resource: "oauth", legacy: "oauth", bearer: "bearer", missing: null } as const;
    for (const [next, authType] of Object.entries(expected)) {
      mode = next as typeof mode;
      assert.equal(await discoverAuth(`${base}/mcp`), authType, next);
    }
    assert.deepEqual(closed, ["probe"]);
    assert.equal(await discoverAuth("http://127.0.0.1:1/mcp"), null);

    const post = (path: string, value?: unknown) =>
      fetch(daemon.url + path, {
        method: "POST",
        headers: { "X-Mcproxy-Request": "1", "content-type": "application/json" },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
    const create = async (transport: unknown) =>
      (await (await post("/api/providers", { name: "Fixture", slug: `fixture-${Date.now()}`, transport })).json()).provider.id as string;
    mode = "challenge";
    const http = await post(`/api/providers/${await create({ type: "http", url: `${base}/mcp` })}/discover-auth`);
    assert.equal(http.status, 200);
    assert.deepEqual(await http.json(), { authType: "oauth" });
    const stdio = await post(`/api/providers/${await create({ type: "stdio", command: "true", args: [] })}/discover-auth`);
    assert.equal(stdio.status, 400);
  } finally {
    await daemon.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
