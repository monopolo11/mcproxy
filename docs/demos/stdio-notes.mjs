// Synthetic stdio MCP server for demos. Requires DEMO_NOTES_KEY in its
// environment, so the stdio "env" credential form is visible in a recording.
import { createInterface } from "node:readline"

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")
const keyed = (process.env.DEMO_NOTES_KEY ?? "").startsWith("demo-")

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (!("id" in message)) return
  if (!keyed) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "DEMO_NOTES_KEY missing" } })
    return
  }
  const result =
    message.method === "initialize"
      ? {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: "local-notes-demo", version: "1.0.0" },
        }
      : message.method === "tools/list"
        ? { tools: [{ name: "list_notes", inputSchema: { type: "object" } }] }
        : message.method === "prompts/list"
          ? { prompts: [{ name: "summarize" }] }
          : {}
  send({ jsonrpc: "2.0", id: message.id, result })
})
