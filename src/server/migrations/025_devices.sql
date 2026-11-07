-- Paired devices: a phone's home-screen app that cannot use the sign-in proxy's SSO gets its own
-- session, approved by a signed-in person. Only the hash of its secret is kept.
CREATE TABLE devices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  user TEXT NOT NULL,              -- who approved it; the device acts as this person
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
