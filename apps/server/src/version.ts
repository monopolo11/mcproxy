/**
 * Release versions and channels. Tags are the only source of a version:
 * stable releases are `vX.Y.Z`, nightlies `vX.Y.Z-nightly.YYYYMMDD.N` where
 * `X.Y.Z` is the stable that will follow them. The release workflow names
 * tags with `nextTag`; the daemon picks updates with `selectUpdate`.
 */

export const channels = ["stable", "nightly"] as const;
export type Channel = (typeof channels)[number];

export interface Version {
  tag: string;
  major: number;
  minor: number;
  patch: number;
  /** Present on nightlies: the build date as YYYYMMDD and the workflow run. */
  nightly?: { date: number; run: number };
}

/** A published GitHub Release whose tag parsed as a version. */
export interface Release {
  version: Version;
  url: string;
}

const pattern = /^v(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d{8})\.(\d+))?$/;

/** Parses a release tag; anything else, including `v1.2`, is undefined. */
export function parseVersion(tag: string): Version | undefined {
  const match = pattern.exec(tag);
  if (!match) return undefined;
  const [, major, minor, patch, date, run] = match;
  return {
    tag,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    ...(date && run ? { nightly: { date: Number(date), run: Number(run) } } : {}),
  };
}

/**
 * Semver order: a nightly sorts below the stable of the same `X.Y.Z` and
 * above every earlier stable; nightlies order by date, then run.
 */
export function compareVersions(a: Version, b: Version): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  if (a.nightly && b.nightly)
    return a.nightly.date - b.nightly.date || a.nightly.run - b.nightly.run;
  return a.nightly ? -1 : b.nightly ? 1 : 0;
}

export const formatVersion = (version: Version) => version.tag.slice(1);

/** The item with the highest version, by `compareVersions`. */
export function highest<T>(items: T[], version: (item: T) => Version): T | undefined {
  return items.reduce<T | undefined>(
    (best, item) =>
      best === undefined || compareVersions(version(item), version(best)) > 0
        ? item
        : best,
    undefined,
  );
}

/** What the daemon runs from. */
export type Installed =
  | { kind: "release"; version: Version; commit: string }
  | {
      kind: "development";
      commit: string;
      /** Checked-out branch; absent when HEAD is detached. */
      branch?: string;
      /** Tracked files differ from HEAD. */
      dirty: boolean;
    };

/** A clean `main` checkout without a release tag may move onto the latest stable. */
export const tracksMain = (installed: Installed) =>
  installed.kind === "development" &&
  !installed.dirty &&
  installed.branch === "main";

/**
 * The release to offer, if any. Stable sees stable releases, nightly sees
 * both and takes the highest. Nothing at or below the installed version is
 * offered, so leaving nightly for stable waits for a newer stable. A clean
 * `main` is offered the latest stable; the caller must still check that it
 * contains `main`, or moving would drop commits. Other development builds get
 * nothing.
 */
export function selectUpdate(
  installed: Installed,
  channel: Channel,
  releases: Release[],
): Release | undefined {
  if (installed.kind === "development")
    return tracksMain(installed)
      ? highest(
          releases.filter((r) => !r.version.nightly),
          (r) => r.version,
        )
      : undefined;
  const best = highest(
    releases.filter((r) => channel === "nightly" || !r.version.nightly),
    (r) => r.version,
  );
  return best && compareVersions(best.version, installed.version) > 0
    ? best
    : undefined;
}

/**
 * The tag a release run publishes, from the repo's existing tags, and the tag
 * its notes start from. Stable bumps the patch of the latest stable (`v0.1.0`
 * when there is none) and compares against that stable. Nightly targets the
 * same next stable, suffixed with the UTC date and run number, and compares
 * against the previous nightly.
 */
export function nextTag(
  channel: Channel,
  tags: string[],
  date: Date,
  run: number,
): { tag: string; previous?: string } {
  const versions = tags.flatMap((tag) => parseVersion(tag) ?? []);
  const stable = highest(
    versions.filter((v) => !v.nightly),
    (v) => v,
  );
  const next = stable
    ? `v${stable.major}.${stable.minor}.${stable.patch + 1}`
    : "v0.1.0";
  if (channel === "stable") return { tag: next, previous: stable?.tag };
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  return {
    tag: `${next}-nightly.${day}.${run}`,
    previous: highest(
      versions.filter((v) => v.nightly),
      (v) => v,
    )?.tag,
  };
}
