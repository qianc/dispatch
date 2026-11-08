-- The GitHub login a session acts as (DISP-63): the starter's own account, or null (the env
-- accounts). Set when the session is sent to its worker.
ALTER TABLE sessions ADD COLUMN github_login TEXT;
