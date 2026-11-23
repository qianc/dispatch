-- DISP-251: the worker a step's batch runs on, by name; NULL: the project's or the owner's default.
ALTER TABLE orchestration_steps ADD COLUMN worker TEXT;
