-- A question or plan approval of a step's batch goes to its orchestrator first. While
-- `delegated_to` is set the owner is not told; it is cleared when the question is answered or
-- handed to the owner. `answered_by`: orchestrator | overruled (null: the owner answered).
ALTER TABLE pending_inputs ADD COLUMN delegated_to INTEGER REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE pending_inputs ADD COLUMN answered_by TEXT;
-- the owner can switch this off: every question of its batches then comes straight to them
ALTER TABLE orchestrations ADD COLUMN answer_children INTEGER NOT NULL DEFAULT 1;
-- messages the orchestrator sent to this step's batch (a small, fixed number is allowed)
ALTER TABLE orchestration_steps ADD COLUMN messages_sent INTEGER NOT NULL DEFAULT 0;
