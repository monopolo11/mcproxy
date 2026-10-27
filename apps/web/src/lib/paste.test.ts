import { describe, expect, it } from "vitest"
import { clientCommands } from "./clients"
import { parsePastedServer, pastedFormValues, pastedProfileValues, splitCommands } from "./paste"

const linear = { type: "http", url: "https://mcp.linear.app/mcp" }
const everything = { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] }

describe("parsePastedServer", () => {
  it.each([
    ["claude", "claude mcp add --transport http linear https://mcp.linear.app/mcp"],
    ["gemini", "gemini mcp add -t http linear https://mcp.linear.app/mcp"],
    ["codex", "codex mcp add linear --url https://mcp.linear.app/mcp"],
    ["vscode", `code --add-mcp '{"name":"linear","type":"http","url":"https://mcp.linear.app/mcp"}'`],
    ["json", `{ "mcpServers": { "linear": { "url": "https://mcp.linear.app/mcp" } } }`],
    ["json", `{ "servers": { "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" } } }`],
    ["codex", `[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"`],
    ["url", "https://mcp.linear.app/mcp"],
  ])("reads an HTTP server from %s: %s", (source, text) => {
    expect(parsePastedServer(text)).toMatchObject({ source, name: "linear", transport: linear })
  })

  it.each([
    ["claude", "claude mcp add everything -- npx -y @modelcontextprotocol/server-everything"],
    ["claude", "claude mcp add everything npx -y @modelcontextprotocol/server-everything"],
    ["gemini", "gemini mcp add everything npx -y @modelcontextprotocol/server-everything"],
    ["codex", "codex mcp add everything -- npx -y @modelcontextprotocol/server-everything"],
    ["claude", `claude mcp add-json everything '{"command":"npx","args":["-y","@modelcontextprotocol/server-everything"]}'`],
    ["json", `{ "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] } }`],
    ["codex", `[mcp_servers.everything]\ncommand = "npx"\nargs = ["-y", '@modelcontextprotocol/server-everything']`],
  ])("reads a stdio server from %s: %s", (source, text) => {
    expect(parsePastedServer(text)).toMatchObject({ source, name: "everything", transport: everything })
  })

  it("keeps credentials apart from the transport", () => {
    const claude = parsePastedServer(
      `claude mcp add -e API_KEY=abc -e REGION=eu github -- docker run -i --rm ghcr.io/github/github-mcp-server`,
    )
    expect(claude).toMatchObject({
      env: { API_KEY: "abc", REGION: "eu" },
      transport: { command: "docker", args: ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"] },
    })
    const http = parsePastedServer(
      `claude mcp add --transport http linear https://mcp.linear.app/mcp --header "Authorization: Bearer xyz"`,
    )
    expect(http).toMatchObject({ transport: linear, headers: { Authorization: "Bearer xyz" } })
    const toml = parsePastedServer(`[mcp_servers.x]\ncommand = "uvx"\n\n[mcp_servers.x.env]\nTOKEN = "t"`)
    expect(toml).toMatchObject({ transport: { command: "uvx", args: [] }, env: { TOKEN: "t" } })
  })

  it("reads mcproxy's own setup commands back", () => {
    const target = { name: "linear-work", endpoint: "http://127.0.0.1:7433/mcps/linear/work", token: "tok" }
    for (const command of clientCommands(target)) {
      expect(parsePastedServer(command.text), command.id).toMatchObject({
        name: "linear-work",
        transport: { type: "http", url: target.endpoint },
      })
    }
  })

  it("takes a bare launcher command without a name", () => {
    expect(parsePastedServer("$ npx -y @modelcontextprotocol/server-everything")).toMatchObject({
      source: "command",
      name: "",
      transport: everything,
    })
  })

  it.each(["", "hello world", "-y\n@scope/pkg", "claude mcp add", "{ not json", `echo "open quote`])(
    "rejects %j",
    (text) => expect(parsePastedServer(text)).toBeNull(),
  )
})

describe("splitCommands", () => {
  it("handles quotes, escapes, continuations, and separators", () => {
    expect(splitCommands(`a "b \\"c\\"" 'd e'\\\n  f && g; h\ni`)).toEqual([
      ["a", 'b "c"', "d e", "f"],
      ["g"],
      ["h"],
      ["i"],
    ])
  })
})

describe("pastedFormValues", () => {
  it("fills name, slug, and the transport fields", () => {
    const server = parsePastedServer("claude mcp add My_Server -- npx -y pkg")!
    expect(pastedFormValues(server)).toEqual({
      name: "My_Server",
      slug: "my-server",
      transport: "stdio",
      command: "npx",
      args: "-y\npkg",
      cwd: "",
    })
  })
})

describe("pastedProfileValues", () => {
  const profileOf = (text: string) => pastedProfileValues(parsePastedServer(text)!)

  it("turns a lone Authorization header into a bearer token", () => {
    expect(profileOf(`claude mcp add -t http x https://x.dev/mcp -H "Authorization: Bearer abc"`)).toEqual({
      authType: "bearer",
      bearerToken: "abc",
    })
  })

  it("keeps other headers as headers and stdio env as env", () => {
    expect(profileOf(`gemini mcp add -t http x https://x.dev/mcp -H "X-Key: 1" -H "X-Org: 2"`)).toEqual({
      authType: "headers",
      headers: [{ key: "X-Key", value: "1" }, { key: "X-Org", value: "2" }],
    })
    expect(profileOf("codex mcp add x --env TOKEN=t -- uvx x")).toEqual({
      authType: "env",
      env: [{ key: "TOKEN", value: "t" }],
    })
  })

  it("is null without credentials the transport can carry", () => {
    expect(profileOf("https://mcp.linear.app/mcp")).toBeNull()
    expect(profileOf(`{ "x": { "url": "https://x.dev/mcp", "env": { "A": "1" } } }`)).toBeNull()
  })
})
