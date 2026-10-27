import { trustExtraCertificates } from "./ca.js";
import { createProxyServer } from "./server.js";
import { logger, reason } from "./log.js";
const log = logger("server");
trustExtraCertificates();
const port = process.env.PORT ? Number(process.env.PORT) : 7433;
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be between 1 and 65535");
const server = await createProxyServer({ port });
log.info("listening", { url: server.url });
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log.info("stopping", { signal });
    void server
      .close()
      .then(() => {
        log.info("stopped");
        process.exitCode = 0;
      })
      .catch((error) => {
        log.error("shutdown failed", { error: reason(error) });
        process.exitCode = 1;
      });
  });
