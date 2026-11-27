-- DISP-267: every notice sent or held back, with where it came from and what happened to it. Kept 30 days.
CREATE TABLE notice_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  users TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL,
  tag TEXT,
  project_id INTEGER,
  session_id INTEGER,
  orchestration_id INTEGER,
  source TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  devices TEXT NOT NULL DEFAULT '[]',
  replaced_by INTEGER
);
CREATE INDEX notice_log_created ON notice_log (created_at);
CREATE INDEX notice_log_session ON notice_log (session_id);
CREATE INDEX notice_log_orchestration ON notice_log (orchestration_id);
