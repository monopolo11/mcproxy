import {
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInput } from "./model.js";

/** Auth types a probe can tell apart; headers and env are never inferred. */
export type DiscoveredAuth = Extract<AuthInput["type"], "none" | "bearer" | "oauth">;

const fetchFn = (input: string | URL, init?: RequestInit) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(10_000) });

/**
 * Guesses the auth an HTTP MCP upstream wants by sending it an unauthenticated
 * initialize. Success means none; a 401 or 403 means OAuth when protected
 * resource or authorization server metadata exists, otherwise a bearer token.
 * Returns null when the answer says nothing about auth or the upstream is
 * unreachable.
 */
export async function discoverAuth(url: string): Promise<DiscoveredAuth | null> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "mcproxy", version: "discovery" },
        },
      }),
    });
    await response.body?.cancel();
  } catch {
    return null;
  }
  if (response.ok) {
    // End the session the probe opened, if the upstream made one.
    const session = response.headers.get("mcp-session-id");
    if (session)
      await fetchFn(url, { method: "DELETE", headers: { "mcp-session-id": session } })
        .then((r) => r.body?.cancel())
        .catch(() => {});
    return "none";
  }
  if (response.status !== 401 && response.status !== 403) return null;
  const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);
  try {
    const { authorizationServerMetadata, resourceMetadata } =
      await discoverOAuthServerInfo(url, { resourceMetadataUrl, fetchFn });
    if (authorizationServerMetadata || resourceMetadata) return "oauth";
  } catch {
    // Unreadable metadata is no evidence of OAuth.
  }
  return "bearer";
}
