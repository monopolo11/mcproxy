import { trustExtraCertificates } from "./ca.js";
import { createProxyServer } from "./server.js";
import { portFromEnv } from "./platform.js";
import { logger, reason } from "./log.js";
const log = logger("server");
trustExtraCertificates();
const server = await createProxyServer({ port: portFromEnv() });
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
