-- How a project looks in lists: a colour and an icon (names from src/shared/projectLook.ts); NULL = default.
ALTER TABLE projects ADD COLUMN color TEXT;
ALTER TABLE projects ADD COLUMN icon TEXT;
