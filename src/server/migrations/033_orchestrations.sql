-- An orchestrator session holds a plan of steps over one or more projects and starts each step as
-- a batch. The plan lives here, not only in the chat, so it survives a resumed session and the
-- app can show it.
CREATE TABLE orchestrations (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  -- JSON array of project ids: the only projects it may read and start work in
  project_ids TEXT NOT NULL DEFAULT '[]',
  -- plan | run | paused | done | stopped
  phase TEXT NOT NULL DEFAULT 'plan',
  -- the phase it was paused in
  paused_from TEXT,
  plan_md TEXT NOT NULL DEFAULT '',
  -- the stored plan has the owner's yes; a changed plan needs it again
  plan_approved INTEGER NOT NULL DEFAULT 0,
  max_children INTEGER NOT NULL DEFAULT 2,
  -- JSON RunOptions for the batches it starts
  options TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE orchestration_steps (
  -- AUTOINCREMENT: a removed step's id is never given to a new one (the orchestrator names steps by id)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orchestration_id INTEGER NOT NULL REFERENCES orchestrations(session_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt_md TEXT NOT NULL DEFAULT '',
  item_ids TEXT NOT NULL DEFAULT '[]',
  -- JSON array of step ids that must be done or skipped first
  depends_on TEXT NOT NULL DEFAULT '[]',
  -- pending | running | review | done | failed | skipped
  state TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  child_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  -- the child's last seen "status|state|note": a change is told once
  seen TEXT,
  -- JSON: repo id -> running | ok | failed
  deploys TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX orchestration_steps_orch ON orchestration_steps(orchestration_id);
CREATE INDEX orchestration_steps_child ON orchestration_steps(child_session_id);

-- wake-ups for the orchestrator, kept until its session can take them
CREATE TABLE orchestration_events (
  id INTEGER PRIMARY KEY,
  orchestration_id INTEGER NOT NULL REFERENCES orchestrations(session_id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  delivered_at TEXT
);
CREATE INDEX orchestration_events_open ON orchestration_events(orchestration_id) WHERE delivered_at IS NULL;

-- the orchestrator a work session is a step of
ALTER TABLE sessions ADD COLUMN orchestrator_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL;
