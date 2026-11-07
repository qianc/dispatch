-- A session that stopped because its Claude account is not signed in (DISP-60): what the owner
-- needs to sign it in again (JSON LoginHelp). Cleared when the session runs again.
ALTER TABLE sessions ADD COLUMN login_needed TEXT;
