import { createProxyServer } from "./server.js";
const port = process.env.PORT ? Number(process.env.PORT) : 7433;
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be between 1 and 65535");
const server = await createProxyServer({ port });
console.log(`mcproxy listening at ${server.url}`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void server
      .close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  });
