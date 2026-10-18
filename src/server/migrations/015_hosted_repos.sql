-- Hosted repos (kind = 'hosted'): the server keeps the repo itself (DATA_DIR/git/r<id>.git). An
-- optional upstream GitHub repo gets the merged default branch, or PRs.
ALTER TABLE repos ADD COLUMN upstream_owner TEXT;
ALTER TABLE repos ADD COLUMN upstream_name TEXT;
