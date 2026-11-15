-- A session that stopped on its Claude account's usage limit waits for the reset and goes on then
-- (DISP-108). `limit_wait`: JSON { resets_at } while it waits, else NULL.
-- `unclean`: why its last turn did not end cleanly (auto-merge then waits for the owner), else NULL.
ALTER TABLE sessions ADD COLUMN limit_wait TEXT;
ALTER TABLE sessions ADD COLUMN unclean TEXT;
