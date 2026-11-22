-- DISP-174: a source's folder is a folder on the worker whose session imported it, and is read on
-- that worker only. Folders kept before this do not say which worker they are on, and migration 046
-- took some from free-text titles that tracker tokens could set: they are cleared, not guessed.
ALTER TABLE sources ADD COLUMN base_dir_worker_id INTEGER REFERENCES workers(id);
UPDATE sources SET base_dir = NULL;
