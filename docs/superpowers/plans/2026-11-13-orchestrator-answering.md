# Orchestrator part 2: answering its batches — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A question or plan approval from a step's batch goes to the orchestrator first; it answers when the plan settles it, or hands it to the owner. It can send its batch one message to fix a stopped merge or a turn that ended early. The owner can overrule an answer.

**Architecture:** A question (`pending_inputs` row) of a step's batch gets `delegated_to` = the orchestration. While that is set the owner gets no push and the Inbox leaves it out; the orchestrator is woken with the question. Every path that could leave it unanswered hands it back to the owner. All of it lives in `Orchestrator`, behind three new hooks in `Sessions`.

**Tech Stack:** as part 1.

**Spec:** `docs/superpowers/specs/2026-11-13-orchestrator-design.md`, sections "Child questions", "Tools" (`answer_session`, `send_to_session`), "Rules the server enforces" (stop on red after one fix attempt), "App" (Overrule). Build order part 2.

## Global Constraints

- A delegated question must never be lost: it is answered by the orchestrator, or it reaches the owner. It reaches the owner when: the orchestrator hands it over; the orchestrator's turn that was told about it ends with it still open; 10 minutes pass (`delegateTimeoutMs`); the orchestration is paused, stopped or done; the orchestrator's session fails; the server restarts with it overdue.
- Only `question` and `plan_approval` are delegated, only from a `work` session that is a step's batch, only while the orchestration is in phase `run` with `answer_children` on (default on) and its session is not closed.
- The owner can always answer a delegated question himself in the batch's chat; that clears the delegation.
- The orchestrator answers only questions delegated to it, reads only its own batches, and writes only to its own batches.
- `send_to_session`: only to an idle batch of a step in `running` or `review`; at most 3 messages per step.
- An answer by the orchestrator is marked on the question (`answered_by = 'orchestrator'`) and said in the batch's chat. Overrule sends the owner's own words to the batch as its next message and tells the orchestrator.
- A stopped merge (blocked, conflicts) of a step: with `answer_children` on and no message sent to the step yet, the orchestrator gets one try before the owner is told. The owner is told when the try does not clear it, or when the orchestrator's turn ends without a try.
- A batch whose turn ended with no pull request wakes the orchestrator, once, after `settleMs` (30 s) if it is still so.
- Prose and commits as in part 1.

## Review Focus

1. The orchestrator's worker is away, or its session is busy for long: the batch's question reaches the owner after the timeout, once.
2. The owner answers a delegated question in the batch's chat while the orchestrator also answers: one answer wins, the other gets a clear refusal, the batch gets one answer.
3. The model calls `answer_session` for a question of another orchestration, an already answered one, or with an answer that does not fit the question: refused.
4. The server restarts with a delegated question open: it is handed over if overdue, else the timer runs again.
5. Overrule on a batch that is itself waiting for another answer, or closed: a clear refusal, nothing half-sent.

---

### Task 1: Delegate a batch's question to the orchestrator, and never lose it

**Files:** create `src/server/migrations/034_orchestrator_answers.sql`; modify `src/shared/types.ts`, `src/server/store.ts`, `src/server/sessions.ts`, `src/server/orchestrator.ts`, `src/server/app.ts`, `src/server/routes/sessions.ts`; test `test/orchestrator-answers.test.ts`.

**Interfaces — Produces:**

```ts
// migration: pending_inputs.delegated_to INTEGER REFERENCES sessions(id) ON DELETE SET NULL, pending_inputs.answered_by TEXT;
//            orchestrations.answer_children INTEGER NOT NULL DEFAULT 1; orchestration_steps.messages_sent INTEGER NOT NULL DEFAULT 0
// types: PendingInput.delegated_to: number | null; PendingInput.answered_by: 'orchestrator' | 'overruled' | null;
//        Orchestration.answer_children: boolean; orchestrationInput.answer_children: z.boolean().default(true); OrchestrationStep.messages_sent: number
// store: setInputDelegated(id: number, orchestrationId: number | null): PendingInput; setInputAnsweredBy(id: number, by: 'orchestrator' | 'overruled'): PendingInput;
//        delegatedInputs(orchestrationId?: number): PendingInput[]   // open ones
// sessions: delegateInput: ((s: Session, input: PendingInput) => boolean) | null   // true: the orchestrator has it, the owner is not told
//           tellOwnerInput(s: Session, input: PendingInput): void               // the push that input_request sends today
// orchestrator: delegate(s, input): boolean; handOver(inputId: number, why: string): void; delegateTimeoutMs = 600_000
```

Wake text for a question: `Step N "title" (KEY, session #M) asks you (input_id I):` then one line per question `Q: <question> Options: <label> (<description>) | …`, then `Answer it with answer_session if the plan, the items or what the owner told you settle it. If not, hand it to the owner with hand_to_owner.` For a plan: `… wants its plan approved (input_id I):` then the plan (first 3000 characters).

A delegated batch shows `waiting_reason` `Asked the orchestrator: <first question>`. `/api/inbox` leaves delegated inputs out. `sessions.answer` clears `delegated_to` on any answer. Handing over adds the system line `The orchestrator passed this to you: <why>` (or `No answer from the orchestrator in time: this is yours.` for the timeout) to the batch's chat and sends the normal push.

- [ ] Tests (write first, watch fail): `a batch's question goes to the orchestrator, not to the owner` (no push, not in inbox, orchestrator told with input_id and options); `not delegated when answer_children is off, the orchestration is paused, or the session is not a step's batch`; `the orchestrator's turn ends without an answer: the owner gets it`; `no answer in time: the owner gets it once` (Review Focus 1; `delegateTimeoutMs = 0` runs the check at once through `checkDelegated()`); `pause, stop and a failed orchestrator session hand open questions over`; `a restart hands over an overdue question and keeps a fresh one` (Review Focus 4); `the owner answers a delegated question himself: the delegation ends`.
- [ ] Implement. Commit `feat(orchestrator): a batch's question goes to its orchestrator first, and to you when it stays open`.

### Task 2: The orchestrator's tools: answer, hand over, write to a batch

**Files:** modify `src/server/orchestrator.ts`, `src/shared/protocol.ts`, `src/worker/mcp.ts`, `src/worker/prompts.ts`, `src/worker/fakeRunner.ts`; tests `test/orchestrator-answers.test.ts`, `test/orchestrator-flow.test.ts`.

RPC: `answer_session { input_id, answer?: string, answers?: Record<string,string>, approve?: boolean, feedback?: string }`, `hand_to_owner { input_id, reason?: string }`, `send_to_session { session_id, text }`.

- `answer_session`: the input is open and delegated to this orchestration, else `Question I is not yours to answer.` / `… is already answered.`. A question needs an answer for each of its questions (`answer` is enough when there is one); a plan needs `approve`. It goes through `sessions.answer`, then `answered_by = 'orchestrator'`, and the batch's chat gets `Answered by the orchestrator "<title>".`
- `send_to_session`: rules of Global Constraints, each with its refusal (`Session #M works now: wait for its turn to end.`, `You already sent 3 messages to this step's batch: tell the owner instead.`). The batch gets `(From the orchestrator of "<title>", not the owner:) <text>` through `sendFromDispatch`; `messages_sent` + 1.
- Stopped merge: in `sync`, a step that turns `review` with a block or conflict note, with `answer_children` on and `messages_sent === 0`: no push; the event ends with `You may tell its session once how to fix it (send_to_session). If you cannot, say so to the owner.` and the step is remembered in `fixOffered`. `onIdle`: each remembered step whose event was delivered, still in `review` with `messages_sent === 0`, gets the owner push `<title>: step N needs you`. With `messages_sent > 0` the push goes at once.
- Turn ended, no pull request: after `settleMs` with the same `seen`, wake once: `Step N … ended its turn with no pull request. Its last message: "…". If its work needs no merge, close the step (update_step done). If it stopped early, tell it what is missing (send_to_session). If it waits for the owner, do nothing.`
- Fake runner: a message with `asks you (input_id N)` → `answer_session { input_id: N, answer: 'Small fix' }`; with `wants its plan approved (input_id N)` → `approve: true`.
- Prompt: a section "Your batches' questions" with these rules.

- [ ] Tests: `answer_session answers the batch and marks who answered`; `it approves a batch's plan, or sends it back with feedback`; `answer_session refuses a question that is not its own, an answered one, and an answer that does not fit` (Review Focus 3); `the owner's answer wins a race: the orchestrator's is refused` (Review Focus 2); `hand_to_owner gives it to the owner with the reason`; `send_to_session writes to an idle batch of its own, at most 3 times`; `a stopped merge: one try for the orchestrator, then the owner`; `a stopped merge it does not act on reaches the owner at its turn end`; `a turn that ended with no pull request wakes it once`; the flow test runs with no manual answers.
- [ ] Implement. Commit `feat(orchestrator): it answers its batches, hands a question to you, and writes to a batch to fix it`.

### Task 3: Overrule, and the app

**Files:** modify `src/server/orchestrator.ts`, `src/server/routes/sessions.ts`, `src/server/access.ts`, `src/server/sessionGuard.ts`, `src/server/projectLock.ts`, `web/src/components/transcript.tsx`, `web/src/components/orchestration.tsx`, `README.md`, the spec (a note of what part 2 changed); tests `test/orchestrator-answers.test.ts`, `test/orchestrator-ui.test.ts` (new cases in `test/orchestrator-overrule-ui.test.ts`).

- `POST /api/inputs/:id/overrule { text }` (scope `sessions`, the batch's driver only): the input was answered by the orchestrator, else 409. The batch gets, as the owner's message, `I overrule the orchestrator's answer to "<question, or: your plan>": <text>`; `answered_by = 'overruled'`; the orchestrator is woken with `The owner overruled your answer to step N (input_id I): "<text>". Follow it.` A batch that waits for another answer or is closed: the error of `sessions.send`, nothing changed (Review Focus 5).
- `InputCard`: a delegated open question says `The orchestrator answers this, or passes it to you. You can answer it yourself.`; one answered by the orchestrator says `Answered by the orchestrator` with **Overrule** (a text box and Send); an overruled one says `Answered by the orchestrator, overruled by you`.
- Start sheet: a checkbox `It answers its batches' questions` (on), with the hint `From the plan and what you told it. What it cannot settle comes to you.`
- README: the Orchestrator section says what it answers and how to overrule; "Not there yet" loses that line.

- [ ] Tests, implement, `npm test`, typecheck, build, e2e. Commit `feat(orchestrator): overrule an answer; the app shows who answered a batch's question`.
