import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  nextTag,
  parseVersion,
  selectUpdate,
  type Installed,
  type Release,
} from "../src/version.js";

const v = (tag: string) => {
  const version = parseVersion(tag);
  assert.ok(version, tag);
  return version;
};
const release = (tag: string): Release => ({ version: v(tag), url: `https://example.test/${tag}` });
const at = (tag: string): Installed => ({ kind: "release", version: v(tag), commit: "abc" });
const offered = (installed: Installed, channel: "stable" | "nightly", tags: string[]) =>
  selectUpdate(installed, channel, tags.map(release))?.version.tag;

test("parses stable and nightly tags and rejects anything else", () => {
  assert.deepEqual(v("v1.2.3"), { tag: "v1.2.3", major: 1, minor: 2, patch: 3 });
  assert.deepEqual(v("v0.1.4-nightly.20261027.12").nightly, { date: 20261027, run: 12 });
  for (const tag of ["1.2.3", "v1.2", "v1.2.3-beta.1", "v1.2.3-nightly.2026102.1", "v1.2.3 "])
    assert.equal(parseVersion(tag), undefined, tag);
});

test("a nightly sorts between the stable before it and the stable it leads to", () => {
  const order = [
    "v0.1.3",
    "v0.1.4-nightly.20261027.9",
    "v0.1.4-nightly.20261027.10",
    "v0.1.4-nightly.20261028.2",
    "v0.1.4",
    "v0.2.0",
    "v1.0.0",
  ];
  const shuffled = [...order].reverse().map(v);
  assert.deepEqual(shuffled.sort(compareVersions).map((x) => x.tag), order);
});

test("stable sees stable releases only, nightly takes the highest of both", () => {
  const tags = ["v0.1.3", "v0.1.4-nightly.20261027.9", "v0.1.2"];
  assert.equal(offered(at("v0.1.2"), "stable", tags), "v0.1.3");
  assert.equal(offered(at("v0.1.2"), "nightly", tags), "v0.1.4-nightly.20261027.9");
  assert.equal(offered(at("v0.1.3"), "stable", tags), undefined);
});

test("never offers a downgrade, so leaving nightly waits for a newer stable", () => {
  const nightly = at("v0.1.4-nightly.20261027.9");
  assert.equal(offered(nightly, "stable", ["v0.1.3"]), undefined);
  assert.equal(offered(nightly, "nightly", ["v0.1.3", "v0.1.4-nightly.20261026.1"]), undefined);
  assert.equal(offered(nightly, "stable", ["v0.1.3", "v0.1.4"]), "v0.1.4");
});

test("development builds get nothing, except a clean main, which gets the latest stable", () => {
  const tags = ["v0.1.3", "v0.1.4-nightly.20261027.9"];
  const dev = { kind: "development", commit: "abc", dirty: false } as const;
  assert.equal(offered(dev, "stable", tags), undefined);
  assert.equal(offered({ ...dev, branch: "feature" }, "nightly", tags), undefined);
  assert.equal(offered({ ...dev, branch: "main", dirty: true }, "stable", tags), undefined);
  assert.equal(offered({ ...dev, branch: "main" }, "nightly", tags), "v0.1.3");
});

test("release tags: stable bumps the patch, nightly targets the next stable", () => {
  const date = new Date("2026-10-27T23:30:00Z");
  assert.deepEqual(nextTag("stable", [], date, 1), { tag: "v0.1.0", previous: undefined });
  assert.deepEqual(nextTag("nightly", ["junk"], date, 4), {
    tag: "v0.1.0-nightly.20261027.4",
    previous: undefined,
  });
  const tags = ["v0.1.9", "v0.1.10", "v0.1.11-nightly.20261020.3", "v0.1.11-nightly.20261026.7", "v0.1.2"];
  assert.deepEqual(nextTag("stable", tags, date, 8), { tag: "v0.1.11", previous: "v0.1.10" });
  assert.deepEqual(nextTag("nightly", tags, date, 8), {
    tag: "v0.1.11-nightly.20261027.8",
    previous: "v0.1.11-nightly.20261026.7",
  });
});
