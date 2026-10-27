// Each migration runs once inside a SQLite transaction before the listener opens.
export const migrations = [
  {
    version: 1,
    sql: `
    CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      transport TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      providerId TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      authType TEXT NOT NULL,
      secret TEXT NOT NULL,
      tokenHash TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX profiles_provider_slug ON profiles(providerId, slug);
  `,
  },
  {
    // Downstream tokens become revealable: the value is sealed with the vault
    // next to its hash. Profiles created before this stay hash-only until rotated.
    version: 2,
    sql: `
    ALTER TABLE profiles ADD COLUMN tokenSealed TEXT;
    ALTER TABLE profiles ADD COLUMN tokenIssuedAt TEXT;
  `,
  },
] as const;
