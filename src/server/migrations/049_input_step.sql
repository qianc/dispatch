-- DISP-169: the step whose batch asked a question the orchestrator got. With it the orchestrator's
-- answers are counted per step, over all of the step's sessions (retries and moves too).
ALTER TABLE pending_inputs ADD COLUMN step_id INTEGER REFERENCES orchestration_steps(id) ON DELETE SET NULL;
