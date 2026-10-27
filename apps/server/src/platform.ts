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
/** The daemon's port: PORT when set, else the default. Throws on an invalid value. */
export function portFromEnv(value = process.env.PORT): number {
  if (!value) return defaultPort;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be between 1 and 65535");
  return port;
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
