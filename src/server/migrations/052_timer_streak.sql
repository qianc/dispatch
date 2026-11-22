-- DISP-199: timers an orchestrator set one after the other while nothing else happened. Kept in
-- the row, not in memory, so a restart does not give it a fresh count.
ALTER TABLE orchestrations ADD COLUMN timer_streak INTEGER NOT NULL DEFAULT 0;
