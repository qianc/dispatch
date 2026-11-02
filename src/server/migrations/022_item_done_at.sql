-- When an item became done (DISP-50): a release holds only the items done after the last one.
-- Items already done have no such date: their last change is the nearest one we know.
ALTER TABLE items ADD COLUMN done_at TEXT;
UPDATE items SET done_at = updated_at WHERE status = 'done';
