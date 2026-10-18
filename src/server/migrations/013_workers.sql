-- Several workers. Each has a record and its own token (only a SHA-256 of the secret is kept).
-- The row with no hash is the legacy worker: it connects with the server's WORKER_TOKEN.
CREATE TABLE workers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL DEFAULT '',
  hash TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT,
  revoked_at TEXT,
  facts TEXT                       -- JSON WorkerFacts from its last hello
);
INSERT INTO workers (name, description) VALUES ('default', '');

-- a session runs on one worker for its whole life
ALTER TABLE sessions ADD COLUMN worker_id INTEGER REFERENCES workers(id);
ALTER TABLE sessions ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN pending_prompt TEXT;       -- a reply that waits for an absent worker
ALTER TABLE sessions ADD COLUMN moved_from INTEGER REFERENCES sessions(id);
UPDATE sessions SET worker_id = (SELECT id FROM workers WHERE name = 'default');

-- repo kinds: github, local (a folder on one worker), later hosted
ALTER TABLE repos ADD COLUMN kind TEXT NOT NULL DEFAULT 'github';
ALTER TABLE repos ADD COLUMN worker_id INTEGER REFERENCES workers(id);
UPDATE repos SET kind = 'local', worker_id = (SELECT id FROM workers WHERE name = 'default') WHERE local_path IS NOT NULL;

-- placement: a project's default worker and its prose on where work runs
ALTER TABLE projects ADD COLUMN worker_id INTEGER REFERENCES workers(id);
ALTER TABLE projects ADD COLUMN placement_md TEXT NOT NULL DEFAULT '';
