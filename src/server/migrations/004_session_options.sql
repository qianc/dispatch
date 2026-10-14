-- Per-session run options: model, effort, subagent use, start mode, auto-merge (JSON).
ALTER TABLE sessions ADD COLUMN options TEXT;
