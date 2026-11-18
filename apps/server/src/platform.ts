import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, lstat } from "node:fs/promises";
export interface CredentialStore {
  loadKey(stateDir: string): Promise<Buffer>;
}
export interface Platform {
  stateDirectory(): string;
  credentials: CredentialStore;
}
export const fileCredentials: CredentialStore = {
  async loadKey(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const path = join(dir, "master.key");
    try {
      await writeFile(path, randomBytes(32), { mode: 0o600, flag: "wx" });
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
    }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error("Key file must be an owner-only regular file");
    const key = await readFile(path);
    if (key.length !== 32) throw new Error("Invalid encryption key");
    return key;
  },
};
export const defaultPort = 7433;
/** Default loopback port of the listener that `tailscale serve` forwards to. */
export const defaultTailnetPort = 7434;
function parsePort(value: string | undefined, fallback: number, name: string) {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name} must be between 1 and 65535`);
  return port;
}
/** The daemon's port: PORT when set, else the default. Throws on an invalid value. */
export function portFromEnv(value = process.env.PORT): number {
  return parsePort(value, defaultPort, "PORT");
}
/**
 * A `tailscale serve` front for the daemon. It forwards to a loopback listener
 * on `port`, separate from the daemon's own, so only requests arriving there
 * are tailnet requests. Those need Host and Origin from `origin` and serve's
 * `Tailscale-User-Login` equal to `user`.
 */
export interface Tailnet {
  origin: string;
  user: string;
  port: number;
}
/**
 * The tailnet front from MCPROXY_TAILNET_ORIGIN, MCPROXY_TAILNET_USER and the
 * optional MCPROXY_TAILNET_PORT, or undefined when origin and user are unset.
 * Throws when only one is set, the origin is not a bare https origin, or the
 * port is invalid.
 */
export function tailnetFromEnv(
  origin = process.env.MCPROXY_TAILNET_ORIGIN,
  user = process.env.MCPROXY_TAILNET_USER,
  port = process.env.MCPROXY_TAILNET_PORT,
): Tailnet | undefined {
  if (!origin && !user) return undefined;
  if (!origin || !user)
    throw new Error(
      "MCPROXY_TAILNET_ORIGIN and MCPROXY_TAILNET_USER must be set together",
    );
  const url = URL.canParse(origin) ? new URL(origin) : undefined;
  if (url?.protocol !== "https:" || url.origin !== origin.replace(/\/$/, ""))
    throw new Error(
      "MCPROXY_TAILNET_ORIGIN must be an https origin, e.g. https://box.example.ts.net",
    );
  return {
    origin: url.origin,
    user,
    port: parsePort(port, defaultTailnetPort, "MCPROXY_TAILNET_PORT"),
  };
}
export const localPlatform: Platform = {
  stateDirectory: () =>
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "mcproxy")
      : process.platform === "win32"
        ? join(process.env.LOCALAPPDATA ?? homedir(), "mcproxy")
        : join(
            process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
            "mcproxy",
          ),
  credentials: fileCredentials,
};
export class Vault {
  constructor(private readonly key: Buffer) {}
  seal(value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      "base64",
    );
  }
  open<T>(value: string): T {
    const data = Buffer.from(value, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      data.subarray(0, 12),
    );
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(data.subarray(28)),
        cipher.final(),
      ]).toString(),
    ) as T;
  }
}
