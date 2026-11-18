-- Dispatch's own updates (DISP-112): one row for each update of the server or of a worker.
-- `triggered_by`: 'auto', or the user who pressed "Update now". `state`: running, ok, failed or
-- rolled_back. `worker_id` of a server row: the worker that ran the server's update command.
-- No AUTOINCREMENT: a row that was only a question ("can you update now?" "no, busy") is deleted
-- again, and its number may be used again.
CREATE TABLE updates (
  id INTEGER PRIMARY KEY,
  target TEXT NOT NULL,
  worker_id INTEGER,
  worker_name TEXT,
  triggered_by TEXT NOT NULL,
  from_sha TEXT,
  to_sha TEXT NOT NULL,
  to_tag TEXT,
  state TEXT NOT NULL DEFAULT 'running',
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT
);
