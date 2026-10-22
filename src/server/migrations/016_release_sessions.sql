-- Release sessions (kind = 'release'): what is released, as JSON (ReleaseInfo). Not named
-- `release`, which is an SQL keyword.
ALTER TABLE sessions ADD COLUMN release_info TEXT;
