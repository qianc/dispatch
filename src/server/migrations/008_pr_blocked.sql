-- Why auto-merge stopped on a PR, for the head commit it was checked at (a new push clears it).
ALTER TABLE pull_requests ADD COLUMN blocked TEXT;
ALTER TABLE pull_requests ADD COLUMN blocked_sha TEXT;
