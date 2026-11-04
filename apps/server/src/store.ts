import { migrations } from "./migrations.js";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import {
  AppError,
  type AuthInput,
  type ProviderInput,
  compatible,
  rootPrefixes,
  toolPrefixes,
} from "./model.js";
import { Vault } from "./platform.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
export const providers = sqliteTable("providers", {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  transport: text({ mode: "json" })
    .$type<ProviderInput["transport"]>()
    .notNull(),
  createdAt: text().notNull(),
});
export const profiles = sqliteTable(
  "profiles",
  {
    id: text().primaryKey(),
    providerId: text()
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    name: text().notNull(),
    slug: text().notNull(),
    authType: text().$type<AuthInput["type"]>().notNull(),
    secret: text().notNull(),
    tokenHash: text().notNull(),
    tokenSealed: text(),
    tokenIssuedAt: text(),
    status: text().$type<"ready" | "needs_auth" | "error">().notNull(),
    createdAt: text().notNull(),
  },
  (table) => [
    uniqueIndex("profiles_provider_slug").on(table.providerId, table.slug),
  ],
);
export const toolkits = sqliteTable("toolkits", {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  tokenHash: text().notNull(),
  tokenSealed: text().notNull(),
  tokenIssuedAt: text().notNull(),
  createdAt: text().notNull(),
});
export const toolkitMembers = sqliteTable(
  "toolkit_members",
  {
    toolkitId: text()
      .notNull()
      .references(() => toolkits.id, { onDelete: "cascade" }),
    profileId: text()
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.toolkitId, table.profileId] })],
);
export const providerRoots = sqliteTable("provider_roots", {
  providerId: text()
    .primaryKey()
    .references(() => providers.id, { onDelete: "cascade" }),
  tokenHash: text().notNull(),
  tokenSealed: text().notNull(),
  tokenIssuedAt: text().notNull(),
  createdAt: text().notNull(),
});
export const settings = sqliteTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),
});
export type Toolkit = typeof toolkits.$inferSelect;
export type Provider = typeof providers.$inferSelect;
export type Profile = typeof profiles.$inferSelect;
export type ProviderRoot = typeof providerRoots.$inferSelect;
/** A profile served by a merged endpoint, with the prefix its tools get there. */
export interface GroupMember {
  profile: Profile;
  provider: Provider;
  prefix: string;
}
/**
 * An endpoint that merges its members' tools: a toolkit, or a provider's root.
 * Members are read when a session opens.
 */
export interface Group {
  /** Toolkit or provider id; sessions close by it. */
  id: string;
  /** Names the endpoint in logs, e.g. `{ toolkit: "work" }`. */
  log: { toolkit: string } | { root: string };
  /** Server name reported to clients. */
  name: string;
  members: () => GroupMember[];
}
export interface Secret {
  auth: AuthInput;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
  discovery?: OAuthDiscoveryState;
  oauthError?: string;
  pending?: {
    state: string;
    verifier?: string;
    expiresAt: number;
    client?: OAuthClientInformationMixed;
    discovery?: OAuthDiscoveryState;
    tokens?: OAuthTokens;
    tokenExpiresAt?: number;
  };
}
export const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export class Store {
  private readonly generations = new Map<string, number>();
  generation(id: string) {
    return this.generations.get(id) ?? 0;
  }
  assertGeneration(id: string, generation: number) {
    if (this.generation(id) !== generation)
      throw new AppError("profile_changed", "Profile credentials changed", 409);
    this.profile(id);
  }
  readonly sqlite: Database.Database;
  readonly db;
  constructor(
    dir: string,
    readonly vault: Vault,
  ) {
    this.sqlite = new Database(join(dir, "state.sqlite"));
    chmodSync(join(dir, "state.sqlite"), 0o600);
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("journal_mode = WAL");
    this.db = drizzle(this.sqlite);
    this.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)",
    );
    for (const migration of migrations) {
      if (
        this.sqlite
          .prepare("SELECT version FROM migrations WHERE version = ?")
          .get(migration.version)
      )
        continue;
      this.sqlite.transaction(() => {
        this.sqlite.exec(migration.sql);
        this.sqlite
          .prepare("INSERT INTO migrations VALUES (?)")
          .run(migration.version);
      })();
    }
  }
  close() {
    this.sqlite.close();
  }
  setting(key: string) {
    return this.db.select().from(settings).where(eq(settings.key, key)).get()
      ?.value;
  }
  setSetting(key: string, value: string) {
    this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }
  allProviders() {
    return this.db.select().from(providers).all();
  }
  provider(id: string) {
    const p = this.db
      .select()
      .from(providers)
      .where(eq(providers.id, id))
      .get();
    if (!p) throw new AppError("not_found", "Provider not found", 404);
    return p;
  }
  profile(id: string) {
    const p = this.db.select().from(profiles).where(eq(profiles.id, id)).get();
    if (!p) throw new AppError("not_found", "Profile not found", 404);
    return p;
  }
  allProfiles(providerId: string) {
    return this.db
      .select()
      .from(profiles)
      .where(eq(profiles.providerId, providerId))
      .all();
  }
  createProvider(input: ProviderInput) {
    const p = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.db.insert(providers).values(p).run();
    return p;
  }
  createProfile(
    providerId: string,
    input: { name: string; slug: string; auth: AuthInput },
  ) {
    compatible(this.provider(providerId).transport, input.auth);
    const accessToken = token();
    const p: Profile = {
      id: randomUUID(),
      providerId,
      name: input.name,
      slug: input.slug,
      authType: input.auth.type,
      secret: this.vault.seal({ auth: input.auth }),
      ...this.issueToken(accessToken),
      status: input.auth.type === "oauth" ? "needs_auth" : "ready",
      createdAt: new Date().toISOString(),
    };
    this.db.insert(profiles).values(p).run();
    return { profile: p, accessToken };
  }
  /** Hash for authentication plus the sealed value so the UI can show it again. */
  private issueToken(accessToken: string) {
    return {
      tokenHash: hash(accessToken),
      tokenSealed: this.vault.seal(accessToken),
      tokenIssuedAt: new Date().toISOString(),
    };
  }
  /** Replaces the downstream token; the caller closes the profile's sessions. */
  rotateToken(id: string) {
    const accessToken = token();
    this.db
      .update(profiles)
      .set(this.issueToken(accessToken))
      .where(eq(profiles.id, id))
      .run();
    return accessToken;
  }
  revealToken(id: string) {
    const sealed = this.profile(id).tokenSealed;
    if (!sealed)
      throw new AppError(
        "token_unavailable",
        "This token predates reveal support. Rotate it to get one you can view",
        409,
      );
    return this.vault.open<string>(sealed);
  }
  secret(id: string) {
    return this.vault.open<Secret>(this.profile(id).secret);
  }
  saveSecret(id: string, secret: Secret) {
    this.db
      .update(profiles)
      .set({ secret: this.vault.seal(secret) })
      .where(eq(profiles.id, id))
      .run();
  }
  update(
    id: string,
    patch: Partial<
      Pick<Profile, "name" | "status" | "tokenHash" | "authType" | "secret">
    >,
  ) {
    if (patch.secret !== undefined)
      this.generations.set(id, this.generation(id) + 1);
    this.db.update(profiles).set(patch).where(eq(profiles.id, id)).run();
    return this.profile(id);
  }
  deleteProfile(id: string) {
    this.profile(id);
    this.generations.set(id, this.generation(id) + 1);
    this.db.delete(profiles).where(eq(profiles.id, id)).run();
  }
  deleteProvider(id: string) {
    this.provider(id);
    for (const p of this.allProfiles(id))
      this.generations.set(p.id, this.generation(p.id) + 1);
    this.db.delete(providers).where(eq(providers.id, id)).run();
  }
  allToolkits() {
    return this.db.select().from(toolkits).all();
  }
  toolkit(id: string) {
    const t = this.db.select().from(toolkits).where(eq(toolkits.id, id)).get();
    if (!t) throw new AppError("not_found", "Toolkit not found", 404);
    return t;
  }
  /** Member profiles with their providers, in a stable order for prefixing. */
  toolkitMembers(id: string) {
    const rows = this.db
      .select({ profile: profiles, provider: providers })
      .from(toolkitMembers)
      .innerJoin(profiles, eq(toolkitMembers.profileId, profiles.id))
      .innerJoin(providers, eq(profiles.providerId, providers.id))
      .where(eq(toolkitMembers.toolkitId, id))
      .all();
    return rows.sort(
      (a, b) =>
        a.provider.slug.localeCompare(b.provider.slug) ||
        a.profile.slug.localeCompare(b.profile.slug),
    );
  }
  createToolkit(input: { name: string; slug: string; profileIds: string[] }) {
    const accessToken = token();
    const t: Toolkit = {
      id: randomUUID(),
      name: input.name,
      slug: input.slug,
      ...this.issueToken(accessToken),
      createdAt: new Date().toISOString(),
    };
    this.sqlite.transaction(() => {
      this.db.insert(toolkits).values(t).run();
      this.setMembers(t.id, input.profileIds);
    })();
    return { toolkit: t, accessToken };
  }
  updateToolkit(id: string, patch: { name?: string; profileIds?: string[] }) {
    this.toolkit(id);
    this.sqlite.transaction(() => {
      if (patch.name)
        this.db
          .update(toolkits)
          .set({ name: patch.name })
          .where(eq(toolkits.id, id))
          .run();
      if (patch.profileIds) {
        this.db
          .delete(toolkitMembers)
          .where(eq(toolkitMembers.toolkitId, id))
          .run();
        this.setMembers(id, patch.profileIds);
      }
    })();
    return this.toolkit(id);
  }
  private setMembers(toolkitId: string, profileIds: string[]) {
    const unique = [...new Set(profileIds)];
    for (const profileId of unique)
      if (
        !this.db
          .select({ id: profiles.id })
          .from(profiles)
          .where(eq(profiles.id, profileId))
          .get()
      )
        throw new AppError("invalid_member", "Profile not found");
    if (unique.length)
      this.db
        .insert(toolkitMembers)
        .values(unique.map((profileId) => ({ toolkitId, profileId })))
        .run();
  }
  deleteToolkit(id: string) {
    this.toolkit(id);
    this.db.delete(toolkits).where(eq(toolkits.id, id)).run();
  }
  rotateToolkitToken(id: string) {
    this.toolkit(id);
    const accessToken = token();
    this.db
      .update(toolkits)
      .set(this.issueToken(accessToken))
      .where(eq(toolkits.id, id))
      .run();
    return accessToken;
  }
  revealToolkitToken(id: string) {
    return this.vault.open<string>(this.toolkit(id).tokenSealed);
  }
  toolkitGroup(t: Toolkit): Group {
    return {
      id: t.id,
      log: { toolkit: t.slug },
      name: `mcproxy-toolkit-${t.slug}`,
      members: () => {
        const rows = this.toolkitMembers(t.id);
        const prefixes = toolPrefixes(rows);
        return rows.map((row) => ({ ...row, prefix: prefixes.get(row.profile.id)! }));
      },
    };
  }
  toolkitView(t: Toolkit, base: string) {
    const members = this.toolkitGroup(t).members();
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      tokenIssuedAt: t.tokenIssuedAt,
      createdAt: t.createdAt,
      endpoint: `${base}/toolkits/${t.slug}`,
      members: members.map(({ profile, provider, prefix }) => ({
        profileId: profile.id,
        providerId: provider.id,
        prefix,
      })),
    };
  }
  /** The provider's root endpoint, when enabled. */
  root(providerId: string) {
    return this.db
      .select()
      .from(providerRoots)
      .where(eq(providerRoots.providerId, providerId))
      .get();
  }
  private requireRoot(providerId: string) {
    const r = this.root(providerId);
    if (!r) throw new AppError("not_found", "Root endpoint not enabled", 404);
    return r;
  }
  createRoot(providerId: string) {
    this.provider(providerId);
    if (this.root(providerId))
      throw new AppError("conflict", "Root endpoint already enabled", 409);
    const accessToken = token();
    const r: ProviderRoot = {
      providerId,
      ...this.issueToken(accessToken),
      createdAt: new Date().toISOString(),
    };
    this.db.insert(providerRoots).values(r).run();
    return { root: r, accessToken };
  }
  deleteRoot(providerId: string) {
    this.requireRoot(providerId);
    this.db
      .delete(providerRoots)
      .where(eq(providerRoots.providerId, providerId))
      .run();
  }
  rotateRootToken(providerId: string) {
    this.requireRoot(providerId);
    const accessToken = token();
    this.db
      .update(providerRoots)
      .set(this.issueToken(accessToken))
      .where(eq(providerRoots.providerId, providerId))
      .run();
    return accessToken;
  }
  revealRootToken(providerId: string) {
    return this.vault.open<string>(this.requireRoot(providerId).tokenSealed);
  }
  /** Every profile of the provider, in slug order, prefixed by `rootPrefixes`. */
  rootGroup(provider: Provider): Group {
    return {
      id: provider.id,
      log: { root: provider.slug },
      name: `mcproxy-${provider.slug}`,
      members: () => {
        const rows = this.allProfiles(provider.id).sort((a, b) =>
          a.slug.localeCompare(b.slug),
        );
        const prefixes = rootPrefixes(rows);
        return rows.map((profile) => ({
          profile,
          provider,
          prefix: prefixes.get(profile.id)!,
        }));
      },
    };
  }
  /** Provider configuration plus its root endpoint, without token material. */
  providerView(p: Provider, base: string) {
    const r = this.root(p.id);
    return {
      ...p,
      ...(r
        ? {
            root: {
              endpoint: `${base}/mcps/${p.slug}`,
              tokenIssuedAt: r.tokenIssuedAt,
              createdAt: r.createdAt,
              members: this.rootGroup(p)
                .members()
                .map(({ profile, prefix }) => ({ profileId: profile.id, prefix })),
            },
          }
        : {}),
    };
  }
  /** `provider/profile` slugs, the profile's endpoint path; names it in logs. */
  label(p: Profile) {
    return `${this.provider(p.providerId).slug}/${p.slug}`;
  }
  view(p: Profile, base: string) {
    const secret = p.authType === "oauth" ? this.secret(p.id) : undefined;
    const expired = secret?.pending && secret.pending.expiresAt <= Date.now();
    const lastError = expired
      ? "Authorization expired. Connect again to retry"
      : secret?.oauthError;
    return {
      id: p.id,
      providerId: p.providerId,
      name: p.name,
      slug: p.slug,
      authType: p.authType,
      status: p.status,
      ...(secret ? {
        oauthStatus: lastError ? "error" : secret.pending ? "pending" : "idle",
        ...(lastError ? { lastError } : {}),
      } : {}),
      createdAt: p.createdAt,
      ...(p.tokenIssuedAt ? { tokenIssuedAt: p.tokenIssuedAt } : {}),
      endpoint: `${base}/mcps/${this.label(p)}`,
    };
  }
}
