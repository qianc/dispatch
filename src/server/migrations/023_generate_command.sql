-- A repo's generate command (DISP-56): run in the merge checkout with the project's items, its
-- output files go into the merge commit. A branch that edits those files by hand is refused.
ALTER TABLE repos ADD COLUMN generate_command TEXT;
ALTER TABLE repos ADD COLUMN generated_paths TEXT;
