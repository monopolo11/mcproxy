import { fileURLToPath } from "node:url";
import { trustExtraCertificates } from "./ca.js";
import { createProxyServer } from "./server.js";
import { portFromEnv } from "./platform.js";
import { logger, reason } from "./log.js";
import { gitSource, relaunch } from "./update.js";
const log = logger("server");
trustExtraCertificates();
// The checkout this daemon runs from, as src/ under tsx or dist/ when built.
const root = fileURLToPath(new URL("../../..", import.meta.url));
const server = await createProxyServer({
  port: portFromEnv(),
  updates: gitSource(root, () => relaunch(() => server.close())),
});
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
