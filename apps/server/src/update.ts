/**
 * Release-based updates. The daemon runs from a git checkout and a release is
 * a tag (see `version.ts`). `Updater` owns the channel setting and the cached
 * check behind `/api/update`; `gitSource` reads the checkout, lists releases
 * on GitHub and moves the checkout to a tag. Tests inject an `UpdateSource`.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { AppError } from "./model.js";
import { logger, reason } from "./log.js";
import { restartService } from "./startup.js";
import type { Store } from "./store.js";
import {
  channels,
  formatVersion,
  highest,
  parseVersion,
  selectUpdate,
  tracksMain,
  type Channel,
  type Installed,
  type Release,
} from "./version.js";

const log = logger("update");

/** The checkout and GitHub, as the updater sees them. */
export interface UpdateSource {
  /** Throws `UpdateError` when the daemon does not run from a git checkout. */
  installed(): Promise<Installed>;
  /** Published releases with a version tag. Throws `UpdateError` when GitHub can't be asked. */
  releases(): Promise<Release[]>;
  /** Whether `tag` contains `commit`, so moving there drops nothing. */
  contains(tag: string, commit: string): Promise<boolean>;
  /** Checks out `tag` and builds it, restoring the previous checkout on failure. */
  install(tag: string): Promise<void>;
  /** Replaces this process with the freshly built daemon. */
  restart(): Promise<void>;
}

/** A failure whose message is safe and useful to show in the UI. */
export class UpdateError extends Error {
  override name = "UpdateError";
}

/** `GET /api/update`. */
export interface UpdateStatus {
  /** Release version at HEAD; absent for a development build. */
  version?: string;
  /** Short commit at HEAD. */
  commit?: string;
  /** Tracked files differ from HEAD. */
  modified: boolean;
  /** Whether this checkout is offered updates: releases and a clean `main`. */
  updatable: boolean;
  channel: Channel;
  available?: { version: string; url: string };
  checkedAt?: string;
  /** Why the last check could not run. */
  checkError?: string;
  applying: boolean;
  /** Why the last update failed; the previous version was restored. */
  applyError?: string;
}

export const updatePatch = z.object({ channel: z.enum(channels) });

const channelSetting = "updateChannel";
const isChannel = (value: string | undefined): value is Channel =>
  channels.some((channel) => channel === value);

/**
 * Checks on start, then hourly, and caches the result. The channel is read at
 * status time, so switching it needs no new check.
 */
export class Updater {
  private installed?: Installed;
  private releases: Release[] = [];
  /** For a `main` checkout: whether the latest stable contains it. */
  private reachable = false;
  private checkedAt?: string;
  private checkError?: string;
  private applying = false;
  private applyError?: string;
  private running?: Promise<void>;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly source: UpdateSource,
    private readonly store: Store,
    every = 60 * 60 * 1000,
  ) {
    this.timer = setInterval(() => void this.check(), every).unref();
  }

  get channel(): Channel {
    const stored = this.store.setting(channelSetting);
    return isChannel(stored) ? stored : "stable";
  }

  setChannel(channel: Channel) {
    this.store.setSetting(channelSetting, channel);
  }

  /**
   * Re-reads the checkout and the releases; concurrent calls share one run.
   * Skipped while an update moves the checkout.
   */
  check(): Promise<void> {
    if (this.applying) return Promise.resolve();
    this.running ??= this.refresh().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async refresh() {
    try {
      const installed = await this.source.installed();
      this.installed = installed;
      const updatable = installed.kind === "release" || tracksMain(installed);
      this.releases = updatable ? await this.source.releases() : [];
      const stable = selectUpdate(installed, "stable", this.releases);
      this.reachable =
        installed.kind === "development" && stable !== undefined
          ? await this.source.contains(stable.version.tag, installed.commit)
          : false;
      this.checkError = undefined;
    } catch (error) {
      this.releases = [];
      this.checkError =
        error instanceof UpdateError ? error.message : "Could not check for updates";
      log.warn("check failed", { error: reason(error) });
    }
    this.checkedAt = new Date().toISOString();
  }

  /** The release to offer on the current channel, if any. */
  private offer() {
    const installed = this.installed;
    if (!installed) return undefined;
    const release = selectUpdate(installed, this.channel, this.releases);
    return installed.kind === "development" && !this.reachable ? undefined : release;
  }

  status(): UpdateStatus {
    const installed = this.installed;
    const offer = this.offer();
    return {
      version:
        installed?.kind === "release" ? formatVersion(installed.version) : undefined,
      commit: installed?.commit.slice(0, 7),
      modified: installed?.kind === "development" && installed.dirty,
      updatable:
        installed !== undefined &&
        (installed.kind === "release" || tracksMain(installed)),
      channel: this.channel,
      available: offer && { version: formatVersion(offer.version), url: offer.url },
      checkedAt: this.checkedAt,
      checkError: this.checkError,
      applying: this.applying,
      applyError: this.applyError,
    };
  }

  /**
   * Starts updating to the offered release after a fresh check, so a checkout
   * modified since the last check is refused. Install and restart continue in
   * the background; the UI polls `status()` until the daemon comes back.
   */
  async apply() {
    if (this.applying)
      throw new AppError("update_running", "An update is already running", 409);
    await this.check();
    const target = this.offer();
    if (!target) throw new AppError("no_update", "No update is available", 409);
    this.applying = true;
    this.applyError = undefined;
    const { version, commit } = this.status();
    const to = formatVersion(target.version);
    log.info("updating", { from: version ?? commit, to });
    void this.source
      .install(target.version.tag)
      .then(() => {
        log.info("restarting", { version: to });
        return this.source.restart();
      })
      .catch((error) => {
        this.applying = false;
        this.applyError =
          error instanceof UpdateError ? error.message : `Updating to ${to} failed`;
        log.error("update failed", { to, error: reason(error) });
      });
  }

  dispose() {
    clearInterval(this.timer);
  }
}

const exec = promisify(execFile);

const releasesSchema = z.array(
  z.object({
    tag_name: z.string(),
    html_url: z.string(),
    draft: z.boolean(),
  }),
);

/** `owner/name` from a GitHub remote URL, https or ssh. */
export function githubRepository(remote: string) {
  return /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote.trim())?.[1];
}

/**
 * The real source: the checkout at `root`, whose `origin` is the GitHub repo
 * that publishes releases. GitHub calls are anonymous unless `GH_TOKEN` or
 * `GITHUB_TOKEN` is set.
 */
export function gitSource(root: string, restart: () => Promise<void>): UpdateSource {
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: root, timeout: 120_000 })).stdout.trim();

  /** Runs a build step with its output in the daemon's log. */
  const step = (command: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: root,
        stdio: ["ignore", "inherit", "inherit"],
        // pnpm is a .cmd shim on Windows; the arguments are constants.
        shell: process.platform === "win32",
        // CI keeps pnpm from prompting before it rebuilds node_modules.
        env: { ...process.env, CI: "true" },
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
      );
    });

  let repository: string | undefined;
  const github = async (path: string): Promise<unknown> => {
    repository ??= githubRepository(await git("remote", "get-url", "origin"));
    if (!repository) throw new UpdateError("origin is not a GitHub repository");
    // Anonymous calls allow 60 requests an hour per IP; a token lifts that
    // for networks where many daemons share one address.
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "mcproxy",
      },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {
      throw new UpdateError("Can't check for updates: GitHub is unreachable");
    });
    if (!response.ok)
      throw new UpdateError(
        response.status === 403 || response.status === 429
          ? "Can't check for updates: GitHub rate limit reached. Set GITHUB_TOKEN in .env to raise it"
          : `Can't check for updates: GitHub answered HTTP ${response.status} for ${repository}`,
      );
    return response.json();
  };

  return {
    async installed() {
      const commit = await git("rev-parse", "HEAD").catch(() => {
        throw new UpdateError("Can't check for updates: the daemon does not run from a git checkout");
      });
      const [tags, branch, changes] = await Promise.all([
        git("tag", "--points-at", "HEAD"),
        git("symbolic-ref", "--quiet", "--short", "HEAD").catch(() => ""),
        git("status", "--porcelain", "--untracked-files=no"),
      ]);
      const dirty = changes !== "";
      // A nightly cut from a stable commit carries both tags; the higher one
      // keeps nightly from offering the same commit again.
      const version = highest(
        tags.split("\n").flatMap((tag) => parseVersion(tag) ?? []),
        (v) => v,
      );
      return version && !dirty
        ? { kind: "release", version, commit }
        : { kind: "development", commit, branch: branch || undefined, dirty };
    },

    async releases() {
      return releasesSchema
        .parse(await github("releases?per_page=100"))
        .flatMap((release) => {
          const version = release.draft ? undefined : parseVersion(release.tag_name);
          return version ? [{ version, url: release.html_url }] : [];
        });
    },

    async contains(tag, commit) {
      try {
        const compare = z
          .object({ status: z.string() })
          .parse(await github(`compare/${commit}...${tag}`));
        return compare.status === "ahead" || compare.status === "identical";
      } catch {
        return false;
      }
    },

    async install(tag) {
      const branch = await git("symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "");
      const previous = branch || (await git("rev-parse", "HEAD"));
      const label =
        branch ||
        (await git("describe", "--tags", "--exact-match", "HEAD").catch(() => previous.slice(0, 7)));
      await git("fetch", "--tags", "origin").catch(() => {
        throw new UpdateError("Could not fetch release tags from origin");
      });
      const lockfile = (ref: string) => git("rev-parse", `${ref}:pnpm-lock.yaml`);
      const reinstall = (await lockfile("HEAD")) !== (await lockfile(tag));
      let stage = "checkout";
      try {
        await git("checkout", "--quiet", "--detach", tag);
        if (reinstall) {
          stage = "pnpm install";
          await step("pnpm", ["install", "--frozen-lockfile"]);
        }
        stage = "pnpm build";
        await step("pnpm", ["build"]);
      } catch (error) {
        log.error("install failed", { tag, stage, error: reason(error) });
        try {
          await git("checkout", "--quiet", previous);
          if (stage !== "checkout") {
            if (reinstall) await step("pnpm", ["install", "--frozen-lockfile"]);
            await step("pnpm", ["build"]);
          }
        } catch (rollback) {
          log.error("rollback failed", { previous, error: reason(rollback) });
          throw new UpdateError(
            `${stage} failed for ${tag}, and restoring ${label} failed too. Run \`git checkout ${previous} && pnpm install && pnpm build\`, then restart`,
          );
        }
        throw new UpdateError(`${stage} failed for ${tag}; restored ${label}`);
      }
    },

    restart,
  };
}

/**
 * Restarts the daemon after an update: through the login service when it
 * runs this process, else by closing the server and respawning the same
 * command line detached. A respawned foreground daemon outlives its terminal
 * session's `pnpm start`, so stop it by pid afterwards.
 */
export async function relaunch(close: () => Promise<void>) {
  if (await restartService()) return;
  await close();
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    detached: true,
    stdio: "inherit",
  });
  log.info("respawned", { pid: child.pid });
  child.unref();
  process.exit(0);
}
