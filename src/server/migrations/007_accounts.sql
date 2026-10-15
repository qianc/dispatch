-- Accounts: a project's GitHub account (its repos use it) and its Claude accounts (default + allowed);
-- a session keeps the Claude account it started on.
ALTER TABLE projects ADD COLUMN github_account TEXT;
ALTER TABLE projects ADD COLUMN claude_account TEXT;
ALTER TABLE projects ADD COLUMN claude_allowed TEXT; -- JSON array; NULL = any account
ALTER TABLE sessions ADD COLUMN claude_account TEXT; -- NULL = the legacy default (this machine's login)
