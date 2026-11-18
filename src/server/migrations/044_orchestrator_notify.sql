-- DISP-122: the orchestrator handles its batches' routine notices, and the owner is told only what
-- needs them. What it handled quietly is kept in a log on its page.

-- needs_you: only what needs the owner, batched (the default) | all: every batch notifies the owner itself
ALTER TABLE orchestrations ADD COLUMN notify_owner TEXT NOT NULL DEFAULT 'needs_you';

-- what the orchestrator handled without a push: batches it completed, notices it did not send
CREATE TABLE orchestration_log (
  id INTEGER PRIMARY KEY,
  orchestration_id INTEGER NOT NULL REFERENCES orchestrations(session_id) ON DELETE CASCADE,
  session_id INTEGER,
  step_id INTEGER,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX orchestration_log_orch ON orchestration_log(orchestration_id);
