-- Runs of a repo's check command before a local merge (DISP-5): how long they took and how many
-- results they reported, so the next run of the same command can show the time left.
CREATE TABLE check_runs (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  ok INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  units INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX check_runs_repo ON check_runs(repo_id, command);
