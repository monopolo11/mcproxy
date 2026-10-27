import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ToolListChangedNotificationSchema,
  isInitializeRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { DownstreamTransport } from "./downstream.js";
import { AppError, toolPrefixes } from "./model.js";
import { ProxySessions, listAllTools, type CloseReason } from "./proxy.js";
import type { Profile, Provider, Store, Toolkit } from "./store.js";
import { logger, reason } from "./log.js";

const log = logger("toolkit");

/** One member of a toolkit inside one downstream session. */
interface Member {
  profile: Profile;
  provider: Provider;
  prefix: string;
  /** Lazily opened upstream; dropped on failure so the next request retries. */
  connecting?: Promise<Client>;
  /** Prefixed name to upstream name, from the last successful tools/list. */
  tools: Map<string, string>;
}
interface Session {
  toolkitId: string;
  /** Toolkit slug, for logs. */
  label: string;
  members: Member[];
  down: DownstreamTransport;
  server: Server;
  touched: number;
}

/**
 * Serves a toolkit: one MCP endpoint whose tools are the union of its member
 * profiles' tools, each renamed with the member's prefix. Every downstream
 * session owns its own upstream connections, like profile sessions do.
 */
export class ToolkitSessions {
  readonly sessions = new Map<string, Session>();
  private stopping = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly store: Store,
    private readonly proxy: ProxySessions,
  ) {
    this.timer = setInterval(() => {
      for (const [id, s] of this.sessions)
        if (Date.now() - s.touched > 30 * 60_000) void this.close(id, "idle");
    }, 60_000);
    this.timer.unref();
  }
  async close(id: string, why: CloseReason) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    log.info("session closed", { session: id, toolkit: s.label, reason: why });
    s.down.onclose = undefined;
    await Promise.allSettled([
      s.server.close(),
      ...s.members.map((m) => disconnect(m)),
    ]);
  }
  async closeToolkit(toolkitId: string, why: CloseReason) {
    await this.closeWhere((s) => s.toolkitId === toolkitId, why);
  }
  /** Credentials or membership of a profile changed: drop sessions using it. */
  async closeProfile(profileId: string, why: CloseReason) {
    await this.closeWhere(
      (s) => s.members.some((m) => m.profile.id === profileId),
      why,
    );
  }
  private async closeWhere(match: (s: Session) => boolean, why: CloseReason) {
    await Promise.all(
      [...this.sessions]
        .filter(([, s]) => match(s))
        .map(([id]) => this.close(id, why)),
    );
  }
  async dispose() {
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.all(
      [...this.sessions.keys()].map((id) => this.close(id, "shutdown")),
    );
  }
  async handle(
    toolkit: Toolkit,
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
    if (header && (!session || session.toolkitId !== toolkit.id))
      throw new AppError("invalid_session", "Session not found", 404);
    let created: string | undefined;
    if (!session) {
      if (req.method !== "POST" || !isInitializeRequest(body))
        throw new AppError(
          "initialize_required",
          "Initialize a new session",
          400,
        );
      if (this.sessions.size + this.proxy.sessions.size >= 256)
        throw new AppError("session_limit", "Too many sessions", 503);
      const id = randomUUID();
      session = this.create(id, toolkit);
      this.sessions.set(id, session);
      created = id;
      try {
        await session.server.connect(session.down);
      } catch {
        await this.close(id, "initialize-rejected");
        throw new AppError("internal", "Request failed", 500);
      }
      log.info("session opened", {
        session: id,
        toolkit: toolkit.slug,
        members: session.members.length,
      });
    }
    session.touched = Date.now();
    try {
      const status = await session.down.handleNodeRequest(
        req,
        res,
        body,
        async () => {},
      );
      if (created && status >= 400)
        await this.close(created, "initialize-rejected");
    } catch (error) {
      if (created) await this.close(created, "initialize-rejected");
      throw error;
    }
    if (req.method === "DELETE" && header)
      await this.close(header, "client-closed");
  }
  private create(id: string, toolkit: Toolkit): Session {
    const rows = this.store.toolkitMembers(toolkit.id);
    const prefixes = toolPrefixes(rows);
    const members: Member[] = rows.map(({ profile, provider }) => ({
      profile,
      provider,
      prefix: prefixes.get(profile.id)!,
      tools: new Map(),
    }));
    const server = new Server(
      { name: `mcproxy-toolkit-${toolkit.slug}`, version: "0.1.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    const down = new DownstreamTransport({ sessionIdGenerator: () => id });
    down.onclose = () => {
      void this.close(id, "client-closed");
    };
    const session: Session = {
      toolkitId: toolkit.id,
      label: toolkit.slug,
      members,
      down,
      server,
      touched: Date.now(),
    };
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const lists = await Promise.allSettled(
        members.map((m) => this.listMember(session, m)),
      );
      const tools = lists.flatMap((r) =>
        r.status === "fulfilled" ? r.value : [],
      );
      if (members.length && lists.every((r) => r.status === "rejected"))
        throw new McpError(
          ErrorCode.InternalError,
          "No toolkit member is reachable",
        );
      return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args, _meta } = request.params;
      let member = members.find((m) => m.tools.has(name));
      if (!member) {
        // The client may call before listing, or after a list change.
        await Promise.allSettled(
          members
            .filter((m) => name.startsWith(m.prefix))
            .map((m) => this.listMember(session, m)),
        );
        member = members.find((m) => m.tools.has(name));
      }
      if (!member)
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
      const client = await this.connect(session, member);
      try {
        return await client.request(
          {
            method: "tools/call",
            params: {
              name: member.tools.get(name)!,
              ...(args ? { arguments: args } : {}),
              ...(_meta ? { _meta } : {}),
            },
          },
          CallToolResultSchema,
          { signal: extra.signal, timeout: 10 * 60_000, resetTimeoutOnProgress: true },
        );
      } catch (error) {
        throw passthrough(error);
      }
    });
    return session;
  }
  /** Lists one member's tools, renaming them and refreshing the name map. */
  private async listMember(session: Session, member: Member) {
    const client = await this.connect(session, member);
    const tools = client.getServerCapabilities()?.tools
      ? await listAllTools(client)
      : [];
    member.tools = new Map(
      tools.map((tool) => [member.prefix + tool.name, tool.name]),
    );
    return tools.map(
      (tool): Tool => ({ ...tool, name: member.prefix + tool.name }),
    );
  }
  private connect(session: Session, member: Member) {
    member.connecting ??= (async () => {
      const client = new Client({ name: "mcproxy-toolkit", version: "0.1.0" });
      let up: Transport | undefined;
      try {
        up = await this.proxy.upstream(member.profile);
        await client.connect(up, { timeout: 10_000 });
      } catch (error) {
        log.warn("member connect failed", {
          toolkit: session.label,
          profile: `${member.provider.slug}/${member.profile.slug}`,
          error: reason(error),
        });
        member.connecting = undefined;
        if (up instanceof StreamableHTTPClientTransport)
          await up.terminateSession().catch(() => {});
        await client.close().catch(() => {});
        throw error;
      }
      client.onclose = () => {
        member.connecting = undefined;
        member.tools.clear();
      };
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        member.tools.clear();
        void session.server.sendToolListChanged().catch(() => {});
      });
      return client;
    })();
    return member.connecting;
  }
  /** Connects to each member once and reports its prefixed tool names. */
  async test(toolkit: Toolkit) {
    const rows = this.store.toolkitMembers(toolkit.id);
    const prefixes = toolPrefixes(rows);
    const members = await Promise.all(
      rows.map(async ({ profile }) => {
        const prefix = prefixes.get(profile.id)!;
        try {
          const tools = await this.proxy.inspect(profile, async (client) =>
            client.getServerCapabilities()?.tools
              ? listAllTools(client)
              : [],
          );
          return {
            profileId: profile.id,
            ok: true,
            message: "Upstream initialized",
            tools: tools.map((tool) => prefix + tool.name),
          };
        } catch (error) {
          log.warn("member test failed", {
            toolkit: toolkit.slug,
            profile: this.store.label(profile),
            error: reason(error),
          });
          return {
            profileId: profile.id,
            ok: false,
            message: "Upstream connection or initialization failed",
            tools: [],
          };
        }
      }),
    );
    return { members };
  }
}

async function disconnect(member: Member) {
  const connecting = member.connecting;
  member.connecting = undefined;
  if (!connecting) return;
  const client = await connecting.catch(() => undefined);
  if (!client) return;
  client.onclose = undefined;
  const up = client.transport;
  if (up instanceof StreamableHTTPClientTransport)
    await up.terminateSession().catch(() => {});
  await client.close().catch(() => {});
}

/**
 * An upstream JSON-RPC error keeps its code, data and original message; the
 * SDK client wraps the message with its own prefix, which is stripped here.
 */
function passthrough(error: unknown) {
  if (error instanceof McpError)
    return Object.assign(
      new Error(error.message.replace(/^MCP error -?\d+: /, "")),
      { code: error.code, data: error.data },
    );
  return new McpError(ErrorCode.InternalError, "Upstream request failed");
}
