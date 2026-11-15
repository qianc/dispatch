-- May agents (work sessions, scheduled runs, orchestrators) change the title and description of
-- this project's items themselves (DISP-93)? Off: they comment, as before.
ALTER TABLE projects ADD COLUMN agents_edit_items INTEGER NOT NULL DEFAULT 0;
