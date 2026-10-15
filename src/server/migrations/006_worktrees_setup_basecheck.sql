-- Local repos can make worktrees in the repo itself (default) or in a separate clone;
-- an optional command prepares each new worktree (venv, npm ci, ...).
ALTER TABLE repos ADD COLUMN worktree_from TEXT;
ALTER TABLE repos ADD COLUMN setup_command TEXT;
-- "update with main before auto-merge" is new: sessions that already exist keep the old behaviour.
UPDATE sessions SET options = json_set(coalesce(options, '{}'), '$.base_check', json('false'));
