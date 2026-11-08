-- Password sign-ins (DISP-71): one row per browser session, so a session can be listed and revoked
-- (sign out, "sign out everywhere", a changed password). Only the SHA-256 of the cookie's secret is
-- kept. Sessions of earlier versions (a signed timestamp, no row) stop working: sign in once more.
CREATE TABLE web_sessions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,              -- the browser, from its user agent: "Mac", "iPhone"
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  last_used_at TEXT
);
