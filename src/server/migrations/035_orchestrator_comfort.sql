-- A timer the orchestrator set for itself is a queued event with a due time: as durable as any
-- other wake-up, and delivered only from that time on.
ALTER TABLE orchestration_events ADD COLUMN due_at TEXT;
-- an optional limit on what an orchestration and its batches may cost; at the limit it is paused
ALTER TABLE orchestrations ADD COLUMN cost_limit_usd REAL;
-- why Dispatch paused it (the cost limit), shown until it is resumed
ALTER TABLE orchestrations ADD COLUMN paused_reason TEXT;
