import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { Context, Effect, Exit, Scope } from "effect";
import { ZodError } from "zod";
import {
  AppError,
  providerInput,
  profileInput,
  profilePatch,
  toolkitInput,
  toolkitPatch,
  compatible,
} from "./model.js";
import { Store, hash } from "./store.js";
import { localPlatform, Vault, type Platform } from "./platform.js";
import { OAuth } from "./oauth.js";
import { ProxySessions, ProxyService, type CloseReason } from "./proxy.js";
import { ToolkitSessions } from "./toolkit.js";
import { logger, reason } from "./log.js";
const log = logger("http");
export interface ServerOptions {
  stateDir?: string;
  port?: number;
  platform?: Platform;
  webDir?: string;
  devOrigin?: string;
}
export class Storage extends Context.Service<Storage, Store>()(
  "mcproxy/Storage",
) {}
const json = (res: ServerResponse, status: number, value?: unknown) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(value === undefined ? undefined : JSON.stringify(value));
};
async function body(req: IncomingMessage) {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const raw of req) {
    const chunk: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.length;
    if (length > 1024 * 1024)
      throw new AppError("body_too_large", "Request body exceeds 1 MiB", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } catch {
    throw new AppError("invalid_json", "Invalid JSON");
  }
}
export async function createProxyServer(options: ServerOptions = {}) {
  const platform = options.platform ?? localPlatform;
  const stateDir = options.stateDir ?? platform.stateDirectory();
  const scope = Scope.makeUnsafe();
  const acquire = <A>(open: () => Promise<A>, close: (a: A) => Promise<void>) =>
    Effect.runPromise(
      Effect.acquireRelease(
        Effect.tryPromise({
          try: open,
          catch: () =>
            new AppError(
              "startup_failed",
              "Could not initialize local service",
              500,
            ),
        }),
        (a) => Effect.promise(() => close(a)),
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    );
  try {
    const key = await platform.credentials.loadKey(stateDir);
    const store = await acquire(
      async () => new Store(stateDir, new Vault(key)),
      async (s) => s.close(),
    );
    let base = "";
    const oauth = new OAuth(store, () => base);
    const proxy = await acquire(
      async () => new ProxySessions(store, oauth),
      (p) => p.dispose(),
    );
    const toolkits = await acquire(
      async () => new ToolkitSessions(store, proxy),
      (t) => t.dispose(),
    );
    /** Profile sessions and any toolkit session that includes the profile. */
    const closeProfile = (id: string, why: CloseReason) =>
      Promise.all([proxy.closeProfile(id, why), toolkits.closeProfile(id, why)]);
    const runtime = Context.make(Storage, store).pipe(
      Context.add(ProxyService, proxy),
    );
    const run = Effect.runPromiseWith(runtime);
    const server = createServer((req, res) => {
      void run(
        Effect.gen(function* () {
          const storage = yield* Storage;
          const sessions = yield* ProxyService;
          yield* Effect.tryPromise({
            try: () => handle(storage, sessions, req, res),
            catch: (error) => {
              const failure =
                error instanceof AppError
                  ? error
                  : error instanceof ZodError
                    ? new AppError("validation", "Invalid request fields")
                    : error instanceof Error &&
                        "code" in error &&
                        String(error.code).startsWith("SQLITE_CONSTRAINT")
                      ? new AppError("conflict", "Slug already exists", 409)
                      : new AppError("internal", "Request failed", 500);
              // Path only: the query can carry OAuth codes and state.
              const fields = {
                method: req.method,
                path: req.url?.split("?")[0],
                status: failure.status,
                code: failure.code,
                error: failure === error ? undefined : reason(error),
              };
              if (failure.status >= 500) log.error("request failed", fields);
              else log.warn("request rejected", fields);
              return failure;
            },
          });
        }),
      ).catch((error) => {
        if (!res.headersSent)
          json(res, error instanceof AppError ? error.status : 500, {
            error: {
              code: error instanceof AppError ? error.code : "internal",
              message:
                error instanceof AppError ? error.message : "Request failed",
            },
          });
        else res.end();
      });
    });
    async function handle(
      storage: Store,
      sessions: ProxySessions,
      req: IncomingMessage,
      res: ServerResponse,
    ) {
      const host = req.headers.host;
      if (host !== new URL(base).host)
        throw new AppError("invalid_host", "Invalid Host", 403);
      const origin = req.headers.origin;
      if (
        origin &&
        origin !== base &&
        origin !== (options.devOrigin ?? "http://127.0.0.1:5173")
      )
        throw new AppError("invalid_origin", "Origin not allowed", 403);
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      );
      const url = new URL(req.url ?? "/", base);
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method;
      const authorize = (tokenHash: string, subject: string) => {
        const supplied = req.headers.authorization?.match(
          /^Bearer ([A-Za-z0-9_-]+)$/,
        )?.[1];
        if (
          !supplied ||
          !timingSafeEqual(Buffer.from(hash(supplied)), Buffer.from(tokenHash))
        )
          throw new AppError(
            "unauthorized",
            `A valid ${subject} bearer token is required`,
            401,
          );
        if (!["GET", "POST", "DELETE"].includes(method ?? ""))
          throw new AppError("method_not_allowed", "Method not allowed", 405);
      };
      if (parts[0] === "mcps") {
        const provider = storage
          .allProviders()
          .find((p) => p.slug === parts[1]);
        const profile =
          provider &&
          storage.allProfiles(provider.id).find((p) => p.slug === parts[2]);
        if (!profile || parts.length !== 3)
          throw new AppError("not_found", "Endpoint not found", 404);
        authorize(profile.tokenHash, "profile");
        await sessions.handle(
          profile,
          req,
          res,
          method === "POST" ? await body(req) : undefined,
        );
        return;
      }
      if (parts[0] === "toolkits") {
        const toolkit = storage.allToolkits().find((t) => t.slug === parts[1]);
        if (!toolkit || parts.length !== 2)
          throw new AppError("not_found", "Endpoint not found", 404);
        authorize(toolkit.tokenHash, "toolkit");
        await toolkits.handle(
          toolkit,
          req,
          res,
          method === "POST" ? await body(req) : undefined,
        );
        return;
      }
      if (url.pathname === "/oauth/callback" && method === "GET") {
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        if (!state || (!code && !url.searchParams.has("error")))
          throw new AppError(
            "oauth_state",
            "Missing authorization state or code",
          );
        try {
          const profileId = await oauth.callback(
            state,
            code,
            url.searchParams.get("error"),
          );
          await closeProfile(profileId, "reconnected");
        } catch (error) {
          const failure = error instanceof AppError
            ? error
            : new AppError("oauth_failed", "Authorization failed. Connect again to retry");
          res.writeHead(failure.status, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          const message = failure.message.replace(
            /[&<>"']/g,
            (character) => `&#${character.charCodeAt(0)};`,
          );
          res.end(
            `<!doctype html><title>Authorization failed</title><p>${message}</p><p>You can close this window.</p>`,
          );
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html",
          "cache-control": "no-store",
        });
        res.end(
          "<!doctype html><title>Connected</title><p>Connected. You can close this window.</p>",
        );
        return;
      }
      if (parts[0] === "api") {
        // Reading a secret gets the same CSRF marker as mutations.
        const requireMarker = () => {
          if (req.headers["x-mcproxy-request"] !== "1")
            throw new AppError(
              "request_header",
              "X-Mcproxy-Request: 1 is required",
              403,
            );
        };
        if (!["GET", "HEAD"].includes(method ?? "")) requireMarker();
        if (url.pathname === "/api/health" && method === "GET") {
          json(res, 200, {
            status: "ok",
            version: "0.1.0",
            platform: process.platform,
          });
          return;
        }
        if (url.pathname === "/api/providers") {
          if (method === "GET") {
            json(res, 200, { providers: storage.allProviders() });
            return;
          }
          if (method === "POST") {
            json(res, 201, {
              provider: storage.createProvider(
                providerInput.parse(await body(req)),
              ),
            });
            return;
          }
        }
        if (parts[1] === "providers" && parts[2]) {
          const id = parts[2];
          storage.provider(id);
          if (parts.length === 3 && method === "DELETE") {
            const profileIds = storage.allProfiles(id).map((p) => p.id);
            storage.deleteProvider(id);
            await Promise.all(
              profileIds.map((profileId) =>
                closeProfile(profileId, "profile-deleted"),
              ),
            );
            json(res, 204);
            return;
          }
          if (parts[3] === "profiles" && parts.length === 4) {
            if (method === "GET") {
              json(res, 200, {
                profiles: storage
                  .allProfiles(id)
                  .map((p) => storage.view(p, base)),
              });
              return;
            }
            if (method === "POST") {
              const result = storage.createProfile(
                id,
                profileInput.parse(await body(req)),
              );
              json(res, 201, {
                profile: storage.view(result.profile, base),
                accessToken: result.accessToken,
              });
              return;
            }
          }
        }
        if (parts[1] === "profiles" && parts[2]) {
          const id = parts[2];
          const p = storage.profile(id);
          if (parts.length === 3 && method === "DELETE") {
            storage.deleteProfile(id);
            await closeProfile(id, "profile-deleted");
            json(res, 204);
            return;
          }
          if (parts.length === 3 && method === "PATCH") {
            const patch = profilePatch.parse(await body(req));
            if (!patch.name && !patch.auth) {
              json(res, 200, { profile: storage.view(p, base) });
              return;
            }
            if (patch.auth) {
              compatible(storage.provider(p.providerId).transport, patch.auth);
            }
            const updated = storage.update(id, {
              ...(patch.name ? { name: patch.name } : {}),
              ...(patch.auth
                ? {
                    authType: patch.auth.type,
                    secret: storage.vault.seal({ auth: patch.auth }),
                    status:
                      patch.auth.type === "oauth" ? "needs_auth" : "ready",
                  }
                : {}),
            });
            if (patch.auth) await closeProfile(id, "credentials-changed");
            json(res, 200, { profile: storage.view(updated, base) });
            return;
          }
          if (parts.length === 4 && parts[3] === "token") {
            if (method === "GET") {
              requireMarker();
              json(res, 200, { accessToken: storage.revealToken(id) });
              return;
            }
            if (method === "POST") {
              const accessToken = storage.rotateToken(id);
              await sessions.closeProfile(id, "token-rotated");
              json(res, 200, { accessToken });
              return;
            }
          }
          if (parts.length === 4 && parts[3] === "tools" && method === "GET") {
            // Connects upstream with stored credentials, so it needs the CSRF marker.
            if (req.headers["x-mcproxy-request"] !== "1")
              throw new AppError(
                "request_header",
                "X-Mcproxy-Request: 1 is required",
                403,
              );
            json(res, 200, { tools: await sessions.tools(p) });
            return;
          }
          if (parts.length === 4 && parts[3] === "test" && method === "POST") {
            json(res, 200, await sessions.test(p));
            return;
          }
          if (
            parts.length === 5 &&
            parts[3] === "oauth" &&
            parts[4] === "start" &&
            method === "POST"
          ) {
            const authorization = await oauth.start(id);
            json(res, 200, authorization);
            return;
          }
        }
        if (url.pathname === "/api/toolkits") {
          if (method === "GET") {
            json(res, 200, {
              toolkits: storage
                .allToolkits()
                .map((t) => storage.toolkitView(t, base)),
            });
            return;
          }
          if (method === "POST") {
            const result = storage.createToolkit(
              toolkitInput.parse(await body(req)),
            );
            json(res, 201, {
              toolkit: storage.toolkitView(result.toolkit, base),
              accessToken: result.accessToken,
            });
            return;
          }
        }
        if (parts[1] === "toolkits" && parts[2]) {
          const id = parts[2];
          const t = storage.toolkit(id);
          if (parts.length === 3 && method === "DELETE") {
            storage.deleteToolkit(id);
            await toolkits.closeToolkit(id, "toolkit-deleted");
            json(res, 204);
            return;
          }
          if (parts.length === 3 && method === "PATCH") {
            const patch = toolkitPatch.parse(await body(req));
            const updated = storage.updateToolkit(id, patch);
            // New members mean new prefixes, so open sessions restart.
            if (patch.profileIds)
              await toolkits.closeToolkit(id, "members-changed");
            json(res, 200, { toolkit: storage.toolkitView(updated, base) });
            return;
          }
          if (parts.length === 4 && parts[3] === "token") {
            if (method === "GET") {
              requireMarker();
              json(res, 200, { accessToken: storage.revealToolkitToken(id) });
              return;
            }
            if (method === "POST") {
              const accessToken = storage.rotateToolkitToken(id);
              await toolkits.closeToolkit(id, "token-rotated");
              json(res, 200, { accessToken });
              return;
            }
          }
          if (parts.length === 4 && parts[3] === "test" && method === "POST") {
            json(res, 200, await toolkits.test(t));
            return;
          }
        }
        throw new AppError("not_found", "Route not found", 404);
      }
      if (method !== "GET" && method !== "HEAD")
        throw new AppError("not_found", "Route not found", 404);
      const root = resolve(
        options.webDir ??
          fileURLToPath(new URL("../../web/dist", import.meta.url)),
      );
      const path = resolve(root, "." + decodeURIComponent(url.pathname));
      const within = relative(root, path);
      if (
        within === ".." ||
        within.startsWith("../") ||
        within.startsWith("..\\") ||
        isAbsolute(within)
      )
        throw new AppError("not_found", "File not found", 404);
      let file = path;
      try {
        if (!(await stat(file)).isFile()) file = resolve(root, "index.html");
      } catch {
        file = resolve(root, "index.html");
      }
      let data: Buffer;
      try {
        data = await readFile(file);
      } catch {
        throw new AppError(
          "ui_not_built",
          "Build the web application first",
          404,
        );
      }
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
      };
      res.writeHead(200, {
        "content-type": mime[extname(file)] ?? "application/octet-stream",
      });
      res.end(method === "HEAD" ? undefined : data);
    }
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    await acquire(
      () =>
        new Promise<typeof server>((resolve, reject) => {
          server.once("error", reject);
          server.listen(options.port ?? 7433, "127.0.0.1", () => {
            server.off("error", reject);
            resolve(server);
          });
        }),
      async (s) => {
        await toolkits.dispose();
        await proxy.dispose();
        s.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          s.close((error) => (error ? reject(error) : resolve())),
        );
      },
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing listening address");
    base = `http://127.0.0.1:${address.port}`;
    return {
      url: base,
      port: address.port,
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
      sessionCount: () => proxy.sessions.size + toolkits.sessions.size,
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}
