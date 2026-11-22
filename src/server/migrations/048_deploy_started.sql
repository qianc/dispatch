-- DISP-166: when each deploy of a step started (ISO time, by repo id), so a deploy whose result never
-- comes (the worker restarted, or the deploy killed it) fails after a time instead of holding the step.
-- An entry is dropped when the deploy's result comes; a failed deploy that still has one got no result.
ALTER TABLE orchestration_steps ADD COLUMN deploys_started TEXT NOT NULL DEFAULT '{}';
