-- A disabled project is read-only (DISP-59): nothing writes to it and nothing runs against it.
-- Who disabled it and when are shown on the project page.
ALTER TABLE projects ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN disabled_at TEXT;
ALTER TABLE projects ADD COLUMN disabled_by TEXT;
-- a schedule switched off by the disable; enabling the project switches it back on
ALTER TABLE schedules ADD COLUMN paused_by_disable INTEGER NOT NULL DEFAULT 0;
