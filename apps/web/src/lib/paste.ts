import type { Transport } from "./api"
import { CLIENT_LABELS, type ClientId } from "./clients"
import type { ProfileFormValues, ProviderFormValues } from "./forms"
import { slugify } from "./forms"

// Turns an "add this MCP" snippet copied from a README into provider form
// values. Understands the add commands of every client mcproxy writes setup
// commands for (Claude Code, Codex, Gemini CLI, VS Code), their JSON and TOML
// config entries, a bare URL, and a bare stdio command.

export type PasteSource = ClientId | "url" | "command"

/** Names a snippet's origin in "Filled from ..." */
export const PASTE_LABELS: Record<PasteSource, string> = { ...CLIENT_LABELS, url: "URL", command: "command" }

export type PastedServer = {
  source: PasteSource
  /** Server name from the snippet; empty when it has none. */
  name: string
  transport: Transport
  /** Credentials in the snippet. They belong on a profile, not the provider. */
  headers: Record<string, string>
  env: Record<string, string>
}

/** Parses a pasted snippet; null when it is not a recognizable MCP server. */
export function parsePastedServer(text: string): PastedServer | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("{")) return fromJsonText(trimmed, "json")
  if (/^\[mcp_servers\./m.test(trimmed)) return fromToml(trimmed)
  if (isUrl(trimmed)) return fromUrl(trimmed)

  const commands = splitCommands(trimmed)
  if (!commands) return null
  for (const words of commands) {
    const parsed = fromCommand(words)
    if (parsed) return parsed
  }
  return null
}

/** Form values to merge over the current provider form. */
export function pastedFormValues(server: PastedServer): Partial<ProviderFormValues> {
  const named = server.name ? { name: server.name, slug: slugify(server.name) } : {}
  const { transport } = server
  return transport.type === "http"
    ? { ...named, transport: "http", url: transport.url }
    : {
        ...named,
        transport: "stdio",
        command: transport.command,
        args: transport.args.join("\n"),
        cwd: transport.cwd ?? "",
      }
}

/**
 * Credentials the transport can use, as values for the server's first
 * profile. A lone `Authorization: Bearer` header becomes a bearer token.
 */
export function pastedProfileValues(server: PastedServer): Partial<ProfileFormValues> | null {
  const rows = (record: Record<string, string>) =>
    Object.entries(record).map(([key, value]) => ({ key, value }))
  if (server.transport.type === "stdio") {
    const env = rows(server.env)
    return env.length ? { authType: "env", env } : null
  }
  const headers = rows(server.headers)
  const [only] = headers
  if (!only) return null
  const bearer = headers.length === 1 && only.key.toLowerCase() === "authorization"
    ? /^Bearer\s+(\S+)$/i.exec(only.value)
    : null
  return bearer ? { authType: "bearer", bearerToken: bearer[1] } : { authType: "headers", headers }
}

// Commands -------------------------------------------------------------------

type Cli = { source: Exclude<PasteSource, "url">; prefix: string[]; options: Set<string> }

/** Options that consume the following word, per client CLI. */
const CLIS: Cli[] = [
  {
    source: "claude",
    prefix: ["claude", "mcp", "add"],
    options: new Set(["-t", "--transport", "-s", "--scope", "-e", "--env", "-H", "--header", "--client-id", "--callback-port"]),
  },
  {
    source: "gemini",
    prefix: ["gemini", "mcp", "add"],
    options: new Set(["-t", "--transport", "-s", "--scope", "-e", "--env", "-H", "--header", "--timeout", "--description", "--include-tools", "--exclude-tools"]),
  },
  {
    source: "codex",
    prefix: ["codex", "mcp", "add"],
    options: new Set(["--env", "--url", "--bearer-token-env-var"]),
  },
]

const LAUNCHERS = new Set(["npx", "uvx", "uv", "bunx", "bun", "pnpm", "yarn", "node", "deno", "python", "python3", "docker"])

function fromCommand(words: string[]): PastedServer | null {
  if (words[0] === "$") words = words.slice(1)
  const [program, ...rest] = words
  if (!program) return null

  if ((program === "code" || program === "code-insiders") && rest[0] === "--add-mcp" && rest[1]) {
    return fromJsonText(rest[1], "vscode")
  }
  if (program === "claude" && rest[0] === "mcp" && rest[1] === "add-json" && rest[2] && rest[3]) {
    const parsed = fromJsonText(rest[3], "claude")
    return parsed && { ...parsed, name: rest[2] }
  }
  const cli = CLIS.find(({ prefix }) => prefix.every((word, index) => words[index] === word))
  if (cli) return fromCliArgs(cli, words.slice(cli.prefix.length))

  // A bare launcher command, like the stdio examples in most READMEs.
  if (!LAUNCHERS.has(program) && !/^(\/|\.{1,2}\/|~\/)/.test(program)) return null
  return { source: "command", name: "", transport: { type: "stdio", command: program, args: rest }, headers: {}, env: {} }
}

/**
 * Shared shape of `<cli> mcp add [options] <name> <commandOrUrl> [args...]`.
 * Options may follow a URL, but everything after a stdio command is its args.
 */
function fromCliArgs(cli: Cli, words: string[]): PastedServer | null {
  const positionals: string[] = []
  const options = new Map<string, string[]>()
  let index = 0
  while (index < words.length) {
    const word = words[index++]!
    if (word === "--") {
      positionals.push(...words.slice(index))
      break
    }
    if (word.startsWith("-")) {
      const [flag, inline] = splitOnce(word, "=")
      const value = inline ?? (cli.options.has(flag) ? words[index++] : undefined)
      if (value !== undefined) options.set(flag, [...(options.get(flag) ?? []), value])
      continue
    }
    positionals.push(word)
    if (positionals.length === 2 && !isUrl(word)) {
      positionals.push(...words.slice(index))
      break
    }
  }

  const option = (...names: string[]) => names.flatMap((name) => options.get(name) ?? [])
  const [name = "", target, ...args] = positionals
  const url = option("--url")[0] ?? (target && isUrl(target) ? target : undefined)
  const transport: Transport | null = url
    ? { type: "http", url }
    : target
      ? { type: "stdio", command: target, args }
      : null
  if (!transport) return null

  const headers = pairs(option("-H", "--header"), ":")
  const env = pairs(option("-e", "--env"), "=")
  return { source: cli.source, name, transport, headers, env }
}

/**
 * Minimal POSIX shell word splitting: quotes, backslash escapes, and line
 * continuations. Newlines, `;`, and `&&` separate commands. Null when a quote
 * is left open.
 */
export function splitCommands(text: string): string[][] | null {
  const commands: string[][] = []
  let words: string[] = []
  let word: string | null = null
  const endWord = () => {
    if (word !== null) words.push(word)
    word = null
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char === "'") {
      const close = text.indexOf("'", index + 1)
      if (close < 0) return null
      word = (word ?? "") + text.slice(index + 1, close)
      index = close
    } else if (char === '"') {
      let value = ""
      index++
      for (; index < text.length && text[index] !== '"'; index++) {
        const next = text[index + 1]
        if (text[index] === "\\" && next !== undefined && '"\\$`\n'.includes(next)) {
          if (next !== "\n") value += next
          index++
        } else {
          value += text[index]
        }
      }
      if (index >= text.length) return null
      word = (word ?? "") + value
    } else if (char === "\\") {
      const next = text[++index]
      if (next !== undefined && next !== "\n") word = (word ?? "") + next
    } else if (char === "\n" || char === ";" || (char === "&" && text[index + 1] === "&")) {
      if (char === "&") index++
      endCommand()
    } else if (/\s/.test(char)) {
      endWord()
    } else {
      word = (word ?? "") + char
    }
  }
  endCommand()
  return commands
}

// Config entries ---------------------------------------------------------------

type ConfigEntry = Record<string, unknown>

/**
 * JSON in any common shape: `{ mcpServers: { name: entry } }`, VS Code's
 * `{ servers: ... }`, `{ name: entry }`, or a bare entry (VS Code's carries
 * its own `name`).
 */
function fromJsonText(text: string, source: PasteSource): PastedServer | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  if (isEntry(value)) return fromEntry(typeof value.name === "string" ? value.name : "", value, source)
  const servers = [value.mcpServers, value.servers, value.mcp_servers].find(isRecord) ?? value
  const found = Object.entries(servers).find(([, entry]) => isRecord(entry) && isEntry(entry))
  return found ? fromEntry(found[0], found[1] as ConfigEntry, source) : null
}

/** Codex `config.toml`: `[mcp_servers.<name>]` tables of strings and string arrays. */
function fromToml(text: string): PastedServer | null {
  let name = ""
  const entry: ConfigEntry = {}
  let table: ConfigEntry | null = null
  for (const line of text.split("\n").map((line) => line.trim())) {
    const header = /^\[mcp_servers\.(?:"([^"]+)"|([^\]."]+))(?:\.(env|http_headers))?\]$/.exec(line)
    if (header) {
      const server = header[1] ?? header[2]!
      if (name && server !== name) break
      name = server
      table = entry
      if (header[3]) {
        table = {}
        entry[header[3]] = table
      }
      continue
    }
    const pair = /^"?([\w-]+)"?\s*=\s*(.+)$/.exec(line)
    if (!pair || !table) continue
    try {
      table[pair[1]!] = JSON.parse(pair[2]!.replace(/'([^']*)'/g, (_, raw: string) => JSON.stringify(raw)))
    } catch {
      // Only strings and string arrays matter; inline tables and the rest are skipped.
    }
  }
  return name ? fromEntry(name, { ...entry, headers: entry.http_headers }, "codex") : null
}

function fromEntry(name: string, entry: ConfigEntry, source: PasteSource): PastedServer | null {
  const url = [entry.url, entry.httpUrl, entry.serverUrl].find((value) => typeof value === "string")
  const headers = stringRecord(entry.headers)
  const env = stringRecord(entry.env)
  if (url) return { source, name, transport: { type: "http", url }, headers, env }
  if (typeof entry.command !== "string") return null
  const args = Array.isArray(entry.args) ? entry.args.filter((arg) => typeof arg === "string") : []
  const cwd = typeof entry.cwd === "string" ? entry.cwd : undefined
  return {
    source,
    name,
    transport: { type: "stdio", command: entry.command, args, ...(cwd ? { cwd } : {}) },
    headers,
    env,
  }
}

/** A bare URL is named after its host: `mcp.linear.app` becomes `linear`. */
function fromUrl(url: string): PastedServer {
  const labels = new URL(url).hostname.split(".").slice(0, -1)
  const name = labels.find((label) => !["mcp", "www", "api", "server"].includes(label)) ?? ""
  return { source: "url", name, transport: { type: "http", url }, headers: {}, env: {} }
}

// Helpers ----------------------------------------------------------------------

function isUrl(value: string): boolean {
  return /^https?:\/\/\S+$/.test(value) && URL.canParse(value)
}

function isRecord(value: unknown): value is ConfigEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isEntry(value: ConfigEntry): boolean {
  return ["command", "url", "httpUrl", "serverUrl"].some((key) => typeof value[key] === "string")
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
  )
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const at = value.indexOf(separator)
  return at < 0 ? [value, undefined] : [value.slice(0, at), value.slice(at + 1)]
}

/** `KEY=value` or `Name: value` pairs into a record. */
function pairs(values: string[], separator: string): Record<string, string> {
  return Object.fromEntries(
    values.flatMap((value) => {
      const [key, rest] = splitOnce(value, separator)
      return rest === undefined ? [] : [[key.trim(), rest.trim()]]
    }),
  )
}
