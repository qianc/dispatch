-- Named personal access tokens (scripts, skills). Only a SHA-256 of the secret is kept.
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,            -- first characters, to recognise a token in the list
  hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,            -- JSON array
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);

-- OAuth clients that registered themselves (MCP clients such as Claude), and what they were granted.
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,     -- JSON array
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE oauth_grants (
  id INTEGER PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user TEXT NOT NULL,
  scopes TEXT NOT NULL,            -- JSON array
  access_hash TEXT NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  refresh_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX oauth_grants_client ON oauth_grants(client_id);
