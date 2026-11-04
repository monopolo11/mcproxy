// Commands that register a proxied profile with each MCP client. Pure text
// builders; the UI masks the token for display and copies the full text.

export const CLIENT_IDS = ["claude", "codex", "gemini", "cursor", "vscode", "json"] as const

export type ClientId = (typeof CLIENT_IDS)[number]

export const CLIENT_LABELS: Record<ClientId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  cursor: "Cursor",
  vscode: "VS Code",
  json: "JSON",
}

/** Where a client stores the registration: its global config, or the current project. */
export const SCOPES = ["user", "project"] as const

export type Scope = (typeof SCOPES)[number]

export const SCOPE_LABELS: Record<Scope, string> = {
  user: "User",
  project: "Project",
}

export type ClientTarget = {
  /** Server name inside the client. */
  name: string
  endpoint: string
  token: string
  scope: Scope
}

export type ClientCommand = { id: ClientId; label: string; text: string; hint?: string }

/** Name a client registers the profile under: `provider-profile`. */
export function clientServerName(providerSlug: string, profileSlug: string): string {
  return `${providerSlug}-${profileSlug}`
}

/** Environment variable Codex reads the token from; derived from the server name. */
export function codexEnvVar(name: string): string {
  return `MCPROXY_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
}

const bearer = (token: string) => `Bearer ${token}`

export function clientCommand(id: ClientId, target: ClientTarget): ClientCommand {
  const { name, endpoint, token, scope } = target
  const label = CLIENT_LABELS[id]
  switch (id) {
    case "claude":
      return {
        id,
        label,
        text: `claude mcp add --transport http --scope ${scope} ${name} ${endpoint} --header "Authorization: ${bearer(token)}"`,
        hint:
          scope === "project"
            ? "Writes .mcp.json in the current directory. The token is stored in plain text, so keep the file out of git."
            : undefined,
      }
    case "codex": {
      const env = codexEnvVar(name)
      return {
        id,
        label,
        text: `export ${env}="${token}"\ncodex mcp add ${name} --url ${endpoint} --bearer-token-env-var ${env}`,
        hint: `Codex reads the token from the environment. Put the export in your shell profile.${
          scope === "project" ? " Codex only registers servers globally." : ""
        }`,
      }
    }
    case "gemini":
      return {
        id,
        label,
        text: `gemini mcp add --scope ${scope} --transport http --header "Authorization: ${bearer(token)}" ${name} ${endpoint}`,
      }
    case "cursor":
      return {
        id,
        label,
        text: JSON.stringify(
          { mcpServers: { [name]: { url: endpoint, headers: { Authorization: bearer(token) } } } },
          null,
          2,
        ),
        hint: scope === "project" ? "Paste into .cursor/mcp.json in the project." : "Paste into ~/.cursor/mcp.json.",
      }
    case "vscode":
      if (scope === "project") {
        return {
          id,
          label,
          text: JSON.stringify(
            { servers: { [name]: { type: "http", url: endpoint, headers: { Authorization: bearer(token) } } } },
            null,
            2,
          ),
          hint: "Paste into .vscode/mcp.json in the project. The token is stored in plain text, so keep the file out of git.",
        }
      }
      return {
        id,
        label,
        text: `code --add-mcp '${JSON.stringify({ name, type: "http", url: endpoint, headers: { Authorization: bearer(token) } })}'`,
      }
    case "json":
      return {
        id,
        label,
        text: JSON.stringify(
          { [name]: { type: "http", url: endpoint, headers: { Authorization: bearer(token) } } },
          null,
          2,
        ),
      }
  }
}

export function clientCommands(target: ClientTarget): ClientCommand[] {
  return CLIENT_IDS.map((id) => clientCommand(id, target))
}
