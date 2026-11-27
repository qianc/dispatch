-- DISP-260: a repo's quick check (lint plus a smoke set), run after each turn where the full check would wait for CI.
ALTER TABLE repos ADD COLUMN quick_check_command TEXT;
