import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
if (process.env.PID_FILE)
  writeFileSync(process.env.PID_FILE, String(process.pid));
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (!("id" in m)) return;
  if (m.method === "ping") {
    send({
      jsonrpc: "2.0",
      id: m.id,
      error: {
        code: -32042,
        message: "original upstream error",
        data: { fixture: true },
      },
    });
    return;
  }
  const result =
    m.method === "initialize"
      ? {
          protocolVersion: m.params.protocolVersion,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "fixture", version: "1" },
        }
      : m.method === "tools/list"
        ? { tools: [{ name: "identity", inputSchema: { type: "object" } }] }
        : m.method === "tools/call"
          ? {
              content: [{ type: "text", text: process.env.IDENTITY ?? "none" }],
            }
          : m.method === "resources/list"
            ? { resources: [{ uri: "fixture://item", name: "item" }] }
            : m.method === "resources/read"
              ? { contents: [{ uri: "fixture://item", text: "resource" }] }
              : m.method === "prompts/list"
                ? { prompts: [{ name: "hello" }] }
                : m.method === "prompts/get"
                  ? {
                      messages: [
                        {
                          role: "user",
                          content: { type: "text", text: "hello" },
                        },
                      ],
                    }
                  : {};
  send({ jsonrpc: "2.0", id: m.id, result });
});
