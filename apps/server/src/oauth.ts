import {
  auth as sdkAuth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { type OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { AppError } from "./model.js";
import { Store, token } from "./store.js";
const auth: typeof sdkAuth = (provider, options) =>
  sdkAuth(provider, {
    scope: provider.clientMetadata.scope,
    ...options,
    fetchFn: (url, init) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
  });
export class OAuth {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(
    private readonly store: Store,
    private readonly base: () => string,
  ) {}
  async exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  provider(
    id: string,
    onRedirect?: (url: string) => void,
  ): OAuthClientProvider {
    const generation = this.store.generation(id);
    const read = () => {
      this.store.assertGeneration(id, generation);
      return this.store.secret(id);
    };
    const change = (update: Partial<ReturnType<typeof read>>) =>
      this.store.saveSecret(id, { ...read(), ...update });
    const secret = read();
    if (secret.auth.type !== "oauth")
      throw new AppError("invalid_auth", "Profile does not use OAuth");
    const settings = secret.auth;
    return {
      redirectUrl: `${this.base()}/oauth/callback`,
      clientMetadata: {
        client_name: "mcproxy",
        redirect_uris: [`${this.base()}/oauth/callback`],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: settings.clientSecret
          ? "client_secret_post"
          : "none",
        ...(settings.scopes ? { scope: settings.scopes.join(" ") } : {}),
      },
      state: () => {
        const p = read().pending;
        if (!p) throw new AppError("oauth_state", "No pending authorization");
        return p.state;
      },
      clientInformation: () =>
        read().client ??
        (settings.clientId
          ? ({
              client_id: settings.clientId,
              ...(settings.clientSecret
                ? { client_secret: settings.clientSecret }
                : {}),
            } satisfies OAuthClientInformationMixed)
          : undefined),
      saveClientInformation: (client) => change({ client }),
      tokens: () => read().tokens,
      saveTokens: (tokens) => {
        const old = read().tokens;
        change({
          tokens: {
            ...tokens,
            ...(!tokens.refresh_token && old?.refresh_token
              ? { refresh_token: old.refresh_token }
              : {}),
          },
          expiresAt:
            typeof tokens.expires_in === "number"
              ? Date.now() + tokens.expires_in * 1000
              : undefined,
        });
        this.store.update(id, { status: "ready" });
      },
      redirectToAuthorization: (url) => {
        if (!onRedirect)
          throw new AppError("needs_auth", "Reconnect this profile", 401);
        onRedirect(url.toString());
      },
      saveCodeVerifier: (verifier) => {
        const pending = read().pending;
        if (!pending)
          throw new AppError("oauth_state", "No pending authorization");
        change({ pending: { ...pending, verifier } });
      },
      codeVerifier: () => {
        const verifier = read().pending?.verifier;
        if (!verifier)
          throw new AppError("oauth_state", "Missing PKCE verifier");
        return verifier;
      },
      discoveryState: () => read().discovery,
      saveDiscoveryState: (discovery) => change({ discovery }),
      invalidateCredentials: (scope) => {
        const s = read();
        if (scope === "all" || scope === "tokens") {
          delete s.tokens;
          delete s.expiresAt;
        }
        if (scope === "all" || scope === "client") delete s.client;
        if (scope === "all" || scope === "discovery") delete s.discovery;
        if (scope === "all" || scope === "verifier") {
          if (s.pending) delete s.pending.verifier;
        }
        this.store.saveSecret(id, s);
      },
    };
  }
  async start(id: string) {
    return this.exclusive(id, async () => {
      const p = this.store.profile(id);
      const upstream = this.store.provider(p.providerId);
      if (upstream.transport.type !== "http" || p.authType !== "oauth")
        throw new AppError(
          "invalid_auth",
          "OAuth requires an HTTP OAuth profile",
        );
      const secret = this.store.secret(id);
      delete secret.tokens;
      delete secret.expiresAt;
      secret.pending = { state: token(), expiresAt: Date.now() + 10 * 60_000 };
      this.store.saveSecret(id, secret);
      this.store.update(id, { status: "needs_auth" });
      let authorizationUrl: string | undefined;
      await auth(
        this.provider(id, (url) => {
          authorizationUrl = url;
        }),
        { serverUrl: upstream.transport.url },
      );
      if (!authorizationUrl)
        throw new AppError(
          "oauth_failed",
          "Authorization did not produce a redirect",
        );
      return { authorizationUrl };
    });
  }
  async callback(state: string, code: string | null, denied?: string | null) {
    const found = this.store
      .allProviders()
      .flatMap((p) => this.store.allProfiles(p.id))
      .find((p) => this.store.secret(p.id).pending?.state === state);
    if (!found)
      throw new AppError("oauth_state", "Invalid authorization state");
    return this.exclusive(found.id, async () => {
      const secret = this.store.secret(found.id);
      if (
        !secret.pending ||
        secret.pending.state !== state ||
        secret.pending.expiresAt < Date.now()
      )
        throw new AppError("oauth_state", "Expired authorization state");
      if (denied) {
        delete secret.pending;
        this.store.saveSecret(found.id, secret);
        this.store.update(found.id, { status: "needs_auth" });
        throw new AppError(
          "oauth_denied",
          denied === "access_denied"
            ? "Authorization was denied. Connect again to retry"
            : "Authorization failed. Connect again to retry",
        );
      }
      if (!code)
        throw new AppError("oauth_state", "Missing authorization code");
      const generation = this.store.generation(found.id);
      const upstream = this.store.provider(found.providerId);
      if (upstream.transport.type !== "http")
        throw new AppError("invalid_auth", "OAuth requires HTTP");
      try {
        const result = await auth(this.provider(found.id), {
          serverUrl: upstream.transport.url,
          authorizationCode: code,
        });
        if (result !== "AUTHORIZED")
          throw new Error("Authorization incomplete");
      } finally {
        this.store.assertGeneration(found.id, generation);
        const current = this.store.secret(found.id);
        delete current.pending;
        this.store.saveSecret(found.id, current);
      }
    });
  }
  async ready(id: string, rejectedToken?: string) {
    return this.exclusive(id, async () => {
      const generation = this.store.generation(id);
      const p = this.store.profile(id);
      const s = this.store.secret(id);
      if (p.authType !== "oauth") return;
      if (!s.tokens)
        throw new AppError("needs_auth", "Connect this profile first", 401);
      if (rejectedToken && s.tokens.access_token !== rejectedToken) return;
      if (rejectedToken || (s.expiresAt && s.expiresAt < Date.now() + 30_000)) {
        const upstream = this.store.provider(p.providerId);
        if (upstream.transport.type !== "http")
          throw new Error("Invalid OAuth transport");
        try {
          await auth(this.provider(id), { serverUrl: upstream.transport.url });
        } catch {
          this.store.assertGeneration(id, generation);
          this.store.update(id, { status: "needs_auth" });
          throw new AppError("needs_auth", "Reconnect this profile", 401);
        }
      }
    });
  }
}
