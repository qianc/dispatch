-- DISP-243: a step split in parts hands its own retries and answered questions to each part, so a
-- fail, retry, split loop still meets the caps (MAX_OWN_RETRIES, MAX_ANSWERS).
ALTER TABLE orchestration_steps ADD COLUMN carried_retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orchestration_steps ADD COLUMN carried_answers INTEGER NOT NULL DEFAULT 0;
