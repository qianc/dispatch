-- A repo's deploy command (DISP-37): run on the worker after Dispatch merges into its default branch.
ALTER TABLE repos ADD COLUMN deploy_command TEXT;
