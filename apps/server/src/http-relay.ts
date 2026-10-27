import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  JSONRPCMessageSchema,
  isJSONRPCRequest,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";

import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Retains POST stream association that the SDK's onmessage callback omits. */
export class AssociatedHTTPTransport extends StreamableHTTPClientTransport {
  private readonly responses = new Map<RequestId, () => Promise<void>>();
  readonly associations = new WeakMap<JSONRPCMessage, RequestId>();
  constructor(url: URL, options: StreamableHTTPClientTransportOptions) {
    super(url, {
      ...options,
      fetch: async (target, init) => {
        const response = await (options.fetch ?? fetch)(target, init);
        const sent: unknown =
          init?.method === "POST" && typeof init.body === "string"
            ? JSON.parse(init.body)
            : undefined;
        if (!isJSONRPCRequest(sent) || !response.ok || response.status === 202)
          return response;
        let completed = false;
        const deliver = (value: unknown) => {
          const message = JSONRPCMessageSchema.parse(value);
          if (!("method" in message)) {
            if (message.id !== sent.id)
              throw new Error("Upstream response ID mismatch");
            completed = true;
          }
          this.associations.set(message, sent.id);
          this.onmessage?.(message);
        };
        const contentType = response.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase();
        if (
          contentType !== "text/event-stream" &&
          contentType !== "application/json"
        )
          return response;
        // Consume after super.send has retained session headers, including initialize.
        this.responses.set(sent.id, async () => {
          if (contentType === "application/json")
            deliver(await response.json());
          else if (response.body) await readEvents(response.body, deliver);
          if (!completed)
            throw new Error("Upstream stream ended without a response");
        });
        return new Response(null, { status: 202, headers: response.headers });
      },
    });
  }
  override async send(message: JSONRPCMessage, options?: TransportSendOptions) {
    await super.send(message, options);
    if (!isJSONRPCRequest(message)) return;
    const consume = this.responses.get(message.id);
    this.responses.delete(message.id);
    if (consume)
      void consume().catch(() => {
        this.onerror?.(new Error("Upstream response stream failed"));
        void this.close();
      });
  }
}

/** SSE lines allow CR, LF, CRLF and multiline data; comments and non-message events are ignored. */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  deliver: (value: unknown) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    data: string[] = [],
    event = "";
  const line = (value: string) => {
    if (!value) {
      const payload = data.join("\n");
      if (payload && (!event || event === "message"))
        deliver(JSON.parse(payload));
      data = [];
      event = "";
    } else if (value === "data") data.push("");
    else if (value === "event") event = "";
    else if (value.startsWith("data:"))
      data.push(value.slice(5).replace(/^ /, ""));
    else if (value.startsWith("event:"))
      event = value.slice(6).replace(/^ /, "");
  };
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        if (buffer.endsWith("\r")) line(buffer.slice(0, -1));
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        if (match[0] === "\r" && match.index === buffer.length - 1) break;
        line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
