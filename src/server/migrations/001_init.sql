CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  default_force_plan INTEGER NOT NULL DEFAULT 0,
  importance_scale TEXT NOT NULL,
  effort_scale TEXT NOT NULL,
  next_item_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  github_owner TEXT NOT NULL,
  github_name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  check_command TEXT,
  UNIQUE (project_id, github_owner, github_name)
);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  reporter TEXT,
  version_tag TEXT,
  skill_name TEXT,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 2,
  effort INTEGER,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  labels TEXT NOT NULL DEFAULT '[]',
  marked INTEGER NOT NULL DEFAULT 0,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, number)
);
CREATE INDEX items_source ON items(source_id);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body_md TEXT NOT NULL,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX comments_item ON comments(item_id);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
CREATE INDEX sessions_status ON sessions(status);

CREATE TABLE session_items (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, item_id)
);

CREATE TABLE session_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (session_id, seq)
);

CREATE TABLE pending_inputs (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  local_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  answer TEXT,
  answered_at TEXT,
  expired INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX pending_inputs_open ON pending_inputs(answered_at, expired);

CREATE TABLE pull_requests (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  mergeable INTEGER,
  mergeable_state TEXT,
  head_ref TEXT NOT NULL,
  head_sha TEXT,
  last_synced TEXT,
  UNIQUE (repo_id, number)
);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE project_mutes (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE
);
