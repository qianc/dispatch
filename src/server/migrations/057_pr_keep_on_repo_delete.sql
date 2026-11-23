-- DISP-248 (81): removing a repo keeps its merged PRs with no repo, so a release of another repo
-- still sees that their items were merged elsewhere. Rebuild: SQLite cannot change a foreign key.
CREATE TABLE pull_requests_new (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  repo_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  mergeable INTEGER,
  mergeable_state TEXT,
  head_ref TEXT NOT NULL,
  head_sha TEXT,
  last_synced TEXT,
  blocked TEXT,
  blocked_sha TEXT,
  behind_at_merge INTEGER,
  author TEXT,                     -- GitHub login
  base_ref TEXT,
  draft INTEGER NOT NULL DEFAULT 0,
  changed_files INTEGER,
  ci_state TEXT,                   -- pending | success | failure | none; NULL: not known
  gh_updated_at TEXT,              -- GitHub's updated_at, to see that a PR changed
  approved_at TEXT,
  approved_by TEXT,
  approved_sha TEXT,               -- the head commit that was approved
  review_state TEXT,               -- how the review went on GitHub: sent | own_pr | failed
  review_note TEXT,
  fork_sha TEXT,
  UNIQUE (repo_id, number)
);
INSERT INTO pull_requests_new SELECT id, session_id, repo_id, number, url, title, state, mergeable, mergeable_state, head_ref, head_sha, last_synced, blocked, blocked_sha, behind_at_merge,
  author, base_ref, draft, changed_files, ci_state, gh_updated_at, approved_at, approved_by, approved_sha, review_state, review_note, fork_sha FROM pull_requests;
DROP TABLE pull_requests;
ALTER TABLE pull_requests_new RENAME TO pull_requests;
CREATE INDEX pull_requests_session ON pull_requests(session_id);
