-- DISP-45: a local repo can have a copy on several workers, each at its own path. The repo row is
-- the logical repo; repos.local_path / repos.worker_id stay as its home copy (used when no session
-- says which worker: rules, files, releases).
CREATE TABLE repo_placements (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  worker_id INTEGER NOT NULL REFERENCES workers(id),
  local_path TEXT NOT NULL,
  root_sha TEXT,                         -- the repo's first commit: catches a path that now holds another repo
  status TEXT NOT NULL DEFAULT 'ok',     -- ok | missing | mismatch, as the worker last saw it
  detail TEXT,                           -- why it is not ok
  checked_at TEXT,
  PRIMARY KEY (repo_id, worker_id)
);
INSERT INTO repo_placements (repo_id, worker_id, local_path)
  SELECT id, worker_id, local_path FROM repos WHERE kind = 'local' AND worker_id IS NOT NULL AND local_path IS NOT NULL;
