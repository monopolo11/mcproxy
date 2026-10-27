/**
 * Registers the built daemon as a per-user login service and manages it, on
 * the platforms T3 Code ships for: a launchd agent on macOS, a systemd user
 * unit on Linux and a `Run` registry entry on Windows. `service.ts` is the
 * CLI (`pnpm service <verb>`); the renderers here are pure so tests can check
 * their quoting.
 *
 * Install snapshots the current node binary, PATH and PORT into the service
 * definition: login services start with a minimal environment, and stdio
 * profiles spawn their commands with the daemon's PATH. The service runs
 * `dist/main.js` with the repo's `.env`, exactly as `pnpm start` does.
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { localPlatform } from "./platform.js";

export const verbs = [
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
  "status",
] as const;
export type Verb = (typeof verbs)[number];

/** Everything a service definition needs to start the daemon like `pnpm start`. */
export interface Target {
  /** Absolute node binary, resolved through version-manager shims. */
  node: string;
  /** `apps/server/dist/main.js`. */
  main: string;
  /** Repo root, the daemon's working directory. */
  cwd: string;
  /** `<repo>/.env`, loaded when present. */
  envFile: string;
  /** PATH the daemon and its stdio children will see. */
  path: string;
  /** PORT override captured at install time. */
  port?: string;
}

export interface Status {
  installed: boolean;
  pid?: number;
}

interface Manager {
  /** Where the service definition lives. */
  definition: string;
  /** Where to read the daemon's output. */
  logs: string;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<Status>;
}

const exec = promisify(execFile);

/** Runs a command, returning its stdout; a non-zero exit rejects. */
const run = async (file: string, args: string[]) =>
  (await exec(file, args)).stdout;

/** Runs a command whose failure is expected and uninteresting. */
const attempt = (file: string, args: string[]) =>
  run(file, args).catch(() => undefined);

/** Describes the daemon next to this file; throws if the web app is not built. */
export function resolveTarget(): Target {
  const dist = dirname(fileURLToPath(import.meta.url));
  const cwd = resolve(dist, "..", "..", "..");
  const port = process.env.PORT;
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535)
      throw new Error("PORT must be between 1 and 65535");
  }
  return {
    node: realpathSync(process.execPath),
    main: join(dist, "main.js"),
    cwd,
    envFile: join(cwd, ".env"),
    path: process.env.PATH ?? "",
    port,
  };
}

/** The daemon's argv after the node binary. */
const daemonArgs = (target: Target) => [
  `--env-file-if-exists=${target.envFile}`,
  target.main,
];

const envOf = (target: Target): Record<string, string> => ({
  PATH: target.path,
  ...(target.port === undefined ? {} : { PORT: target.port }),
});

// macOS: a LaunchAgent. `bootstrap` loads and starts it (RunAtLoad), `bootout`
// stops and unloads it. KeepAlive restarts it after a crash but not after a
// clean stop, which is how the daemon exits on SIGTERM.

export const launchdLabel = "com.mcproxy.daemon";

export function launchdPlist(target: Target, logFile: string): string {
  const s = (text: string) => `<string>${escapeXml(text)}</string>`;
  const env = Object.entries(envOf(target)).map(
    ([key, value]) => `\t\t<key>${escapeXml(key)}</key>\n\t\t${s(value)}`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `\t<key>Label</key>\n\t${s(launchdLabel)}`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    ...[target.node, ...daemonArgs(target)].map((arg) => `\t\t${s(arg)}`),
    "\t</array>",
    `\t<key>WorkingDirectory</key>\n\t${s(target.cwd)}`,
    "\t<key>RunAtLoad</key>\n\t<true/>",
    "\t<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>",
    "\t<key>ThrottleInterval</key>\n\t<integer>10</integer>",
    `\t<key>StandardOutPath</key>\n\t${s(logFile)}`,
    `\t<key>StandardErrorPath</key>\n\t${s(logFile)}`,
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    ...env,
    "\t</dict>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** The pid in `launchctl print` output, if the service is running. */
export function launchdPid(printOutput: string): number | undefined {
  const match = /^\s*pid = (\d+)/m.exec(printOutput);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function launchd(target: Target): Manager {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("launchd needs a user id");
  const domain = `gui/${uid}`;
  const service = `${domain}/${launchdLabel}`;
  const definition = join(
    homedir(),
    "Library",
    "LaunchAgents",
    `${launchdLabel}.plist`,
  );
  const logs = join(homedir(), "Library", "Logs", "mcproxy", "mcproxy.log");
  const loaded = async () =>
    (await attempt("launchctl", ["print", service])) !== undefined;
  // bootout returns before the old instance is gone, and bootstrapping the
  // same label again fails with EIO until it is, so wait for launchd.
  const stop = async () => {
    await attempt("launchctl", ["bootout", service]);
    for (let i = 0; i < 50 && (await loaded()); i++) await setTimeout(200);
  };
  const start = async () => {
    if (!existsSync(definition)) throw new Error("Not installed");
    await attempt("launchctl", ["enable", service]);
    await run("launchctl", ["bootstrap", domain, definition]);
  };
  return {
    definition,
    logs,
    async install() {
      await mkdir(dirname(definition), { recursive: true });
      await mkdir(dirname(logs), { recursive: true });
      await stop();
      await writeFile(definition, launchdPlist(target, logs));
      await start();
    },
    async uninstall() {
      await stop();
      await rm(definition, { force: true });
    },
    start,
    stop,
    async status() {
      const printed = await attempt("launchctl", ["print", service]);
      return {
        installed: existsSync(definition),
        pid: printed === undefined ? undefined : launchdPid(printed),
      };
    },
  };
}

// Linux: a systemd user unit, started with the user's session. Without
// `loginctl enable-linger` it stops at logout. Output goes to the journal.

export const systemdUnitName = "mcproxy.service";

export function systemdUnit(target: Target): string {
  const q = (text: string) =>
    `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const env = Object.entries(envOf(target))
    .map(([key, value]) => q(`${key}=${value}`))
    .join(" ");
  return [
    "[Unit]",
    "Description=mcproxy local MCP authentication proxy",
    "After=network.target",
    "",
    "[Service]",
    `ExecStart=${[target.node, ...daemonArgs(target)].map(q).join(" ")}`,
    `WorkingDirectory=${target.cwd}`,
    `Environment=${env}`,
    "Restart=on-failure",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function systemd(target: Target): Manager {
  const definition = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "systemd",
    "user",
    systemdUnitName,
  );
  const systemctl = (...args: string[]) => run("systemctl", ["--user", ...args]);
  return {
    definition,
    logs: `journalctl --user -u ${systemdUnitName}`,
    async install() {
      await mkdir(dirname(definition), { recursive: true });
      await writeFile(definition, systemdUnit(target));
      await systemctl("daemon-reload");
      await systemctl("enable", systemdUnitName);
      await systemctl("restart", systemdUnitName);
    },
    async uninstall() {
      await attempt("systemctl", ["--user", "disable", "--now", systemdUnitName]);
      await rm(definition, { force: true });
      await systemctl("daemon-reload");
    },
    async start() {
      await systemctl("start", systemdUnitName);
    },
    async stop() {
      await systemctl("stop", systemdUnitName);
    },
    async status() {
      const pid = Number(
        (await attempt("systemctl", [
          "--user",
          "show",
          "-p",
          "MainPID",
          "--value",
          systemdUnitName,
        ])) ?? "0",
      );
      return { installed: existsSync(definition), pid: pid > 0 ? pid : undefined };
    },
  };
}

// Windows: a `HKCU\...\Run` entry (no elevation needed) that runs a PowerShell
// script hidden at logon. The script owns start, stop and status so the
// daemon is found the same way everywhere: a node.exe whose command line
// names this main.js. Start is idempotent, so a logon never doubles the
// daemon. Stop terminates it; the daemon's state survives that.

export const windowsRunKey =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const windowsRunValue = "mcproxy";

export function windowsScript(target: Target, logFile: string): string {
  const q = (text: string) => `'${text.replace(/'/g, "''")}'`;
  // Start-Process joins ArgumentList with spaces and does not quote, so each
  // argument is pre-quoted for node's command-line parser.
  const args = daemonArgs(target)
    .map((arg) => q(`"${arg}"`))
    .join(", ");
  return [
    "param([ValidateSet('start', 'stop', 'status')][string]$Verb = 'start')",
    "$ErrorActionPreference = 'Stop'",
    `$main = ${q(target.main)}`,
    "$running = Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($main) }",
    "switch ($Verb) {",
    "  'status' { $running | ForEach-Object { $_.ProcessId } }",
    "  'stop' { $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force } }",
    "  'start' {",
    "    if ($running) { exit 0 }",
    ...(target.port === undefined ? [] : [`    $env:PORT = ${q(target.port)}`]),
    `    Start-Process -FilePath ${q(target.node)} -ArgumentList @(${args}) \``,
    `      -WorkingDirectory ${q(target.cwd)} -WindowStyle Hidden \``,
    `      -RedirectStandardOutput ${q(logFile)} -RedirectStandardError ${q(logFile.replace(/\.log$/, ".err.log"))}`,
    "  }",
    "}",
    "",
  ].join("\r\n");
}

function windows(target: Target): Manager {
  const stateDir = localPlatform.stateDirectory();
  const definition = join(stateDir, "mcproxy-service.ps1");
  const logs = join(stateDir, "mcproxy.log");
  const powershell = (...args: string[]) =>
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      definition,
      ...args,
    ]);
  const stop = async () => {
    if (existsSync(definition)) await powershell("stop");
  };
  return {
    definition: `${windowsRunKey}\\${windowsRunValue} (${definition})`,
    logs,
    async install() {
      await mkdir(stateDir, { recursive: true });
      await stop();
      await writeFile(definition, windowsScript(target, logs));
      await run("reg.exe", [
        "add",
        windowsRunKey,
        "/v",
        windowsRunValue,
        "/t",
        "REG_SZ",
        "/d",
        `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${definition}"`,
        "/f",
      ]);
      await powershell("start");
    },
    async uninstall() {
      await stop();
      await attempt("reg.exe", ["delete", windowsRunKey, "/v", windowsRunValue, "/f"]);
      await rm(definition, { force: true });
    },
    async start() {
      if (!existsSync(definition)) throw new Error("Not installed");
      await powershell("start");
    },
    stop,
    async status() {
      const registered =
        (await attempt("reg.exe", ["query", windowsRunKey, "/v", windowsRunValue])) !==
        undefined;
      const pid = existsSync(definition)
        ? Number((await powershell("status")).trim().split(/\s+/)[0])
        : undefined;
      return { installed: registered, pid: pid !== undefined && pid > 0 ? pid : undefined };
    },
  };
}

export function createManager(target: Target): Manager {
  switch (process.platform) {
    case "darwin":
      return launchd(target);
    case "linux":
      return systemd(target);
    case "win32":
      return windows(target);
    default:
      throw new Error(`No login service support for ${process.platform}`);
  }
}

/** Runs one verb and prints a short, human-readable result. */
export async function manage(verb: Verb, target = resolveTarget()) {
  const manager = createManager(target);
  if (verb === "install" && !existsSync(join(target.cwd, "apps", "web", "dist", "index.html")))
    throw new Error("Web app is not built; run `pnpm build` first");
  if (verb === "restart") {
    await manager.stop();
    await manager.start();
  } else if (verb !== "status") await manager[verb]();
  const status = await manager.status();
  console.log(`installed  ${status.installed ? "yes" : "no"}  ${manager.definition}`);
  console.log(`running    ${status.pid === undefined ? "no" : `yes  pid=${status.pid}`}`);
  console.log(`logs       ${manager.logs}`);
}

function escapeXml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
