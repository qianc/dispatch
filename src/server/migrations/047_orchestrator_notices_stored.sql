-- DISP-165: what the orchestrator still has to tell the owner at its turn end is stored, so a server
-- restart in the middle of a turn (a deploy of Dispatch itself) does not lose the push.

-- the "finished" push went out; cleared when the owner writes to it again
ALTER TABLE orchestrations ADD COLUMN finish_notified INTEGER NOT NULL DEFAULT 0;
-- the plan version the owner was last told about ("plan ready" or "plan change to approve")
ALTER TABLE orchestrations ADD COLUMN plan_notified_version INTEGER NOT NULL DEFAULT 0;
-- the ones that exist were told before this column: no push for them now
UPDATE orchestrations SET finish_notified = 1 WHERE phase = 'done';
UPDATE orchestrations SET plan_notified_version = plan_version;

-- what the orchestrator was offered to deal with before the owner is told:
-- fix_merge (a stopped merge) | deploy (a failed deploy) | no_pr (a turn that ended with no PR)
ALTER TABLE orchestration_steps ADD COLUMN offer TEXT;
-- the messages it had sent to the step's batch when the offer was made
ALTER TABLE orchestration_steps ADD COLUMN offer_messages INTEGER;
-- when the offer was made (ISO time)
ALTER TABLE orchestration_steps ADD COLUMN offered_at TEXT;
