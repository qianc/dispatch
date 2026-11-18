-- DISP-119: the orchestrator changes its approved plan by itself when the change is minor, and asks
-- the owner only for the changes that matter. Those wait as a proposal while the rest runs on.

-- a step the plan marks as optional: the orchestrator may skip it without asking
ALTER TABLE orchestration_steps ADD COLUMN optional INTEGER NOT NULL DEFAULT 0;

-- JSON: a change of the running plan that waits for the owner's approval (the plan it proposes,
-- the steps it holds); NULL: none waits
ALTER TABLE orchestrations ADD COLUMN proposal TEXT;

-- the plan's history: each change, who decided it, why, and how it was verified
CREATE TABLE orchestration_changes (
  id INTEGER PRIMARY KEY,
  orchestration_id INTEGER NOT NULL REFERENCES orchestrations(session_id) ON DELETE CASCADE,
  -- fix_blocker | reorder | reword | split | retry | skip | approved
  kind TEXT NOT NULL,
  -- orchestrator (applied by itself) | owner (approved by the owner)
  decided_by TEXT NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  verification TEXT,
  -- the step it added or acted on, whose state shows whether the verification passed
  step_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX orchestration_changes_orch ON orchestration_changes(orchestration_id);
