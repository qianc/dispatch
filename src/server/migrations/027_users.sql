-- People who use this install, and what each owns (DISP-63). The install owner inherits every
-- existing row on first start (Users.claim).
CREATE TABLE users (
  name TEXT PRIMARY KEY,
  default_worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT
);
ALTER TABLE workers    ADD COLUMN owner TEXT;
ALTER TABLE api_tokens ADD COLUMN user TEXT;
ALTER TABLE schedules  ADD COLUMN owner TEXT;
ALTER TABLE sessions   ADD COLUMN started_by TEXT;  -- NULL after claim = started by no user
CREATE INDEX workers_owner ON workers(owner);
CREATE INDEX sessions_started_by ON sessions(started_by);
