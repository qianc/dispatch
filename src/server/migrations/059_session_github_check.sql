-- DISP-258: a planner session that checks what GitHub reports for the project's repos.
ALTER TABLE sessions ADD COLUMN github_check INTEGER NOT NULL DEFAULT 0;
