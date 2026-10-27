import { AssociatedHTTPTransport } from "./http-relay.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Context, Effect, Exit, Scope } from "effect";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DownstreamTransport } from "./downstream.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isInitializeRequest,
  isJSONRPCResultResponse,
  isJSONRPCRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { AppError } from "./model.js";
import { Store, type Profile, type Secret } from "./store.js";
import { OAuth } from "./oauth.js";
interface Session {
  profileId: string;
  down: DownstreamTransport;
  up: Transport;
  scope: Scope.Closeable;
  touched: number;
  pending: JSONRPCMessage[];
  pendingBytes: number;
  get?: ServerResponse;
}
export class ProxyService extends Context.Service<
  ProxyService,
  ProxySessions
>()("mcproxy/ProxySessions") {}
export class ProxySessions {
  readonly sessions = new Map<string, Session>();
  private stopping = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly store: Store,
    private readonly oauth: OAuth,
  ) {
    this.timer = setInterval(() => {
      for (const [id, s] of this.sessions)
        if (Date.now() - s.touched > 30 * 60_000) void this.close(id);
    }, 60_000);
    this.timer.unref();
  }
  async upstream(profile: Profile): Promise<Transport> {
    const provider = this.store.provider(profile.providerId);
    await this.oauth.ready(profile.id);
    const secret = this.store.secret(profile.id);
    if (provider.transport.type === "stdio")
      return new StdioClientTransport({
        ...provider.transport,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "",
          ...(secret.auth.type === "env" ? secret.auth.env : {}),
        },
        stderr: "ignore",
      });
    const headers: Record<string, string> =
      secret.auth.type === "bearer"
        ? { Authorization: `Bearer ${secret.auth.token}` }
        : secret.auth.type === "headers"
          ? secret.auth.headers
          : {};
    return new AssociatedHTTPTransport(new URL(provider.transport.url), {
      requestInit: { headers },
      fetch: async (url, init) => {
        const request = {
          ...init,
          ...(init?.method === "DELETE"
            ? { signal: AbortSignal.timeout(2000) }
            : {}),
        };
        if (secret.auth.type !== "oauth") return fetch(url, request);
        await this.oauth.ready(profile.id);
        const accessToken = this.store.secret(profile.id).tokens?.access_token;
        const send = (accessToken: string | undefined) => {
          const headers = new Headers(init?.headers);
          if (accessToken)
            headers.set("Authorization", `Bearer ${accessToken}`);
          return fetch(url, { ...request, headers });
        };
        const response = await send(accessToken);
        if (response.status !== 401 || !accessToken) return response;
        await response.body?.cancel();
        await this.oauth.ready(profile.id, accessToken);
        return send(this.store.secret(profile.id).tokens?.access_token);
      },
    });
  }
  async close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.pending.length = 0;
    s.pendingBytes = 0;
    await Effect.runPromise(Scope.close(s.scope, Exit.void));
  }
  async closeProfile(id: string) {
    await Promise.all(
      [...this.sessions]
        .filter(([, s]) => s.profileId === id)
        .map(([key]) => this.close(key)),
    );
  }
  async dispose() {
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
  async handle(
    profile: Profile,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ) {
    if (this.stopping)
      throw new AppError("shutting_down", "Daemon is shutting down", 503);
    const header = req.headers["mcp-session-id"];
    if (Array.isArray(header))
      throw new AppError("invalid_session", "Invalid session");
    let session = header ? this.sessions.get(header) : undefined;
    if (header && (!session || session.profileId !== profile.id))
      throw new AppError("invalid_session", "Session not found", 404);
    if (!session) {
      if (req.method !== "POST" || !isInitializeRequest(body))
        throw new AppError(
          "initialize_required",
          "Initialize a new session",
          400,
        );
      if (this.sessions.size >= 256)
        throw new AppError("session_limit", "Too many sessions", 503);
      const id = randomUUID();
      const scope = Scope.makeUnsafe();
      const generation = this.store.generation(profile.id);
      const up = await this.upstream(profile);
      try {
        this.store.assertGeneration(profile.id, generation);
        if (this.stopping)
          throw new AppError("shutting_down", "Daemon is shutting down", 503);
        const current = this.store.profile(profile.id);
        if (
          current.tokenHash !== profile.tokenHash ||
          JSON.stringify(this.store.secret(profile.id).auth) !==
            JSON.stringify(this.store.vault.open<Secret>(profile.secret).auth)
        )
          throw new AppError(
            "profile_changed",
            "Profile changed. Initialize again",
            401,
          );
      } catch (error) {
        await up.close().catch(() => {});
        throw error;
      }
      const down = new DownstreamTransport({
        sessionIdGenerator: () => id,
      });
      session = {
        profileId: profile.id,
        up,
        down,
        scope,
        touched: Date.now(),
        pending: [],
        pendingBytes: 0,
      };
      const currentSession = session;
      this.sessions.set(id, session);
      const cleanup = () => {
        void this.close(id);
      };
      up.onclose = cleanup;
      down.onclose = cleanup;
      up.onerror = () => {};
      down.onerror = () => {};
      up.onmessage = (message) => {
        if (!this.sessions.has(id)) return;
        if (
          isJSONRPCResultResponse(message) &&
          typeof message.result.protocolVersion === "string"
        )
          up.setProtocolVersion?.(message.result.protocolVersion);
        const relatedRequestId =
          up instanceof AssociatedHTTPTransport
            ? up.associations.get(message)
            : undefined;
        const response = !("method" in message);
        if (
          !response &&
          relatedRequestId === undefined &&
          (!currentSession.get || currentSession.get.destroyed)
        ) {
          currentSession.pendingBytes += Buffer.byteLength(
            JSON.stringify(message),
          );
          if (
            currentSession.pending.length >= 128 ||
            currentSession.pendingBytes > 1024 * 1024
          ) {
            cleanup();
            return;
          }
          currentSession.pending.push(message);
          return;
        }
        void down.send(message, { relatedRequestId }).catch(cleanup);
      };
      down.onmessage = (message) => {
        void up.send(message).catch(() => {
          if (isJSONRPCRequest(message))
            void down
              .send({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32000, message: "Upstream request failed" },
              })
              .catch(cleanup);
          else cleanup();
        });
      };
      await Effect.runPromise(
        Effect.acquireRelease(Effect.succeed(session), (s) =>
          Effect.promise(async () => {
            s.up.onmessage = undefined;
            s.down.onmessage = undefined;
            s.up.onclose = undefined;
            s.down.onclose = undefined;
            if (s.up instanceof StreamableHTTPClientTransport)
              await s.up.terminateSession().catch(() => {});
            await Promise.allSettled([s.up.close(), s.down.close()]);
          }),
        ).pipe(Effect.provideService(Scope.Scope, scope)),
      );
      try {
        await up.start();
        await down.start();
      } catch {
        await this.close(id);
        throw new AppError(
          "upstream_failed",
          "Could not connect to upstream",
          502,
        );
      }
    }
    session.touched = Date.now();
    const active = session;
    await session.down.handleNodeRequest(req, res, body, async () => {
      active.get = res;
      res.once("close", () => {
        if (active.get === res) active.get = undefined;
      });
      const queued = active.pending.splice(0);
      active.pendingBytes = 0;
      for (const message of queued) await active.down.send(message);
    });
    if (req.method === "DELETE" && header) await this.close(header);
  }
  async test(profile: Profile) {
    const generation = this.store.generation(profile.id);
    let up: Transport | undefined;
    const client = new Client({
      name: "mcproxy-connection-test",
      version: "0.1.0",
    });
    try {
      up = await this.upstream(profile);
      await client.connect(up, { timeout: 10_000 });
      this.store.assertGeneration(profile.id, generation);
      this.store.update(profile.id, { status: "ready" });
      return {
        ok: true,
        message: "Upstream initialized",
        capabilities: client.getServerCapabilities() ?? {},
      };
    } catch {
      if (
        this.store.generation(profile.id) === generation &&
        this.store.profile(profile.id).status !== "needs_auth"
      )
        this.store.update(profile.id, { status: "error" });
      return {
        ok: false,
        message: "Upstream connection or initialization failed",
      };
    } finally {
      if (up instanceof StreamableHTTPClientTransport)
        await up.terminateSession().catch(() => {});
      await client.close();
    }
  }
}
