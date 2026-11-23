-- DISP-248: where a local or hosted review's branch left the default branch, kept while it is open.
-- A fast-forward merge leaves nothing in the history that marks where the branch started.
ALTER TABLE pull_requests ADD COLUMN fork_sha TEXT;
