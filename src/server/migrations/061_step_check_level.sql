-- DISP-262: how much a step's batch tests after each turn (full, quick, none); NULL: the repo's default level.
ALTER TABLE orchestration_steps ADD COLUMN check_level TEXT;
