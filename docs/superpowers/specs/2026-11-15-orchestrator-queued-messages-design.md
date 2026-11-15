# Orchestrator: messages to a batch that works (DISP-105)

## Why

`send_to_session` refused a batch that was not idle. The orchestrator had to wait and send again,
and a message was lost that way. Now a message to a batch that works is queued, and Dispatch
delivers it when the batch's turn ends.

## Approaches

1. **The owner's path** (`Sessions.send` to a running session). The message then waits in the
   worker's memory (the SDK input queue). Dispatch cannot take it back when the batch fails or
   asks a question, it replaces the result of the turn's check command, and a worker restart
   loses it. Not chosen.
2. **A queue in the database, on the server** (chosen). It survives a restart, and the server
   decides at the turn end to deliver or to drop.

## Design

- Table `orchestration_messages` (migration 038): `step_id`, `session_id`, `text`, `state`
  (`queued`, `delivered`, `dropped`).
- `send_to_session`:
  - a batch that waits for an answer or a plan approval, or is closed: refused as before;
  - an idle batch: sent at once as before;
  - a batch that works: stored, and the answer starts with "Queued for session #N".
  The message counts against the 3 messages of the step when it is queued. A dropped message
  stays counted.
- Delivery (`Orchestrator.deliverQueued`, called for each session event of a batch, before the
  step is brought in line): when the batch is idle, all its queued messages go to it in order, as
  one message and one turn. That turn end is not told to the orchestrator or to the owner, and no
  merge check runs for it: the batch goes on. The worker's check command ran before the batch
  reported idle.
- Not delivered: when the batch is closed, failed, waits for an answer, or its step is no longer
  running or in review, the messages are dropped and the orchestrator's next wake-up says so, with
  their text. A closed orchestration drops them with no wake-up.
- Restart: `resume()` and the one-minute `tick()` look at every queued message, so a turn end the
  server did not see is handled.

## Not in this change

No view of queued messages in the web app. None of the open points of DISP-90.
