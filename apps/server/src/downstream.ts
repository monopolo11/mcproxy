import type { IncomingMessage, ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/** Exposes successful GET installation through the public Web transport API. */
export class DownstreamTransport extends WebStandardStreamableHTTPServerTransport {
  async handleNodeRequest(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    onGet: () => Promise<void>,
  ) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value))
        for (const item of value) headers.append(key, item);
      else if (value !== undefined) headers.set(key, value);
    }
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers,
      ...(req.method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
    const response = await this.handleRequest(request, { parsedBody: body });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.flushHeaders();
    if (!response.body) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    res.once("close", cancel);
    if (res.destroyed) cancel();
    try {
      if (req.method === "GET" && response.status === 200) await onGet();
      while (!res.destroyed) {
        const next = await reader.read();
        if (next.done) break;
        if (!res.write(next.value) && !res.destroyed)
          await new Promise<void>((resolve) => {
            const done = () => {
              res.off("drain", done);
              res.off("close", done);
              resolve();
            };
            res.once("drain", done);
            res.once("close", done);
          });
      }
      res.end();
    } finally {
      res.off("close", cancel);
      reader.releaseLock();
    }
  }
}
