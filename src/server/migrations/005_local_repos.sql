-- Repos that live in a folder on the worker host instead of on GitHub.
ALTER TABLE repos ADD COLUMN local_path TEXT;
