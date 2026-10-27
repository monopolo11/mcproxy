import test from "node:test";
import assert from "node:assert/strict";
import { AssociatedHTTPTransport } from "../src/http-relay.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

for (const format of ["json", "sse"] as const) {
  test(`HTTP association adapter accepts ${format} responses and SSE priming, CRLF and UTF-8 chunk boundaries`, async () => {
    const result = { jsonrpc: "2.0", id: 7, result: { text: "héllo" } };
    const payload =
      format === "json"
        ? JSON.stringify(result)
        : `: comment\r\nid: priming\r\ndata:\r\n\r\nevent: ignored\r\ndata: invalid-json\r\n\r\nevent: message\r\ndata: ${JSON.stringify(result)}\r\n\r\n`;
    const bytes = new TextEncoder().encode(payload);
    const transport = new AssociatedHTTPTransport(
      new URL("http://fixture.invalid/mcp"),
      {
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const byte of bytes)
                  controller.enqueue(Uint8Array.of(byte));
                controller.close();
              },
            }),
            {
              headers: {
                "mcp-session-id": "fixture-session",
                "content-type":
                  format === "json" ? "application/json" : "text/event-stream",
              },
            },
          ),
      },
    );
    let receive!: (message: JSONRPCMessage) => void;
    const received = new Promise<JSONRPCMessage>((resolve, reject) => {
      receive = resolve;
      transport.onerror = reject;
    });
    transport.onmessage = (message) => {
      assert.equal(transport.sessionId, "fixture-session");
      receive(message);
    };
    try {
      await transport.start();
      await transport.send({ jsonrpc: "2.0", id: 7, method: "ping" });
      const message = await received;
      assert.deepEqual(message, result);
      assert.equal(transport.associations.get(message), 7);
    } finally {
      await transport.close();
    }
  });
}

test("an interrupted POST closes the transport instead of leaving its request pending", async () => {
  const transport = new AssociatedHTTPTransport(
    new URL("http://fixture.invalid/mcp"),
    {
      fetch: async () =>
        new Response(
          'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    },
  );
  let failed!: () => void;
  let closed!: () => void;
  const failure = new Promise<void>((resolve) => {
    failed = resolve;
  });
  const closure = new Promise<void>((resolve) => {
    closed = resolve;
  });
  transport.onerror = () => failed();
  transport.onclose = () => closed();
  await transport.start();
  await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  await Promise.all([failure, closure]);
});
