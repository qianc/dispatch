-- Scheduled planner runs (DISP-13): a planner runs on a project at set times, within a scope in
-- prose, and starts the work it picks. Times are in the server's local time zone.
CREATE TABLE schedules (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- HH:MM
  at_time TEXT NOT NULL,
  -- JSON array of weekdays, 0 = Sunday … 6 = Saturday
  days TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
  scope_md TEXT NOT NULL DEFAULT '',
  max_batches INTEGER NOT NULL DEFAULT 1,
  -- JSON RunOptions for the batches it starts
  options TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  -- the last slot (ISO time) that ran or was skipped: a slot runs once
  last_slot TEXT,
  last_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  -- why the last run could not start, while that holds
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX schedules_project ON schedules(project_id);

-- the schedule a planner session ran for
ALTER TABLE sessions ADD COLUMN schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL;
