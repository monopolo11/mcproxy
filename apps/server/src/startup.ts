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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultPort, localPlatform, portFromEnv } from "./platform.js";

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
  port?: number;
}

export interface Status {
  installed: boolean;
  pid?: number;
}

/**
 * One platform's service. `install` writes the definition and starts the
 * daemon; `manage` stops any previous instance first and checks the port.
 */
interface Manager {
  /** Where the service definition lives. */
  definition: string;
  /** Where to read the daemon's output. */
  logs: string;
  /** The PORT recorded in the installed definition, if any. */
  port(): number | undefined;
  /** Writes the definition and starts the daemon; may return a hint to print. */
  install(): Promise<string | undefined>;
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

/** Reads the PORT a renderer wrote into its definition, matched by `pattern`. */
function recordedPort(definition: string, pattern: RegExp) {
  if (!existsSync(definition)) return undefined;
  const match = pattern.exec(readFileSync(definition, "utf8"));
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** Describes the daemon next to this file; throws on an invalid PORT. */
export function resolveTarget(): Target {
  const dist = dirname(fileURLToPath(import.meta.url));
  const cwd = resolve(dist, "..", "..", "..");
  return {
    node: realpathSync(process.execPath),
    main: join(dist, "main.js"),
    cwd,
    envFile: join(cwd, ".env"),
    path: process.env.PATH ?? "",
    port: process.env.PORT ? portFromEnv() : undefined,
  };
}

/** The daemon's argv after the node binary. */
const daemonArgs = (target: Target) => [
  `--env-file-if-exists=${target.envFile}`,
  target.main,
];

const envOf = (target: Target): Record<string, string> => ({
  PATH: target.path,
  ...(target.port === undefined ? {} : { PORT: String(target.port) }),
});

// macOS: a LaunchAgent. `bootstrap` loads and starts it (RunAtLoad), `bootout`
// stops and unloads it. KeepAlive restarts it after a crash but not after a
// clean stop, which is how the daemon exits on SIGTERM.

export const launchdLabel = "com.mcproxy.daemon";
export const launchdPortPattern = /<key>PORT<\/key>\s*<string>(\d+)<\/string>/;

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
    if (await loaded()) throw new Error("The service did not stop within 10s");
  };
  // A crashed job stays loaded while KeepAlive waits to relaunch it; bootstrap
  // would then fail, so kick it instead.
  const start = async () => {
    if (!existsSync(definition)) throw new Error("Not installed");
    if (await loaded()) return void (await run("launchctl", ["kickstart", service]));
    await attempt("launchctl", ["enable", service]);
    await run("launchctl", ["bootstrap", domain, definition]);
  };
  return {
    definition,
    logs,
    port: () => recordedPort(definition, launchdPortPattern),
    async install() {
      await mkdir(dirname(definition), { recursive: true });
      await mkdir(dirname(logs), { recursive: true });
      await writeFile(definition, launchdPlist(target, logs));
      await start();
      return undefined;
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

// Linux: a systemd user unit, started with the user's session. Install turns
// on lingering so it also starts at boot and survives logout; when that needs
// a password the user is told. Output goes to the journal.

export const systemdUnitName = "mcproxy.service";
export const systemdPortPattern = /"PORT=(\d+)"/;

export function systemdUnit(target: Target): string {
  // systemd expands `%` specifiers in these settings, and unquotes ExecStart
  // and Environment with C-style escapes. WorkingDirectory is read verbatim.
  const specifiers = (text: string) => text.replace(/%/g, "%%");
  const q = (text: string) =>
    `"${specifiers(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const env = Object.entries(envOf(target))
    .map(([key, value]) => q(`${key}=${value}`))
    .join(" ");
  return [
    "[Unit]",
    "Description=mcproxy local MCP authentication proxy",
    "",
    "[Service]",
    `ExecStart=${[target.node, ...daemonArgs(target)].map(q).join(" ")}`,
    `WorkingDirectory=${specifiers(target.cwd)}`,
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
  const systemctl = (...args: string[]) =>
    run("systemctl", ["--user", ...args]);
  return {
    definition,
    logs: `journalctl --user -u ${systemdUnitName}`,
    port: () => recordedPort(definition, systemdPortPattern),
    async install() {
      await mkdir(dirname(definition), { recursive: true });
      await writeFile(definition, systemdUnit(target));
      await systemctl("daemon-reload");
      await systemctl("enable", systemdUnitName);
      await systemctl("start", systemdUnitName);
      return (await attempt("loginctl", ["enable-linger"])) === undefined
        ? "lingering  off; run `loginctl enable-linger` so the daemon starts at boot and survives logout"
        : undefined;
    },
    async uninstall() {
      await attempt("systemctl", ["--user", "disable", "--now", systemdUnitName]);
      await rm(definition, { force: true });
      await systemctl("daemon-reload");
    },
    async start() {
      if (!existsSync(definition)) throw new Error("Not installed");
      await systemctl("start", systemdUnitName);
    },
    // systemctl fails on a unit it has never loaded, so only stop an installed one.
    async stop() {
      if (existsSync(definition)) await systemctl("stop", systemdUnitName);
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
      return {
        installed: existsSync(definition),
        pid: pid > 0 ? pid : undefined,
      };
    },
  };
}

// Windows: a `HKCU\...\Run` entry (no elevation needed) that runs a PowerShell
// script hidden at logon. The script owns start, stop and status so the
// daemon is found the same way everywhere: a node.exe whose command line
// names this main.js. Start is idempotent, so a logon never doubles the
// daemon. Stop terminates it; the daemon's state survives that. Nothing
// supervises the daemon between logons.

export const windowsRunKey =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const windowsRunValue = "mcproxy";
export const windowsPortPattern = /\$env:PORT = '(\d+)'/;

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
    "$running = @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($main) })",
    "switch ($Verb) {",
    "  'status' { foreach ($p in $running) { $p.ProcessId } }",
    "  'stop' {",
    "    foreach ($p in $running) {",
    "      Stop-Process -Id $p.ProcessId -Force",
    "      Wait-Process -Id $p.ProcessId -Timeout 10 -ErrorAction SilentlyContinue",
    "    }",
    "  }",
    "  'start' {",
    "    if ($running.Count -gt 0) { exit 0 }",
    `    $env:Path = ${q(target.path)}`,
    ...(target.port === undefined ? [] : [`    $env:PORT = '${target.port}'`]),
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
    logs: `${logs} and ${logs.replace(/\.log$/, ".err.log")}`,
    port: () => recordedPort(definition, windowsPortPattern),
    async install() {
      await mkdir(stateDir, { recursive: true });
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
      return undefined;
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
        : 0;
      return { installed: registered, pid: pid > 0 ? pid : undefined };
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

/**
 * Rejects when something already listens on the daemon's port, such as a
 * foreground `pnpm dev`. Otherwise the service would crash-loop on
 * EADDRINUSE while status reports it running.
 */
export function assertPortFree(port: number) {
  return new Promise<void>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      reject(
        new Error(
          `Something already listens on 127.0.0.1:${port} (a foreground \`pnpm dev\` or \`pnpm start\`?); stop it first`,
        ),
      );
    });
    socket.once("error", () => resolve());
  });
}

/**
 * Runs one verb and prints a short, human-readable result. Install renders
 * from the current environment; start and restart keep the installed
 * definition, so they check the port recorded there, not the shell's PORT.
 */
export async function manage(verb: Verb, target = resolveTarget()) {
  const manager = createManager(target);
  let hint: string | undefined;
  switch (verb) {
    case "install":
      if (!existsSync(join(target.cwd, "apps", "web", "dist", "index.html")))
        throw new Error("Web app is not built; run `pnpm build` first");
      await manager.stop();
      await assertPortFree(target.port ?? defaultPort);
      hint = await manager.install();
      break;
    case "restart":
      await manager.stop();
      await assertPortFree(manager.port() ?? defaultPort);
      await manager.start();
      break;
    case "start":
      if ((await manager.status()).pid === undefined) {
        await assertPortFree(manager.port() ?? defaultPort);
        await manager.start();
      }
      break;
    case "uninstall":
    case "stop":
      await manager[verb]();
      break;
    case "status":
      break;
  }
  const status = await manager.status();
  console.log(`installed  ${status.installed ? "yes" : "no"}  ${manager.definition}`);
  console.log(`running    ${status.pid === undefined ? "no" : `yes  pid=${status.pid}`}`);
  console.log(`logs       ${manager.logs}`);
  if (hint !== undefined) console.log(hint);
}

function escapeXml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
