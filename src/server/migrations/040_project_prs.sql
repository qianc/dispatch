-- Open pull requests of a project's GitHub repos, also the ones no session opened (DISP-111): a
-- PR row may have no session (rebuild: SQLite cannot drop NOT NULL), and carries what the list
-- shows and the owner's approval.
CREATE TABLE pull_requests_new (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
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
  UNIQUE (repo_id, number)
);
INSERT INTO pull_requests_new (id, session_id, repo_id, number, url, title, state, mergeable, mergeable_state, head_ref, head_sha, last_synced, blocked, blocked_sha, behind_at_merge)
  SELECT id, session_id, repo_id, number, url, title, state, mergeable, mergeable_state, head_ref, head_sha, last_synced, blocked, blocked_sha, behind_at_merge FROM pull_requests;
DROP TABLE pull_requests;
ALTER TABLE pull_requests_new RENAME TO pull_requests;
CREATE INDEX pull_requests_session ON pull_requests(session_id);
