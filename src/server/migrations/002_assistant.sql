-- Assistant chats belong to no project: make sessions.project_id nullable.
CREATE TABLE sessions_new (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  force_plan INTEGER NOT NULL DEFAULT 0,
  branch TEXT,
  sdk_session_id TEXT,
  initial_prompt TEXT NOT NULL DEFAULT '',
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  waiting_reason TEXT,
  last_text TEXT,
  usage TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT
);
INSERT INTO sessions_new SELECT * FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX sessions_status ON sessions(status);
CREATE INDEX sessions_kind ON sessions(kind);
