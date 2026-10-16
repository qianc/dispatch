-- Local repos: folders in the owner's real checkout that git does not track (e.g. reference
-- material) which an item's Discuss chat may read. JSON array of paths relative to the repo; NULL = none.
ALTER TABLE repos ADD COLUMN read_dirs TEXT;
