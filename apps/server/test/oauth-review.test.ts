import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../src/store.js";
import { Vault } from "../src/platform.js";
import { OAuth } from "../src/oauth.js";

for (const dynamic of [false, true]) {
  test(`challenge issuer discovery and isolated reconnect (${dynamic ? "dynamic" : "configured"} registration)`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "oauth-review-"));
    const store = new Store(dir, new Vault(randomBytes(32)));
    let base = "";
    let failExchange = false;
    let issued = 0;
    let registrations = 0;
    const upstream = createServer((req, res) => {
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/mcp") {
        assert.equal(req.headers.authorization, undefined);
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/resource-metadata"` });
        res.end();
      } else if (req.url === "/resource-metadata") {
        json({ resource: `${base}/mcp`, authorization_servers: [`${base}/issuer`] });
      } else if (req.url === "/.well-known/oauth-authorization-server/issuer") {
        json({ issuer: `${base}/issuer`, authorization_endpoint: `${base}/issuer/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
      } else if (req.url === "/register") {
        registrations++;
        json({ client_id: `registered-${registrations}`, redirect_uris: ["http://127.0.0.1:7433/oauth/callback"], token_endpoint_auth_method: "none" }, 201);
      } else if (req.url === "/token") {
        if (failExchange) json({ error: "invalid_grant", error_description: "PRIVATE_PROVIDER_DETAIL" }, 400);
        else json({ access_token: `access-${++issued}`, token_type: "Bearer", refresh_token: `refresh-${issued}` });
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
    const oauth = new OAuth(store, () => "http://127.0.0.1:7433");
    const provider = store.createProvider({ name: "Fixture", slug: "fixture", transport: { type: "http", url: `${base}/mcp` } });
    const { profile } = store.createProfile(provider.id, { name: "A", slug: "a", auth: { type: "oauth", ...(!dynamic ? { clientId: "configured", scopes: ["read"] } : {}) } });
    const view = () => store.view(store.profile(profile.id), "http://localhost");
    const start = async () => {
      const url = new URL((await oauth.start(profile.id)).authorizationUrl);
      assert.equal(url.pathname, "/issuer/authorize");
      assert.equal(url.searchParams.get("resource"), `${base}/mcp`);
      if (!dynamic) assert.equal(url.searchParams.get("scope"), "read");
      assert.equal(view().oauthStatus, "pending");
      return url.searchParams.get("state")!;
    };
    try {
      const denied = await start();
      await assert.rejects(oauth.callback(denied, null, "access_denied"), /Authorization was denied/);
      assert.equal(view().oauthStatus, "error");
      assert.match(view().lastError!, /denied/);
      const failed = await start();
      failExchange = true;
      await assert.rejects(oauth.callback(failed, "code"), /Authorization failed/);
      assert.equal(view().oauthStatus, "error");
      assert.doesNotMatch(JSON.stringify(view()), /PRIVATE_PROVIDER_DETAIL/);
      failExchange = false;
      await oauth.callback(await start(), "first");
      const working = store.secret(profile.id);
      assert.equal(working.tokens?.access_token, "access-1");
      assert.equal(view().status, "ready");
      const reconnect = await start();
      assert.deepEqual(store.secret(profile.id).tokens, working.tokens);
      assert.deepEqual(store.secret(profile.id).discovery, working.discovery);
      assert.equal(view().status, "ready");
      await oauth.ready(profile.id);
      await assert.rejects(oauth.callback(reconnect, null, "access_denied"));
      assert.equal(view().status, "ready");
      assert.deepEqual(store.secret(profile.id).tokens, working.tokens);
      const expired = await start();
      const expiring = store.secret(profile.id);
      expiring.pending!.expiresAt = Date.now() - 1;
      store.saveSecret(profile.id, expiring);
      assert.equal(view().oauthStatus, "error");
      assert.match(view().lastError!, /expired/);
      await assert.rejects(oauth.callback(expired, "expired"), /Expired authorization state/);
      assert.deepEqual(store.secret(profile.id).tokens, working.tokens);
      const stale = await start();
      const replacement = await start();
      await assert.rejects(oauth.callback(stale, "stale"), /Invalid authorization state/);
      await oauth.callback(replacement, "replacement");
      assert.equal(store.secret(profile.id).tokens?.access_token, "access-2");
      assert.equal(view().oauthStatus, "idle");
      assert.equal(view().lastError, undefined);
      assert.equal(store.secret(profile.id).pending, undefined);
    } finally {
      store.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("profiles API reports denied and failed first authorizations with safe HTML callbacks", async () => {
  const { createProxyServer } = await import("../src/server.js");
  const dir = await mkdtemp(join(tmpdir(), "oauth-api-review-"));
  let base = "";
  const upstream = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.includes("oauth-authorization-server")) {
      res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }));
    } else if (req.url === "/token") {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid_grant", error_description: "PRIVATE_PROVIDER_DETAIL" }));
    } else { res.writeHead(404); res.end("{}"); }
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  const daemon = await createProxyServer({ stateDir: dir, port: 0 });
  const api = async (path: string, value?: unknown) => {
    const response = await fetch(daemon.url + path, {
      method: value === undefined ? "GET" : "POST",
      headers: { "X-Mcproxy-Request": "1", "content-type": "application/json" },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const providerResponse = await fetch(daemon.url + "/api/providers", { method: "POST", headers: { "X-Mcproxy-Request": "1", "content-type": "application/json" }, body: JSON.stringify({ name: "Fixture", slug: "fixture", transport: { type: "http", url: `${base}/mcp` } }) });
    const { provider } = await providerResponse.json();
    const created = await fetch(`${daemon.url}/api/providers/${provider.id}/profiles`, { method: "POST", headers: { "X-Mcproxy-Request": "1", "content-type": "application/json" }, body: JSON.stringify({ name: "A", slug: "a", auth: { type: "oauth", clientId: "fixture" } }) });
    const { profile } = await created.json();
    for (const failure of ["error=access_denied&error_description=PRIVATE_PROVIDER_DETAIL", "code=bad"]) {
      const { authorizationUrl } = await api(`/api/profiles/${profile.id}/oauth/start`, {});
      const state = new URL(authorizationUrl).searchParams.get("state");
      const callback = await fetch(`${daemon.url}/oauth/callback?state=${state}&${failure}`);
      assert.equal(callback.status, 400);
      assert.match(callback.headers.get("content-type")!, /text\/html/);
      assert.match(await callback.text(), /Authorization (was denied|failed)/);
      const result = await api(`/api/providers/${provider.id}/profiles`);
      assert.equal(result.profiles[0].oauthStatus, "error");
      assert.match(result.profiles[0].lastError, /Authorization/);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_DETAIL|verifier|pending|access_token/);
    }
  } finally {
    await daemon.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
