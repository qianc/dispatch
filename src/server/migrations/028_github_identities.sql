-- Each person's own GitHub connection (DISP-63). token_enc is sealed with the server's secret key
-- (secretBox.ts) and bound to the user; the token itself is never stored or sent to a browser.
CREATE TABLE github_identities (
  user TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('oauth','pat')),
  github_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  git_name TEXT NOT NULL,
  git_email TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  scopes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  verified_at TEXT,
  last_error TEXT
);
