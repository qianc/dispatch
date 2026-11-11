-- A failed session stays failed for history, but the owner can close it (DISP-81): `ignored` (it
-- leaves Needs you) or `retried` (a new session took over, `retry_of` on the new one). A discussion
-- about why a session failed points at it with `about_session`.
ALTER TABLE sessions ADD COLUMN closed_at TEXT;
ALTER TABLE sessions ADD COLUMN closed_reason TEXT;
ALTER TABLE sessions ADD COLUMN retry_of INTEGER REFERENCES sessions(id);
ALTER TABLE sessions ADD COLUMN about_session INTEGER REFERENCES sessions(id);
-- failures from before this was shown are old news: only the last week's come up in Needs you
UPDATE sessions SET closed_at = ended_at, closed_reason = 'ignored'
  WHERE status = 'failed' AND (ended_at IS NULL OR ended_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days'));
