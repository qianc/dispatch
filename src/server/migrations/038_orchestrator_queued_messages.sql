-- A message the orchestrator wrote to a step's batch while that batch worked (DISP-105). It waits
-- here, so a server restart does not lose it, and goes to the batch when its turn ends.
-- `state`: queued | delivered | dropped (the batch closed or began to wait for an answer first).
CREATE TABLE orchestration_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id INTEGER NOT NULL REFERENCES orchestration_steps(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX orchestration_messages_queued ON orchestration_messages(session_id) WHERE state = 'queued';
