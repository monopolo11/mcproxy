import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, request } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DownstreamTransport } from "../src/downstream.js";
import {
  isJSONRPCRequest,
  JSONRPCMessageSchema,
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createProxyServer } from "../src/server.js";
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "mcproxy-test-"));
  const daemon = await createProxyServer({ stateDir: dir, port: 0 });
  async function api(path: string, method = "GET", value?: unknown) {
    const response = await fetch(daemon.url + path, {
      method,
      headers: { "X-Mcproxy-Request": "1", "Content-Type": "application/json" },
      ...(value ? { body: JSON.stringify(value) } : {}),
    });
    const data = response.status === 204 ? undefined : await response.json();
    return { response, data };
  }
  return {
    dir,
    daemon,
    api,
    async close() {
      await daemon.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function connect(
  endpoint: string,
  token: string,
  customFetch: typeof fetch = fetch,
) {
  const client = new Client(
    { name: "test", version: "1" },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: "file:///fixture", name: "fixture" }],
  }));
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: customFetch,
  });
  await client.connect(transport, { timeout: 5000 });
  return {
    client,
    transport,
    async close() {
      await transport.terminateSession().catch(() => {});
      await client.close();
    },
  };
}
test("stdio preserves tools/resources/prompts, isolates profiles, rotates tokens and kills processes", async () => {
  const env = await setup();
  try {
    const { data: p } = await env.api("/api/providers", "POST", {
      name: "stdio",
      slug: "stdio",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [resolve("test/stdio-fixture.mjs")],
      },
    });
    const pidFile = join(env.dir, "child.pid");
    const { data: a } = await env.api(
      `/api/providers/${p.provider.id}/profiles`,
      "POST",
      {
        name: "A",
        slug: "a",
        auth: { type: "env", env: { IDENTITY: "A", PID_FILE: pidFile } },
      },
    );
    const { data: b } = await env.api(
      `/api/providers/${p.provider.id}/profiles`,
      "POST",
      { name: "B", slug: "b", auth: { type: "env", env: { IDENTITY: "B" } } },
    );
    const ca = await connect(a.profile.endpoint, a.accessToken);
    const cb = await connect(b.profile.endpoint, b.accessToken);
    const ca2 = await connect(a.profile.endpoint, a.accessToken);
    await assert.rejects(ca.client.ping(), {
      code: -32042,
      data: { fixture: true },
    });
    assert.notEqual(ca.transport.sessionId, ca2.transport.sessionId);
    assert.equal(env.daemon.sessionCount(), 3);
    assert.equal((await ca.client.listTools()).tools[0]?.name, "identity");
    assert.equal(
      (await ca.client.listResources()).resources[0]?.uri,
      "fixture://item",
    );
    assert.equal(
      (await ca.client.readResource({ uri: "fixture://item" })).contents[0]
        ?.text,
      "resource",
    );
    assert.equal((await ca.client.listPrompts()).prompts[0]?.name, "hello");
    assert.equal(
      (await ca.client.getPrompt({ name: "hello" })).messages[0]?.content.text,
      "hello",
    );
    assert.deepEqual((await ca.client.callTool({ name: "identity" })).content, [
      { type: "text", text: "A" },
    ]);
    assert.deepEqual((await cb.client.callTool({ name: "identity" })).content, [
      { type: "text", text: "B" },
    ]);
    for (const method of ["GET", "DELETE"])
      assert.equal((await fetch(a.profile.endpoint, { method })).status, 401);
    assert.equal(
      (
        await fetch(b.profile.endpoint, {
          headers: {
            Authorization: `Bearer ${b.accessToken}`,
            "mcp-session-id": ca.transport.sessionId!,
          },
        })
      ).status,
      404,
    );
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(a.profile.tokenIssuedAt);
    const revealed = await env.api(`/api/profiles/${a.profile.id}/token`);
    assert.equal(revealed.data.accessToken, a.accessToken);
    assert.equal(
      (await fetch(`${env.daemon.url}/api/profiles/${a.profile.id}/token`))
        .status,
      403,
      "reveal requires the request marker",
    );
    const { data: rotated } = await env.api(
      `/api/profiles/${a.profile.id}/token`,
      "POST",
    );
    assert.notEqual(rotated.accessToken, a.accessToken);
    assert.equal(
      (await env.api(`/api/profiles/${a.profile.id}/token`)).data.accessToken,
      rotated.accessToken,
    );
    assert.equal(
      (
        await fetch(a.profile.endpoint, {
          headers: { Authorization: `Bearer ${a.accessToken}` },
        })
      ).status,
      401,
    );
    assert.throws(() => process.kill(pid, 0));
    assert.equal(env.daemon.sessionCount(), 1);
    await ca.close();
    await ca2.close();
    await cb.close();
    assert.equal(env.daemon.sessionCount(), 0);
    const list = await env.api(`/api/providers/${p.provider.id}/profiles`);
    assert.ok(!JSON.stringify(list.data).includes("tokenHash"));
    assert.ok(!JSON.stringify(list.data).includes("PID_FILE"));
  } finally {
    await env.close();
  }
});
async function httpFixture(oauth = false, bidirectional = false) {
  let issued = "";
  let refreshes = 0;
  let verifier = "";
  let challenge = "";
  let receivedRoots = false;
  const rootWaiters = new Map<string, () => void>();
  let exchangeGate: Promise<void> | undefined;
  let exchangeStarted: (() => void) | undefined;
  let getReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    getReady = resolve;
  });
  const transports = new Map<string, DownstreamTransport>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const reply = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname.includes("oauth-protected-resource")) {
      reply(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      return;
    }
    if (url.pathname.includes("oauth-authorization-server")) {
      reply(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (url.pathname === "/register") {
      reply(201, {
        client_id: "fixture-client",
        redirect_uris: [callback],
        token_endpoint_auth_method: "none",
      });
      return;
    }
    if (url.pathname === "/token") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const params = new URLSearchParams(raw);
      if (params.get("grant_type") === "authorization_code") {
        verifier = params.get("code_verifier") ?? "";
        if (
          createHash("sha256").update(verifier).digest("base64url") !==
          challenge
        ) {
          reply(400, { error: "invalid_grant" });
          return;
        }
      } else {
        assert.equal(params.get("refresh_token"), "refresh-fixture");
        refreshes++;
      }
      exchangeStarted?.();
      await exchangeGate;
      issued = `access-${refreshes}`;
      reply(200, {
        access_token: issued,
        token_type: "Bearer",
        refresh_token: "refresh-fixture",
        expires_in: 1,
      });
      return;
    }
    if (oauth && req.headers.authorization !== `Bearer ${issued}`) {
      res.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      });
      res.end();
      return;
    }
    let transport = transports.get(String(req.headers["mcp-session-id"]));
    if (!transport) {
      transport = new DownstreamTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
        },
      });
      const current = transport;
      current.onmessage = async (message) => {
        if (!isJSONRPCRequest(message)) {
          if ("result" in message && message.id === "roots")
            receivedRoots = true;
          if ("result" in message) rootWaiters.get(String(message.id))?.();
          return;
        }
        if (
          bidirectional &&
          (message.method === "tools/call" || message.method === "initialize")
        ) {
          const id = `roots-${message.id}`;
          const reply = new Promise<void>((resolve) =>
            rootWaiters.set(id, resolve),
          );
          await current.send(
            { jsonrpc: "2.0", id, method: "roots/list" },
            { relatedRequestId: message.id },
          );
          await reply;
          rootWaiters.delete(id);
          await current.send(
            {
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { progressToken: String(message.id), progress: 1 },
            },
            { relatedRequestId: message.id },
          );
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {}, resources: {}, prompts: {} },
                serverInfo: { name: "http-fixture", version: "1" },
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "original",
                      description: "preserved",
                      inputSchema: { type: "object" },
                    },
                  ],
                }
              : message.method === "resources/list"
                ? { resources: [{ uri: "test://one", name: "one" }] }
                : message.method === "prompts/list"
                  ? { prompts: [{ name: "original-prompt" }] }
                  : message.method === "tools/call"
                    ? {
                        content: [
                          {
                            type: "text",
                            text: req.headers.authorization ?? "none",
                          },
                        ],
                      }
                    : {};
        void current.send({ jsonrpc: "2.0", id: message.id, result });
      };
    }
    let body: unknown;
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      body = JSON.parse(raw);
    }
    await transport.handleNodeRequest(req, res, body, async () => getReady());
  });
  let base = "";
  let callback = "";
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  base = `http://127.0.0.1:${addr.port}`;
  return {
    pauseExchange() {
      let release!: () => void;
      exchangeGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        exchangeStarted = resolve;
      });
      return { started, release };
    },
    get base() {
      return base;
    },
    set callback(v: string) {
      callback = v;
    },
    set challenge(v: string) {
      challenge = v;
    },
    get verifier() {
      return verifier;
    },
    get refreshes() {
      return refreshes;
    },
    get receivedRoots() {
      return receivedRoots;
    },
    async notify() {
      await ready;
      for (const transport of transports.values()) {
        await transport.send({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
        });
        await transport.send({
          jsonrpc: "2.0",
          id: "roots",
          method: "roots/list",
        });
      }
    },
    async close() {
      for (const t of transports.values()) await t.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
test("HTTP relay preserves discovery and bidirectional messages", async () => {
  const fixture = await httpFixture();
  const env = await setup();
  try {
    const { data: p } = await env.api("/api/providers", "POST", {
      name: "HTTP",
      slug: "http",
      transport: { type: "http", url: fixture.base + "/mcp" },
    });
    const { data: a } = await env.api(
      `/api/providers/${p.provider.id}/profiles`,
      "POST",
      {
        name: "A",
        slug: "a",
        auth: { type: "bearer", token: "synthetic-secret" },
      },
    );
    const connection = await connect(a.profile.endpoint, a.accessToken);
    assert.equal(
      (await connection.client.listTools()).tools[0]?.description,
      "preserved",
    );
    assert.equal(
      (await connection.client.listResources()).resources[0]?.uri,
      "test://one",
    );
    assert.equal(
      (await connection.client.listPrompts()).prompts[0]?.name,
      "original-prompt",
    );
    assert.deepEqual(
      (await connection.client.callTool({ name: "original" })).content,
      [{ type: "text", text: "Bearer synthetic-secret" }],
    );
    let notified = false;
    connection.client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        notified = true;
      },
    );
    await fixture.notify();
    for (let i = 0; i < 30 && (!notified || !fixture.receivedRoots); i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.ok(notified, "upstream notification relayed");
    assert.ok(fixture.receivedRoots, "server request and client reply relayed");
    await connection.close();
  } finally {
    await env.close();
    await fixture.close();
  }
});
test("OAuth discovery, registration, state, PKCE, durable tokens and refresh", async () => {
  const fixture = await httpFixture(true);
  const env = await setup();
  try {
    fixture.callback = env.daemon.url + "/oauth/callback";
    const { data: p } = await env.api("/api/providers", "POST", {
      name: "OAuth",
      slug: "oauth",
      transport: { type: "http", url: fixture.base + "/mcp" },
    });
    const { data: a } = await env.api(
      `/api/providers/${p.provider.id}/profiles`,
      "POST",
      { name: "A", slug: "a", auth: { type: "oauth" } },
    );
    assert.equal(a.profile.status, "needs_auth");
    const started = await env.api(
      `/api/profiles/${a.profile.id}/oauth/start`,
      "POST",
    );
    assert.equal(started.response.status, 200, JSON.stringify(started.data));
    const authorize = new URL(started.data.authorizationUrl);
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorize.searchParams.get("client_id"), "fixture-client");
    fixture.challenge = authorize.searchParams.get("code_challenge")!;
    assert.equal(
      (await fetch(env.daemon.url + "/oauth/callback?state=wrong&code=fake"))
        .status,
      400,
    );
    const callback =
      env.daemon.url +
      "/oauth/callback?state=" +
      authorize.searchParams.get("state") +
      "&code=fake";
    assert.equal((await fetch(callback)).status, 200);
    assert.ok(fixture.verifier.length >= 43);
    assert.equal((await fetch(callback)).status, 400);
    const list = await env.api(`/api/providers/${p.provider.id}/profiles`);
    assert.equal(list.data.profiles[0].status, "ready");
    const c = await connect(a.profile.endpoint, a.accessToken);
    assert.ok(fixture.refreshes > 0);
    await c.close();
    await env.daemon.close();
    const refreshedBeforeRestart = fixture.refreshes;
    const restarted = await createProxyServer({
      stateDir: env.dir,
      port: env.daemon.port,
    });
    try {
      const resumed = await connect(a.profile.endpoint, a.accessToken);
      assert.ok(
        fixture.refreshes > refreshedBeforeRestart,
        "encrypted refresh token survives restart",
      );
      await resumed.close();
    } finally {
      await restarted.close();
    }
    const disk = await readFile(join(env.dir, "state.sqlite"));
    assert.ok(!disk.includes(Buffer.from("refresh-fixture")));
    assert.ok(!disk.includes(Buffer.from(a.accessToken)));
  } finally {
    await env.close();
    await fixture.close();
  }
});
test("management rejects foreign origins, hosts, missing headers, incompatible auth and duplicate slugs", async () => {
  const env = await setup();
  try {
    assert.equal(
      (
        await fetch(env.daemon.url + "/api/health", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      await new Promise<number | undefined>((resolve, reject) => {
        const req = request(
          env.daemon.url + "/api/health",
          { headers: { Host: "evil.example" } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      }),
      403,
    );
    assert.equal(
      (
        await fetch(env.daemon.url + "/api/providers", {
          method: "POST",
          body: "{}",
        })
      ).status,
      403,
    );
    const input = {
      name: "A",
      slug: "a",
      transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
    };
    const p = await env.api("/api/providers", "POST", input);
    assert.equal(
      (await env.api("/api/providers", "POST", input)).response.status,
      409,
    );
    assert.equal(
      (
        await env.api(`/api/providers/${p.data.provider.id}/profiles`, "POST", {
          name: "bad",
          slug: "bad",
          auth: { type: "headers", headers: { Host: "evil" } },
        })
      ).response.status,
      400,
    );
  } finally {
    await env.close();
  }
});

test("profile updates keep endpoints stable, validate compatibility, test only initialization and cascade deletion", async () => {
  const env = await setup();
  try {
    const { data: p } = await env.api("/api/providers", "POST", {
      name: "local",
      slug: "local",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [resolve("test/stdio-fixture.mjs")],
      },
    });
    const { data: a } = await env.api(
      `/api/providers/${p.provider.id}/profiles`,
      "POST",
      { name: "First", slug: "first", auth: { type: "none" } },
    );
    assert.equal(
      (
        await env.api(`/api/providers/${p.provider.id}/profiles`, "POST", {
          name: "duplicate",
          slug: "first",
          auth: { type: "none" },
        })
      ).response.status,
      409,
    );
    assert.equal(
      (
        await env.api(`/api/profiles/${a.profile.id}`, "PATCH", {
          auth: { type: "bearer", token: "fixture" },
        })
      ).response.status,
      400,
    );
    const updated = await env.api(`/api/profiles/${a.profile.id}`, "PATCH", {
      name: "Renamed",
      auth: { type: "env", env: { IDENTITY: "updated" } },
    });
    assert.equal(updated.data.profile.endpoint, a.profile.endpoint);
    const checked = await env.api(`/api/profiles/${a.profile.id}/test`, "POST");
    assert.equal(checked.data.ok, true);
    assert.deepEqual(checked.data.capabilities, {
      tools: {},
      resources: {},
      prompts: {},
    });
    assert.equal(env.daemon.sessionCount(), 0);
    const client = await connect(a.profile.endpoint, a.accessToken);
    await env.api(`/api/providers/${p.provider.id}`, "DELETE");
    assert.equal(env.daemon.sessionCount(), 0);
    assert.equal(
      (
        await fetch(a.profile.endpoint, {
          headers: { Authorization: `Bearer ${a.accessToken}` },
        })
      ).status,
      404,
    );
    await client.close();
  } finally {
    await env.close();
  }
});

test("management enforces its request body limit", async () => {
  const env = await setup();
  try {
    const response = await fetch(env.daemon.url + "/api/providers", {
      method: "POST",
      headers: { "X-Mcproxy-Request": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(1024 * 1024) }),
    });
    assert.equal(response.status, 413);
  } finally {
    await env.close();
  }
});

test("POST-only clients receive initialization and concurrent tool server requests on their own streams", async () => {
  const fixture = await httpFixture(false, true);
  const env = await setup();
  try {
    const { data: p } = await env.api("/api/providers", "POST", {
      name: "HTTP",
      slug: "post",
      transport: { type: "http", url: fixture.base + "/mcp" },
    });
    const { data: a } = await env.api(
      `/api/providers/${p.provider.id}/profiles`,
      "POST",
      { name: "A", slug: "a", auth: { type: "none" } },
    );
    const streams = new Map<string, string[]>();
    const connection = await connect(
      a.profile.endpoint,
      a.accessToken,
      async (url, init) => {
        if (init?.method === "GET") return new Response(null, { status: 405 });
        const response = await fetch(url, init);
        if (init?.method === "POST" && typeof init.body === "string") {
          const sent = JSONRPCMessageSchema.parse(JSON.parse(init.body));
          if (isJSONRPCRequest(sent)) {
            const text = response
              .clone()
              .text()
              .then((text) => {
                const ids = [...text.matchAll(/"id":"(roots-[^"]+)"/g)].map(
                  (match) => match[1]!,
                );
                assert.ok(
                  text.includes(`"progressToken":"${sent.id}"`),
                  "progress stays on the originating POST",
                );
                streams.set(String(sent.id), ids);
              });
            void text;
          }
        }
        return response;
      },
    );
    await Promise.all([
      connection.client.callTool({ name: "original" }),
      connection.client.callTool({ name: "original" }),
    ]);
    // Wait for the cloned response readers, not a transport startup delay.
    for (let i = 0; i < 100 && streams.size < 3; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(streams.size, 3);
    for (const [id, roots] of streams) assert.deepEqual(roots, [`roots-${id}`]);
    await connection.close();
  } finally {
    await env.close();
    await fixture.close();
  }
});

test("unsolicited messages before downstream GET are buffered until it opens", async () => {
  const fixture = await httpFixture();
  const env = await setup();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  try {
    const { data: p } = await env.api("/api/providers", "POST", {
      name: "HTTP",
      slug: "queued",
      transport: { type: "http", url: fixture.base + "/mcp" },
    });
    const { data: a } = await env.api(
      `/api/providers/${p.provider.id}/profiles`,
      "POST",
      { name: "A", slug: "a", auth: { type: "none" } },
    );
    const connection = await connect(
      a.profile.endpoint,
      a.accessToken,
      async (url, init) => {
        if (init?.method === "GET") await gate;
        return fetch(url, init);
      },
    );
    const notified = new Promise<void>((resolve) =>
      connection.client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        async () => resolve(),
      ),
    );
    // Upstream GET installation is observed by delivering a request and waiting for its reply after release.
    await fixture.notify();
    open();
    await Promise.race([
      notified,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("notification lost before GET")),
          2000,
        ),
      ),
    ]);
    for (let i = 0; i < 100 && !fixture.receivedRoots; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.ok(fixture.receivedRoots);
    await connection.close();
  } finally {
    open();
    await env.close();
    await fixture.close();
  }
});

test("OAuth replacement during exchange discards stale tokens and denial clears only matching profile state", async () => {
  const fixture = await httpFixture(true);
  const env = await setup();
  try {
    fixture.callback = env.daemon.url + "/oauth/callback";
    const { data: p } = await env.api("/api/providers", "POST", {
      name: "OAuth",
      slug: "race",
      transport: { type: "http", url: fixture.base + "/mcp" },
    });
    const create = async (slug: string) =>
      (
        await env.api(`/api/providers/${p.provider.id}/profiles`, "POST", {
          name: slug,
          slug,
          auth: { type: "oauth" },
        })
      ).data;
    const a = await create("a"),
      b = await create("b");
    const start = async (id: string) =>
      new URL(
        (await env.api(`/api/profiles/${id}/oauth/start`, "POST")).data
          .authorizationUrl,
      );
    const aa = await start(a.profile.id),
      bb = await start(b.profile.id);
    fixture.challenge = aa.searchParams.get("code_challenge")!;
    const paused = fixture.pauseExchange();
    const callback = fetch(
      `${env.daemon.url}/oauth/callback?state=${aa.searchParams.get("state")}&code=fake`,
    );
    await paused.started;
    await env.api(`/api/profiles/${a.profile.id}`, "PATCH", {
      auth: { type: "oauth", clientId: "replacement" },
    });
    paused.release();
    assert.equal((await callback).status, 409);
    let profiles = (await env.api(`/api/providers/${p.provider.id}/profiles`))
      .data.profiles;
    assert.ok(
      profiles.every(
        (profile: { status: string }) => profile.status === "needs_auth",
      ),
    );
    const denied = `${env.daemon.url}/oauth/callback?state=${bb.searchParams.get("state")}&error=access_denied&error_description=SECRET`;
    const response = await fetch(denied);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Authorization was denied/);
    assert.equal((await fetch(denied)).status, 400);
    // Profile B's independent PKCE flow still succeeds after A's auth replacement.
    const retry = await start(b.profile.id);
    fixture.challenge = retry.searchParams.get("code_challenge")!;
    assert.equal(
      (
        await fetch(
          `${env.daemon.url}/oauth/callback?state=${retry.searchParams.get("state")}&code=fake`,
        )
      ).status,
      200,
    );
    profiles = (await env.api(`/api/providers/${p.provider.id}/profiles`)).data
      .profiles;
    assert.equal(
      profiles.find((profile: { id: string }) => profile.id === a.profile.id)
        .status,
      "needs_auth",
    );
    assert.equal(
      profiles.find((profile: { id: string }) => profile.id === b.profile.id)
        .status,
      "ready",
    );
  } finally {
    await env.close();
    await fixture.close();
  }
});

test("unsolicited queue overflow closes the session instead of silently dropping messages", async () => {
  const fixture = await httpFixture();
  const env = await setup();
  try {
    const { data: p } = await env.api("/api/providers", "POST", {
      name: "HTTP",
      slug: "overflow",
      transport: { type: "http", url: fixture.base + "/mcp" },
    });
    const { data: a } = await env.api(
      `/api/providers/${p.provider.id}/profiles`,
      "POST",
      { name: "A", slug: "a", auth: { type: "none" } },
    );
    const connection = await connect(
      a.profile.endpoint,
      a.accessToken,
      async (url, init) =>
        init?.method === "GET"
          ? new Response(null, { status: 405 })
          : fetch(url, init),
    );
    assert.equal(env.daemon.sessionCount(), 1);
    for (let i = 0; i < 65; i++) await fixture.notify();
    for (let i = 0; i < 100 && env.daemon.sessionCount(); i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(env.daemon.sessionCount(), 0);
    await connection.close();
  } finally {
    await env.close();
    await fixture.close();
  }
});
