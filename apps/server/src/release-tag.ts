/**
 * `tsx src/release-tag.ts <stable|nightly>`: prints the tag the release
 * workflow publishes next as `key=value` lines for `$GITHUB_OUTPUT`: `tag`,
 * `previous` (where the notes start, empty for the first) and `skip`, which
 * is true when stable finds HEAD already tagged. Nightlies are numbered by
 * `RUN_NUMBER`. Run it in a checkout with every tag fetched.
 */
import { execFileSync } from "node:child_process";
import { channels, nextTag, parseVersion, type Channel } from "./version.js";

const isChannel = (value: string | undefined): value is Channel =>
  channels.some((channel) => channel === value);

const channel = process.argv[2];
const run = Number(process.env.RUN_NUMBER);
if (!isChannel(channel) || (channel === "nightly" && !Number.isInteger(run))) {
  console.error("usage: RUN_NUMBER=<n> tsx src/release-tag.ts <stable|nightly>");
  process.exit(2);
}
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);

const { tag, previous } = nextTag(channel, git("tag", "--list", "v*"), new Date(), run);
const tagged = git("tag", "--points-at", "HEAD").some((existing) => {
  const version = parseVersion(existing);
  return version !== undefined && !version.nightly;
});
console.log(`tag=${tag}`);
console.log(`previous=${previous ?? ""}`);
console.log(`skip=${channel === "stable" && tagged}`);
