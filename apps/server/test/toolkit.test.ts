import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createProxyServer } from "../src/server.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "mcproxy-toolkit-"));
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
  const stdio = {
    type: "stdio",
    command: process.execPath,
    args: [resolve("test/stdio-fixture.mjs")],
  };
  async function profile(providerId: string, slug: string, identity: string) {
    const { data } = await api(`/api/providers/${providerId}/profiles`, "POST", {
      name: slug,
      slug,
      auth: { type: "env", env: { IDENTITY: identity } },
    });
    return data.profile.id as string;
  }
  return {
    daemon,
    api,
    stdio,
    profile,
    async close() {
      await daemon.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function connect(endpoint: string, token: string) {
  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport, { timeout: 5000 });
  return {
    client,
    async close() {
      await transport.terminateSession().catch(() => {});
      await client.close();
    },
  };
}
const names = async (client: Client) =>
  (await client.listTools()).tools.map((t) => t.name).sort();
const text = async (client: Client, name: string) =>
  (await client.callTool({ name })).content;

test("toolkits merge member tools under provider or provider_profile prefixes behind one token", async () => {
  const env = await setup();
  try {
    const { data: linear } = await env.api("/api/providers", "POST", {
      name: "Linear",
      slug: "linear",
      transport: env.stdio,
    });
    const { data: notes } = await env.api("/api/providers", "POST", {
      name: "Notes",
      slug: "my-notes",
      transport: env.stdio,
    });
    const acme = await env.profile(linear.provider.id, "acme", "F");
    const personal = await env.profile(linear.provider.id, "personal", "P");
    const main = await env.profile(notes.provider.id, "main", "N");

    const created = await env.api("/api/toolkits", "POST", {
      name: "Work",
      slug: "work",
      profileIds: [acme, personal, main],
    });
    assert.equal(created.response.status, 201);
    const kit = created.data.toolkit;
    assert.equal(kit.endpoint, `${env.daemon.url}/toolkits/work`);
    assert.deepEqual(
      kit.members.map((m: { profileId: string; prefix: string }) => [m.profileId, m.prefix]),
      [
        [acme, "linear_acme_"],
        [personal, "linear_personal_"],
        [main, "my_notes_"],
      ],
    );
    assert.equal((await fetch(kit.endpoint, { method: "GET" })).status, 401);

    const session = await connect(kit.endpoint, created.data.accessToken);
    assert.deepEqual(await names(session.client), [
      "linear_acme_identity",
      "linear_personal_identity",
      "my_notes_identity",
    ]);
    assert.deepEqual(await text(session.client, "linear_acme_identity"), [
      { type: "text", text: "F" },
    ]);
    assert.deepEqual(await text(session.client, "linear_personal_identity"), [
      { type: "text", text: "P" },
    ]);
    assert.deepEqual(await text(session.client, "my_notes_identity"), [
      { type: "text", text: "N" },
    ]);
    await assert.rejects(session.client.callTool({ name: "linear_identity" }), {
      code: -32602,
    });
    assert.equal(env.daemon.sessionCount(), 1);

    // Calling before listing resolves the name on demand.
    const fresh = await connect(kit.endpoint, created.data.accessToken);
    assert.deepEqual(await text(fresh.client, "my_notes_identity"), [
      { type: "text", text: "N" },
    ]);
    await fresh.close();

    const tested = await env.api(`/api/toolkits/${kit.id}/test`, "POST");
    assert.deepEqual(
      tested.data.members.map((m: { ok: boolean; tools: string[] }) => [m.ok, m.tools]),
      [
        [true, ["linear_acme_identity"]],
        [true, ["linear_personal_identity"]],
        [true, ["my_notes_identity"]],
      ],
    );

    // Dropping to one Linear profile collapses its prefix and restarts sessions.
    const patched = await env.api(`/api/toolkits/${kit.id}`, "PATCH", {
      profileIds: [acme, main],
    });
    assert.deepEqual(
      patched.data.toolkit.members.map((m: { prefix: string }) => m.prefix),
      ["linear_", "my_notes_"],
    );
    assert.equal(env.daemon.sessionCount(), 0);
    await assert.rejects(session.client.listTools());
    const again = await connect(kit.endpoint, created.data.accessToken);
    assert.deepEqual(await names(again.client), ["linear_identity", "my_notes_identity"]);

    // Deleting a member profile removes it and closes sessions that used it.
    await env.api(`/api/profiles/${main}`, "DELETE");
    assert.equal(env.daemon.sessionCount(), 0);
    const listed = await env.api("/api/toolkits");
    assert.deepEqual(
      listed.data.toolkits[0].members.map((m: { profileId: string }) => m.profileId),
      [acme],
    );

    // Token reveal needs the marker; rotation invalidates the old token.
    assert.equal(
      (await fetch(`${env.daemon.url}/api/toolkits/${kit.id}/token`)).status,
      403,
    );
    assert.equal(
      (await env.api(`/api/toolkits/${kit.id}/token`)).data.accessToken,
      created.data.accessToken,
    );
    const rotated = await env.api(`/api/toolkits/${kit.id}/token`, "POST");
    assert.notEqual(rotated.data.accessToken, created.data.accessToken);
    assert.equal(
      (
        await fetch(kit.endpoint, {
          headers: { Authorization: `Bearer ${created.data.accessToken}` },
        })
      ).status,
      401,
    );
    const last = await connect(kit.endpoint, rotated.data.accessToken);
    assert.deepEqual(await names(last.client), ["linear_identity"]);
    await last.close();
    assert.equal(env.daemon.sessionCount(), 0);

    assert.equal((await env.api(`/api/toolkits/${kit.id}`, "DELETE")).response.status, 204);
    assert.equal(
      (
        await fetch(kit.endpoint, {
          headers: { Authorization: `Bearer ${rotated.data.accessToken}` },
        })
      ).status,
      404,
    );
    assert.ok(!JSON.stringify(listed.data).includes("tokenHash"));
  } finally {
    await env.close();
  }
});

test("toolkit members must exist and slugs are unique", async () => {
  const env = await setup();
  try {
    const missing = await env.api("/api/toolkits", "POST", {
      name: "Bad",
      slug: "bad",
      profileIds: ["nope"],
    });
    assert.equal(missing.response.status, 400);
    assert.equal(missing.data.error.code, "invalid_member");
    assert.equal((await env.api("/api/toolkits", "POST", { name: "A", slug: "a", profileIds: [] })).response.status, 201);
    assert.equal((await env.api("/api/toolkits", "POST", { name: "B", slug: "a", profileIds: [] })).response.status, 409);
  } finally {
    await env.close();
  }
});
