-- How well work started on several machines stays in sync: how far behind a branch was when it
-- was merged, and each time the owner's hands were needed.
ALTER TABLE pull_requests ADD COLUMN behind_at_merge INTEGER;
CREATE TABLE merge_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pr_id INTEGER REFERENCES pull_requests(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,              -- asked_update | resolve_conflicts | manual_merge
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX merge_events_session ON merge_events(session_id);
