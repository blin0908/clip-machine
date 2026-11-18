-- Clip Machine accounts (Cloudflare D1). Videos never reach this database: only the settings the web app syncs.
-- Apply with:  npm run db:local   (dev)   or   npm run db:remote   (production)

CREATE TABLE IF NOT EXISTS users (
  id       TEXT PRIMARY KEY,                 -- random, not derived from the email
  email    TEXT NOT NULL UNIQUE,             -- stored lower-case
  pw       TEXT NOT NULL,                    -- pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>
  created  INTEGER NOT NULL                  -- unix seconds
);

-- Only a SHA-256 of each session token is stored, so a database leak does not hand out working logins.
CREATE TABLE IF NOT EXISTS sessions (
  token     TEXT PRIMARY KEY,                -- sha256(token), b64url
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created   INTEGER NOT NULL,
  expires   INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- One JSON document per account: presets, last-used settings, brand logo, results log, Studio import.
CREATE TABLE IF NOT EXISTS user_data (
  user_id  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data     TEXT NOT NULL,
  rev      INTEGER NOT NULL,                 -- bumps on every write; clients send the rev they started from
  updated  INTEGER NOT NULL
);

-- Rate limiting. Keys are hashes (of the IP or email), never the raw value; rows older than a day are pruned.
CREATE TABLE IF NOT EXISTS attempts (
  k   TEXT NOT NULL,
  at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_k_at ON attempts(k, at);
