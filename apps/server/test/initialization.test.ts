import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { createProxyServer } from "../src/server.js";

for (const failure of [
  { status: 406, accept: "application/json", contentType: "application/json" },
  { status: 415, accept: "application/json, text/event-stream", contentType: "text/plain" },
]) {
  test(`rejected initialization (${failure.status}) releases its session and stdio process`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcproxy-initialize-"));
    const daemon = await createProxyServer({ stateDir: dir, port: 0 });
    const pidFile = join(dir, "child.pid");
    const create = async (path: string, value: unknown) => {
      const response = await fetch(daemon.url + path, {
        method: "POST",
        headers: { "X-Mcproxy-Request": "1", "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      assert.equal(response.status, 201);
      return response.json();
    };
    try {
      const { provider } = z.object({ provider: z.object({ id: z.string() }) }).parse(
        await create("/api/providers", {
          name: "Fixture", slug: "fixture",
          transport: { type: "stdio", command: process.execPath, args: [fileURLToPath(new URL("./stdio-fixture.mjs", import.meta.url))] },
        }),
      );
      const { profile, accessToken } = z.object({
        profile: z.object({ endpoint: z.string() }), accessToken: z.string(),
      }).parse(await create(`/api/providers/${provider.id}/profiles`, {
        name: "A", slug: "a", auth: { type: "env", env: { PID_FILE: pidFile } },
      }));
      const response = await fetch(profile.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: failure.accept, "Content-Type": failure.contentType },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }),
      });
      assert.equal(response.status, failure.status);
      assert.equal(response.headers.get("mcp-session-id"), null);
      await response.text();
      // Teardown can complete just after the HTTP error is flushed.
      for (let i = 0; i < 100 && daemon.sessionCount() !== 0; i++) await setTimeout(10);
      assert.equal(daemon.sessionCount(), 0);
      const pid = await readFile(pidFile, "utf8").then(Number, () => undefined);
      if (pid) {
        const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
        for (let i = 0; i < 100 && alive(); i++) await setTimeout(10);
        assert.equal(alive(), false);
      }
    } finally {
      await daemon.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
