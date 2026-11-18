-- The model Claude reports a session runs on (DISP-117), e.g. claude-opus-5-5. NULL until it started.
ALTER TABLE sessions ADD COLUMN run_model TEXT;
