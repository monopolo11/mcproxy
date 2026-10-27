import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "../src/server.js";
import { gitSource, UpdateError, type UpdateSource } from "../src/update.js";
import { parseVersion, type Release } from "../src/version.js";

const release = (tag: string): Release => {
  const version = parseVersion(tag);
  assert.ok(version);
  return { version, url: `https://github.com/o/r/releases/tag/${tag}` };
};

/** A checkout at `tag` that sees `tags` published and records what it is asked to do. */
function fakeSource(tag: string, tags: string[]) {
  const version = parseVersion(tag);
  assert.ok(version);
  let restarted!: () => void;
  const calls = {
    installed: [] as string[],
    restarted: new Promise<void>((resolve) => (restarted = resolve)),
  };
  const source: UpdateSource = {
    installed: async () => ({ kind: "release", version, commit: "0123456789abcdef" }),
    releases: async () => tags.map(release),
    contains: async () => false,
    install: async (target) => void calls.installed.push(target),
    restart: async () => restarted(),
  };
  return { source, calls };
}

async function daemon(dir: string, updates: UpdateSource) {
  const server = await createProxyServer({ stateDir: dir, port: 0, updates });
  const api = async (path: string, method = "GET", value?: unknown, marker = true) => {
    const response = await fetch(server.url + path, {
      method,
      headers: {
        ...(marker ? { "X-Mcproxy-Request": "1" } : {}),
        "Content-Type": "application/json",
      },
      ...(value ? { body: JSON.stringify(value) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return { server, api };
}

test("update API offers the channel's release, keeps the channel across restarts and applies it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcproxy-update-"));
  const { source, calls } = fakeSource("v0.1.4-nightly.20261027.9", [
    "v0.1.3",
    "v0.1.4-nightly.20261028.1",
  ]);
  try {
    const first = await daemon(dir, source);
    await first.api("/api/update/check", "POST");
    const initial = await first.api("/api/update");
    assert.equal(initial.data.channel, "stable");
    assert.equal(initial.data.version, "0.1.4-nightly.20261027.9");
    assert.equal(initial.data.available, undefined, "stable never downgrades a nightly");
    assert.equal((await first.api("/api/health")).data.version, "0.1.4-nightly.20261027.9");

    assert.equal((await first.api("/api/update", "PATCH", { channel: "nightly" }, false)).status, 403);
    assert.equal((await first.api("/api/update", "PATCH", { channel: "beta" })).status, 400);
    const nightly = await first.api("/api/update", "PATCH", { channel: "nightly" });
    assert.equal(nightly.data.available.version, "0.1.4-nightly.20261028.1");
    await first.server.close();

    const second = await daemon(dir, source);
    assert.equal((await second.api("/api/update")).data.channel, "nightly");
    const applied = await second.api("/api/update/apply", "POST");
    assert.equal(applied.status, 202);
    assert.equal(applied.data.applying, true);
    await calls.restarted;
    assert.deepEqual(calls.installed, ["v0.1.4-nightly.20261028.1"]);
    await second.server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a check that cannot reach GitHub says why and offers nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcproxy-update-"));
  const { source } = fakeSource("v0.1.3", []);
  source.releases = async () => {
    throw new UpdateError("Can't check for updates: install gh");
  };
  const { server, api } = await daemon(dir, source);
  try {
    const { data } = await api("/api/update/check", "POST");
    assert.equal(data.checkError, "Can't check for updates: install gh");
    assert.equal(data.available, undefined);
    assert.equal((await api("/api/update/apply", "POST")).status, 409);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("git source reads the release at HEAD and restores it when the new build fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcproxy-git-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  const author = ["-c", "user.name=t", "-c", "user.email=t@example.test"];
  try {
    const origin = join(dir, "origin.git");
    const work = join(dir, "work");
    git(dir, "init", "--quiet", "--bare", origin);
    git(dir, "clone", "--quiet", origin, work);
    await writeFile(join(work, "package.json"), JSON.stringify({ scripts: { build: "node build.mjs" } }));
    await writeFile(join(work, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(work, "build.mjs"), "");
    git(work, "add", ".");
    git(work, ...author, "commit", "--quiet", "-m", "one");
    git(work, "tag", "v0.1.0");
    await writeFile(join(work, "build.mjs"), "process.exit(1)");
    git(work, ...author, "commit", "--quiet", "-am", "broken");
    git(work, "tag", "v0.1.1");
    git(work, "push", "--quiet", "origin", "HEAD", "--tags");
    git(work, "checkout", "--quiet", "--detach", "v0.1.0");
    git(work, "tag", "-d", "v0.1.1");

    const source = gitSource(work, async () => {});
    const installed = await source.installed();
    assert.equal(installed.kind === "release" && installed.version.tag, "v0.1.0");
    await writeFile(join(work, "build.mjs"), "// edited");
    assert.deepEqual(await source.installed(), {
      kind: "development",
      commit: git(work, "rev-parse", "HEAD"),
      branch: undefined,
      dirty: true,
    });
    git(work, "checkout", "--quiet", "build.mjs");

    await assert.rejects(source.install("v0.1.1"), {
      name: "UpdateError",
      message: "pnpm build failed for v0.1.1; restored v0.1.0",
    });
    assert.deepEqual(git(work, "tag", "--points-at", "HEAD").split("\n"), ["v0.1.0"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
