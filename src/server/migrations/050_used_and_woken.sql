-- DISP-179: when an approved cross-project request ran; it runs once, also after a restart.
ALTER TABLE pending_inputs ADD COLUMN used_at TEXT;
-- DISP-180: the step's `seen` its no-pull-request wake went out for; a restart does not send it again.
ALTER TABLE orchestration_steps ADD COLUMN no_pr_woken TEXT;
