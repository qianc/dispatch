-- DISP-268: the quick check also runs the tests for the changed paths: a command that takes test files, and rules from paths to test files.
ALTER TABLE repos ADD COLUMN quick_test_command TEXT;
ALTER TABLE repos ADD COLUMN quick_test_map TEXT;
