# Orchestrator Core (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new session kind `orchestrator` that holds an approved plan of steps over one or more projects, starts each step as a normal batch, and is woken by the server when a step's batch ends its turn, merges, deploys or fails.

**Architecture:** The orchestrator is a session with no project (as the Assistant), plus rows in `orchestrations`, `orchestration_steps` and `orchestration_events`. A server class `Orchestrator` owns all rules: it answers the session's MCP calls, follows child sessions through the bus, keeps step states, queues wake-up events and delivers them when the orchestrator session is idle. The worker adds a prompt, a tool list and a fake-runner script. The web adds a start sheet, a plan panel on the session page, and rows in Inbox and Activity.

**Tech Stack:** Node 24 (TypeScript run directly), Fastify, node:sqlite, Claude Agent SDK, React + React Query + Tailwind, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-13-orchestrator-design.md` (build order part 1 only).

## Global Constraints

- Only part 1 of the spec. Child questions still go to the owner. No `answer_session`, `send_to_session`, timer wake-ups, cost limit, settings icon, Assistant card, or folding of children in Activity.
- The orchestrator edits no files and runs no commands: it gets the planner's denied tools (`Write`, `Edit`, `NotebookEdit`, `Bash`, `KillShell`).
- It never merges. A step's batch uses the orchestration's run options; auto-merge decides.
- It reaches only the projects in its scope. A locked project refuses (`assertWritable`).
- It cannot take an item off hold or close one (the scheduled planner's `SCHEDULED_SET` rule).
- At most `max_children` running child sessions, default 2, allowed 1 to 5.
- A step starts once, only from an approved plan, only when every step it depends on is `done` or `skipped`.
- No orchestrator starts an orchestrator.
- Children run as the user who started the orchestrator.
- One step is one batch.
- Step states: `pending`, `running`, `review`, `done`, `failed`, `skipped`. Phases: `plan`, `run`, `paused`, `done`, `stopped`.
- Prose and commit messages follow the repo's style: plain short sentences, `feat(orchestrator): …`. No private data (the commit hook checks).
- Phase-1 limit, to be said in the README: all GitHub access of the orchestrator's own read-only checkouts uses the GitHub account of the first project in scope.

## Review Focus

1. The server restarts while wake-up events are queued: each event is delivered once after the restart, none twice. (Task 4)
2. The model calls `start_step` twice for one step, or for a step already `running`: the second call is refused and no second batch exists. (Task 3)
3. A project in scope is locked while the plan runs: `start_step` is refused with the lock message, the step stays `pending`, other projects' steps go on. (Task 3)
4. `set_plan` during Run that leaves out a step with a child session: refused; a changed plan stops new starts until the owner approves again. (Task 2)
5. A child session is moved to another worker (a new session with `moved_from`): the step follows the new session and is not marked failed. (Task 4)

---

## File Structure

- Create `src/server/migrations/033_orchestrations.sql`: the three tables, `sessions.orchestrator_id`.
- Modify `src/shared/types.ts`: kind `orchestrator`, `Orchestration`, `OrchestrationStep`, input schemas, `LiveEvent` `orchestration`.
- Modify `src/shared/protocol.ts`: `StartSpec.orchestration`, RPC method names.
- Modify `src/server/store.ts`: orchestration rows and queries.
- Create `src/server/orchestrator.ts`: class `Orchestrator` (rules, RPC, child tracking, wake-ups, owner actions).
- Modify `src/server/sessions.ts`: `startOrchestrator`, `sendFromDispatch`, hooks (`orchestratorRpc`, `orchestrationOf`), turn-end push rule, `onDeployed`.
- Modify `src/server/github.ts`: `onDeployStarted`, `onDeployFailed` hooks.
- Modify `src/server/app.ts`, `src/server/routes/ctx.ts`: wiring.
- Create `src/server/routes/orchestrations.ts`: the API.
- Modify `src/server/routes/sessions.ts`: inbox entries, orchestration on the session detail.
- Modify `src/shared/attention.ts`: attention kinds `plan` and `step_failed`.
- Modify `src/worker/prompts.ts`, `src/worker/mcp.ts`, `src/worker/runner.ts`, `src/worker/fakeRunner.ts`.
- Create `web/src/components/orchestration.tsx`: start sheet, plan panel, step menu.
- Modify `web/src/api.ts`, `web/src/live.ts`, `web/src/pages/Activity.tsx`, `web/src/pages/Session.tsx`, `web/src/pages/Inbox.tsx`, `web/src/components/items.tsx`.
- Tests: `test/orchestrator.test.ts`, `test/orchestrator-flow.test.ts` (fake worker), `test/orchestrator-ui.test.ts`, `e2e/orchestrator.spec.ts`.
- Modify `README.md`: a short "Orchestrator" section.

---

### Task 1: Types, migration, store

**Files:**
- Create: `src/server/migrations/033_orchestrations.sql`
- Modify: `src/shared/types.ts`, `src/server/store.ts`
- Test: `test/orchestrator.test.ts`

**Interfaces — Produces:**

```ts
// shared/types.ts
export const SESSION_KINDS = ['work', 'planner', 'assistant', 'discuss', 'release', 'orchestrator'] as const;
export const ORCH_PHASES = ['plan', 'run', 'paused', 'done', 'stopped'] as const;
export const STEP_STATES = ['pending', 'running', 'review', 'done', 'failed', 'skipped'] as const;
export interface OrchestrationStep {
  id: number; orchestration_id: number; position: number; title: string;
  project_id: number; project_key: string; prompt_md: string;
  item_ids: number[]; item_keys: string[]; depends_on: number[]; // step ids
  state: StepState; note: string | null; child_session_id: number | null;
  /** last seen "status|state|blocked" of the child, to tell a change from a repeat */
  seen: string | null;
  /** repo id → 'running' | 'ok' | 'failed' */
  deploys: Record<string, 'running' | 'ok' | 'failed'>;
}
export interface Orchestration {
  session_id: number; title: string; goal: string;
  project_ids: number[]; project_keys: string[];
  phase: OrchPhase; paused_from: 'plan' | 'run' | null;
  plan_md: string; plan_approved: boolean;
  max_children: number; options: RunOptions;
  steps: OrchestrationStep[];
  /** one line for lists: what it waits for now */
  waiting: string | null;
  created_at: string; updated_at: string;
}
export const orchestrationInput = z.object({
  goal: z.string().trim().min(1), title: z.string().trim().max(80).optional(),
  project_keys: z.array(z.string()).min(1), max_children: z.number().int().min(1).max(5).default(2),
  options: runOptions.default(DEFAULT_RUN_OPTIONS),
});
export const planInput = z.object({
  plan_md: z.string(),
  steps: z.array(z.object({
    id: z.number().int().optional(), title: z.string().trim().min(1), project_key: z.string(),
    prompt: z.string().default(''), item_keys: z.array(z.string()).default([]),
    after: z.array(z.number().int().min(1)).default([]), // 1-based places in this list
  })).min(1),
});
// LiveEvent gains: | { t: 'orchestration'; orchestration: Orchestration }
// Session gains: orchestrator_id: number | null

// store.ts
createOrchestration(o: { session_id: number; goal: string; project_ids: number[]; max_children: number; options: RunOptions }): void
orchestration(sessionId: number): Orchestration | undefined   // steps included, `waiting` null (the Orchestrator fills it)
orchestrations(): Orchestration[]                             // newest first
updateOrchestration(sessionId: number, patch: Partial<Pick<Orchestration, 'phase' | 'paused_from' | 'plan_md' | 'plan_approved' | 'max_children' | 'project_ids'>>): void
replaceSteps(sessionId: number, steps: { id?: number; title: string; project_id: number; prompt_md: string; item_ids: number[]; after: number[] }[]): void  // keeps rows with id, inserts the rest, deletes pending rows left out, sets position and depends_on
step(id: number): OrchestrationStep | undefined
stepOfChild(sessionId: number): OrchestrationStep | undefined
updateStep(id: number, patch: Partial<Pick<OrchestrationStep, 'state' | 'note' | 'child_session_id' | 'seen' | 'deploys'>>): OrchestrationStep
addOrchEvent(sessionId: number, text: string): void
pendingOrchEvents(sessionId: number): { id: number; text: string }[]
markOrchEventsDelivered(ids: number[]): void
setOrchestrator(childSessionId: number, orchestratorId: number): void   // sessions.orchestrator_id
movedTo(sessionId: number): Session | undefined                          // the session with moved_from = sessionId
```

- [ ] **Step 1: Write the failing test** in `test/orchestrator.test.ts`, describe `orchestration store`:
  - `keeps an orchestration with its steps`: create a project `A`, a session of kind `orchestrator` through `store.createSession` (project_id null), `createOrchestration`, `replaceSteps` with two steps where the second has `after: [1]`; expect `orchestration(id)` to have `phase 'plan'`, `plan_approved false`, `max_children 2`, two steps with positions 1 and 2, the second's `depends_on` equal to `[first.id]`, `project_key 'A'`.
  - `replaceSteps keeps a step with a child and drops a pending one left out`: set step 1 `child_session_id`; replace with only step 1 (by id) plus a new one; expect old step 2 gone, step 1 id unchanged.
  - `queues events and marks them delivered once`: two `addOrchEvent`, `pendingOrchEvents` has 2 in order; after `markOrchEventsDelivered` it has 0.
- [ ] **Step 2: Run** `npx vitest run test/orchestrator.test.ts` — FAIL (no such functions).
- [ ] **Step 3: Write the migration** (tables `orchestrations(session_id PK → sessions ON DELETE CASCADE, goal, project_ids JSON, phase DEFAULT 'plan', paused_from, plan_md DEFAULT '', plan_approved DEFAULT 0, max_children DEFAULT 2, options JSON, created_at, updated_at)`, `orchestration_steps(id PK, orchestration_id → orchestrations ON DELETE CASCADE, position, title, project_id → projects, prompt_md, item_ids JSON, depends_on JSON, state DEFAULT 'pending', note, child_session_id → sessions ON DELETE SET NULL, seen, deploys JSON DEFAULT '{}')`, `orchestration_events(id PK, orchestration_id → orchestrations ON DELETE CASCADE, text, created_at, delivered_at)`, `ALTER TABLE sessions ADD COLUMN orchestrator_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL`), the types, and the store functions. Add `orchestrator_id` to `SESSION_SELECT` / `toSession`.
- [ ] **Step 4: Run** the test and `npm run typecheck` — PASS. Fix every `switch`/list over `SessionKind` the type checker flags (web `KINDS` list in Activity gets `{ value: 'orchestrator', label: 'Orchestration' }`).
- [ ] **Step 5: Commit** `feat(orchestrator): tables and types for orchestrations and their steps`.

---

### Task 2: Start, scope tools, set_plan, approve

**Files:**
- Create: `src/server/orchestrator.ts`
- Modify: `src/server/sessions.ts`, `src/server/app.ts`, `src/server/routes/ctx.ts`, `src/shared/protocol.ts`
- Test: `test/orchestrator.test.ts`

**Interfaces — Consumes:** Task 1 store functions.

**Produces:**

```ts
// sessions.ts
startOrchestrator(input: { title: string; prompt: string; first: Project }, startedBy: string | null): Session  // kind 'orchestrator', project_id null, worker of `first`, claude account of `first`
sendFromDispatch(sessionId: number, text: string): void   // as send(), but the transcript gets a `system` event, not a `user` one; a waiting_input or running session throws SessionError
orchestratorRpc: ((s: Session, method: string, p: Record<string, unknown>) => Promise<unknown>) | null
orchestrationOf: ((s: Session) => { repos: Repo[]; first: Project | undefined; spec: StartSpec['orchestration'] } | null) | null  // used by reposOf, identityOf and spec()
trackerRpc(s: Session, method: 'get_item' | 'get_image' | 'add_comment', p: Record<string, unknown>, project: Project): Promise<unknown>  // public door to itemRpc
listItemsRpc(project: Project, p: Record<string, unknown>): unknown        // the list_items body, shared
agentItemUpdate(s: Session, project: Project, it: Item, raw: Record<string, unknown>): unknown  // scheduledItemUpdate without its kind check
agentCreateItem(s: Session, project: Project, raw: unknown): { key: string; id: number }

// protocol.ts
StartSpec.orchestration?: { goal: string; phase: OrchPhase; projects: { key: string; name: string; importance_scale: string[]; effort_scale: string[]; repos: string[] }[]; max_children: number; status_md: string }

// orchestrator.ts
export class Orchestrator {
  constructor(deps: { store: Store; bus: Bus; sessions: Sessions; notifier: Notifier });
  start(input: z.infer<typeof orchestrationInput>, startedBy: string | null): Orchestration;
  view(sessionId: number): Orchestration;             // 404 SessionError when unknown; fills `waiting`
  list(): Orchestration[];
  rpc(s: Session, method: string, p: Record<string, unknown>): Promise<unknown>;
  approve(sessionId: number): Orchestration;
  statusText(o: Orchestration): string;               // the "Plan now" block, see Task 4
  stop(): void;                                        // unsubscribe from the bus
}
```

RPC methods in this task (all check the project is in scope; error text `Project X is not in this orchestration's scope (A, B).`): `list_projects`, `list_items {project_key, status?, type?}`, `get_item {key}`, `get_image {id}`, `add_comment {key, body}`, `create_item {project_key, …item}`, `update_item {key, …}`, `set_plan` (`planInput`).

`set_plan` rules: every `project_key` in scope; every `item_keys` entry exists in that step's project; `after` points at an earlier or later place but not itself and makes no cycle; a step given by `id` must be this orchestration's; a step with a child session cannot change project and cannot be left out (`Step "T" already ran as session #N: keep it in the plan.`). It stores plan and steps, sets `plan_approved false`, and in phase `run` sets phase `plan`. It answers: `The plan is shown to the owner with an Approve button. Explain it briefly, then stop and wait.` It adds a `system` event `Plan proposed: N steps` to the transcript and remembers the session in `planNotice` (push at turn end, Task 4).

`approve`: phase must be `plan` with at least one step and `plan_approved false`, else 409. Sets `plan_approved true`, phase `run`, adds system event `Plan approved.`, emits the live event, and calls `this.wake(id, 'The owner approved the plan.')` (Task 4; in this task a stub that only stores the event).

- [ ] **Step 1: Write failing tests**, describe `orchestrator: plan`, with projects `A` and `B` (each with a repo) and a third `C` out of scope:
  - `start makes an orchestrator session with no project`: `s.ctx.orchestrator.start({ goal: 'Rework auth', project_keys: ['A','B'] }, OWNER)`; expect session `kind 'orchestrator'`, `project_id null`, title `Rework auth`, `initial_prompt` containing the goal; `spec()` has `orchestration.projects` keys `['A','B']` and `repos` of both projects.
  - `start refuses an unknown or locked project` (400 / lock message).
  - `tracker tools stay inside the scope`: `rpc(id,'list_items',{project_key:'A'})` lists A's items; `get_item` of a `C-1` key throws `/not in this orchestration's scope/`; `create_item` in B makes an item; `update_item` cannot lift a hold.
  - `set_plan stores steps and waits for approval`: two steps (B after A); `view` shows `phase 'plan'`, `plan_approved false`, 2 steps; `start_step` is unknown yet (Task 3).
  - `set_plan refuses a project out of scope, an unknown item, and a cycle`.
  - `approve moves to run; approving twice is 409`.
  - `set_plan in run goes back to plan and needs a new approval` (Review Focus 4, first half).
  - `set_plan cannot drop a step that has a child session` (Review Focus 4): set `child_session_id` on step 1 through the store, call `set_plan` without it, expect the error text above.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** In `sessions.rpc`, before the assistant branch: `if (s.kind === 'orchestrator') { if (!this.orchestratorRpc) throw new Error('Orchestrator tools are not available'); return this.orchestratorRpc(s, method, p); }` (after `get_chat_image`). `reposOf`, `identityOf` and `spec()` ask `orchestrationOf`. Wire in `app.ts` (`ctx.orchestrator`), close it in the shutdown path next to `scheduler.stop()`.
- [ ] **Step 4: Run** tests and typecheck — PASS.
- [ ] **Step 5: Commit** `feat(orchestrator): start an orchestration, tracker tools inside its scope, a plan the owner approves`.

---

### Task 3: start_step, update_step, get_session, finish

**Files:**
- Modify: `src/server/orchestrator.ts`, `src/server/sessions.ts` (nothing new unless a helper is private)
- Test: `test/orchestrator.test.ts`

**Interfaces — Produces** (RPC): `start_step {step_id}`, `update_step {step_id, state: 'done' | 'skipped', note?}`, `get_session {session_id}`, `finish {result}`.

Rules of `start_step`, in this order, each with its own refusal text (returned as a thrown `Error`):
1. phase is `run` (`The plan is not approved yet.` / `The orchestration is paused.`);
2. the step is this orchestration's and `pending` (`Step N is already <state>.`);
3. every `depends_on` step is `done` or `skipped` (`Step N waits for step M ("title"), which is <state>.`);
4. running children (steps in `running` whose child is not final and not idle-with-nothing-open… simply: steps in state `running`) are fewer than `max_children` (`2 steps are running, which is the limit. Wait for one to finish.`);
5. the project is writable (`assertWritable`), and has a repo;
6. items: keep those not on hold, not done, not canceled, not in review, and not held by an open work session; if the step named items and none is left, refuse (`Nothing left to start: A-1 on hold, …`).

Then `sessions.startBatch(project, { title: step.title, item_ids, new_items: [], prompt: step.prompt_md, options: orchestration.options }, orchestratorSession.started_by)`, `store.setOrchestrator(child.id, orchestratorId)`, step → `running`, `child_session_id`, `seen = null`; system event in the orchestrator's chat `Step N started: session #M`; live event. Answer: `Started session #M for step N. End your turn: Dispatch wakes you when it changes.`

`update_step`: `skipped` only from `pending`; `done` only from `running` or `review` when the child is idle or final and has no open PR (`Step N has an open PR: it is done when that merges.`). Note kept.

`get_session`: only a child of this orchestration; returns `{ id, title, status, waiting_reason, last_text, prs: [{ repo, number, state, blocked, mergeable }], step_id, step_state }`.

`finish`: refused while any step is `running` or `review`. Sets phase `done`, stores `result` as the last text, and finishes the session `completed` (after the turn: add to a `finishWhenIdle` set that Task 4's idle handler reads; when the session is already idle, at once).

- [ ] **Step 1: Write failing tests**, describe `orchestrator: steps` (plan of A1 → B1, plus an independent A2, approved):
  - `start_step starts a batch as the starter, with the orchestration's options`: child is `kind 'work'`, `project_id` A, `options.auto_merge` as given at start, `started_by` the owner, `orchestrator_id` the orchestrator; step `running`.
  - `a step waits for the steps before it` (B1 refused with the text of rule 3).
  - `a step starts once` (Review Focus 2): second `start_step` on the same step is refused; `store.sessions({ kind: 'work' })` has length 1.
  - `the child limit holds`: `max_children: 1`; second independent step refused with rule 4's text.
  - `a locked project refuses, the step stays pending, another project's step still starts` (Review Focus 3).
  - `items on hold are left out; a step whose items are all held is refused`.
  - `update_step: skip a pending step lets its dependants start; done is refused while a PR is open`.
  - `get_session refuses a session that is not a child`.
  - `finish is refused while a step runs; with all steps done it completes the session and sets phase done`.
  - `not approved: start_step is refused`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS, typecheck.
- [ ] **Step 5: Commit** `feat(orchestrator): start a plan's steps as batches, within the server's limits`.

---

### Task 4: Follow the children, wake the orchestrator

**Files:**
- Modify: `src/server/orchestrator.ts`, `src/server/sessions.ts`, `src/server/github.ts`, `src/server/app.ts`
- Test: `test/orchestrator.test.ts`

**Interfaces — Produces:**

```ts
// sessions.ts
onDeployed: ((s: Session, repo: Repo, ok: boolean) => void) | null        // called in onDeployResult
// github.ts
onDeployStarted: ((s: Session, repo: Repo) => void) | null                // before the merged PR row is stored, when Dispatch itself merges a repo with a deploy command
onDeployFailed: ((s: Session, repo: Repo) => void) | null                 // the "worker not connected" branch of deploy()
// orchestrator.ts
wake(sessionId: number, text: string): void    // store the event, then flush
flush(sessionId: number): void                 // deliver all pending events in one message when the session is idle and the phase is plan or run
```

Child tracking: `Orchestrator` subscribes to the bus. On `session` (when `orchestrator_id` is set, or the session is an orchestrator) and on `pr` (through the PR's session), it calls `sync(step)`:

| Child | Step state | Note |
|---|---|---|
| `failed` | `failed` | the failure reason (`failureReason`) |
| `stopped`, and `store.movedTo(child)` exists | unchanged; `child_session_id` → the new session, `setOrchestrator` on it | (Review Focus 5) |
| `stopped` otherwise | `failed` | `stopped` |
| any deploy `failed` | `failed` | `deploy failed` |
| at least one PR, none open, one merged, a deploy `running` | `running` | `deploying` |
| at least one PR, none open, one merged | `done` | |
| `completed` with no PR | `done` | `closed by the owner` |
| `idle`, an open PR that is blocked or not mergeable | `review` | the block reason |
| `idle`, open PRs all `autoMergePending` | `running` | `checking, then auto-merge` |
| `idle`, an open PR | `review` | `waits for the owner's review` |
| `idle`, no PR | `running` | `turn ended, no PR yet` |
| otherwise | `running` | |

`seen` = `${child.status}|${state}|${note}`. When `seen` changes: store state, note and seen, emit the live event, and `wake` with one line: `Step N "title" (KEY, session #M): <what>.` plus the child's `last_text` (first 300 characters) for a turn end. No wake for a change into plain `running` with no note.

Stop on red: when a step turns `failed`, push to the starter: title `<title>: step N failed`, body the note and `Steps X, Y are held.` (the pending steps that depend on it, directly or through others), url `/s/<orchestrator id>`, tag `orch-failed-<step id>`. When a step turns `review` with note `waits for the owner's review`: push `<title>: step N waits for your review`, url `/s/<child id>`.

All steps `done` or `skipped` → wake `All steps are finished. Write the result for the owner and call finish.`

`flush`: nothing when the phase is `paused`, `done` or `stopped`, when there are no pending events, or when the session status is not `idle`. Otherwise mark the events delivered **first**, then `sessions.sendFromDispatch(id, message)`; if that throws, un-mark them. Message:

```
(From Dispatch, not the owner.)
Events:
- <event text>
- …

<statusText>
```

`statusText(o)`:

```
Plan now (phase run, at most 2 at once):
1. [done] A — Token store (step_id 11, session #209)
2. [running: checking, then auto-merge] A — Login page (step_id 12, session #210)
3. [pending] B — Use the new tokens (step_id 13, after 2)
Ready to start: 13        ← step ids whose dependencies are met, or "none"; "none (limit reached)" at the child limit
```

The orchestrator session's own turn end (in `sessions.onWorkerMessage`, status `idle`, kind `orchestrator`): no "waiting for you" push. Instead call `this.onOrchestratorIdle?.(s)`, which: sends the push `<title>: plan ready to approve` when `planNotice` has the session; finishes it when `finishWhenIdle` has it (push `<title>: finished`); else `flush`. A failed orchestrator session keeps the normal failure push. On server start, `Orchestrator.resume()` (called from `app.ts` after wiring) runs `sync` for every step in `running` or `review` and `flush` for every orchestration in `plan` or `run`.

- [ ] **Step 1: Write failing tests**, describe `orchestrator: children` (helpers: `idle(id)`, `fail(id)` through `onWorkerMessage`; a PR row through `s.ctx.store.upsertPr` + `bus.emit({ t: 'pr', pr })`; orchestrator session set idle the same way after its first turn):
  - `a merged child makes the step done and wakes the orchestrator with the plan and what is ready`: expect a `system` event in the orchestrator's transcript containing `Step 1`, `merged`, `Ready to start: <id of step 2>`; `pendingOrchEvents` empty.
  - `events wait while the orchestrator works and come together at its turn end`: orchestrator `running`; two child events; none delivered; `idle(orchestrator)` → one message with both lines.
  - `a failed child fails the step, holds its dependants and tells the owner once` (push title `/step 1 failed/`, body names the held steps; a second identical session event sends no second push).
  - `an open PR without auto-merge puts the step in review and tells the owner`.
  - `a child that waits for auto-merge stays running`.
  - `a deploy keeps the step running until it reports; a failed deploy fails it` (`orchestrator.onDeploy` hooks called directly).
  - `a moved child keeps its step` (Review Focus 5): create a session with `moved_from` = child, stop the child, expect the step `running` with the new `child_session_id`.
  - `all steps finished: it is told to write the result`.
  - `paused: events are kept, resume delivers them` (uses Task 5's pause/resume; write it here, it fails until Task 5 — mark with `it.todo` now and fill in Task 5).
  - `a restart delivers queued events once` (Review Focus 1): add two events through the store while the orchestrator is idle, build a second `Orchestrator` on the same store and call `resume()` twice; exactly one message, both lines.
  - `the orchestrator's own turn end sends no push, except plan ready`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** In `github.ts`, read the merge path first (`mergeOpen` … `if (res.ok) this.deploy(pr)`), and call `onDeployStarted` before anything records the merged state there.
- [ ] **Step 4: Run** the file, then `npm test` whole — PASS (no other test may change).
- [ ] **Step 5: Commit** `feat(orchestrator): follow each step's batch and wake the orchestrator when it changes`.

---

### Task 5: Owner actions and the API

**Files:**
- Create: `src/server/routes/orchestrations.ts`
- Modify: `src/server/orchestrator.ts`, `src/server/app.ts` (register), `src/server/routes/sessions.ts`, `src/shared/attention.ts`, `src/shared/types.ts`
- Test: `test/orchestrator.test.ts`

**Interfaces — Produces:**

```ts
// orchestrator.ts
pause(sessionId: number): Orchestration      // phase plan|run → paused, paused_from kept; 409 otherwise
resume(sessionId: number): Orchestration     // paused → paused_from; then flush
stopAll(sessionId: number, stopChildren: boolean): Orchestration   // phase stopped; children finished 'stopped' when asked; session finished 'stopped'
skipStep(stepId: number): Orchestration      // pending | failed | review(no running child) → skipped; wakes "The owner skipped step N."
retryStep(stepId: number): Orchestration     // failed → pending, child_session_id null, deploys {}, note "retry of session #M"; wakes "The owner asks to retry step N."
```

Routes (scope `read` for GET, `sessions` for the rest; only the starter or the install owner may act, 403 otherwise, as in `routes/schedules.ts`):

- `GET /api/orchestrations` → `Orchestration[]` with each step's `child: { id, status, title, waiting_reason } | null`
- `POST /api/orchestrations` (`orchestrationInput`) → `Orchestration`
- `GET /api/orchestrations/:id`
- `POST /api/orchestrations/:id/approve | pause | resume`
- `POST /api/orchestrations/:id/stop` body `{ stop_children?: boolean }`
- `POST /api/orchestration-steps/:id/skip | retry`

Session detail (`GET /api/sessions/:id`) gains `orchestration: Orchestration | null` (for an orchestrator) and `part_of: { orchestrator_id, title, step_position, step_count } | null` (for a child). `Attention` gains `{ kind: 'plan'; text }` and `{ kind: 'step_failed'; text; step_id }`; `/api/inbox` gives an idle orchestrator `plan` when a plan waits for approval, `step_failed` when a step is failed (text `Step N failed, steps X and Y are held.`), else it is left out of `idle` while it only waits for its children (it is not "your turn").

`waiting` on the view: plan phase with unapproved plan → `Plan ready to approve`; paused → `Paused`; a failed step → `Step N failed`; a running step → `Waiting for #<child> (<note or child status>) in <KEY>`; else null.

- [ ] **Step 1: Write failing tests**, describe `orchestrator: API`:
  - `POST creates, GET lists and shows it with its steps and children`.
  - `approve, pause, resume and stop over the API`; fill in Task 4's `paused` test.
  - `stop with stop_children stops the running batches and puts their items back to todo`.
  - `skip a failed step releases its dependants; retry makes it pending and it can start again` (the retried step's items were `in_progress` under the failed child: they start again).
  - `another user cannot approve or stop it` (`startMultiUser`, 403).
  - `the inbox shows a plan to approve and a failed step, not an orchestrator that only waits`.
  - `a child's session detail says which orchestration and step it is part of`.
  - every new route has a scope (the existing route-scope test must pass).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and typecheck — PASS.
- [ ] **Step 5: Commit** `feat(orchestrator): approve, pause, stop, skip and retry over the API; the inbox shows what it needs`.

---

### Task 6: Worker: prompt, tools, fake runner

**Files:**
- Modify: `src/worker/prompts.ts`, `src/worker/mcp.ts`, `src/worker/runner.ts`, `src/worker/fakeRunner.ts`, `src/shared/protocol.ts` (`RpcMethod`)
- Test: `test/orchestrator-flow.test.ts`, `test/orchestrator.test.ts` (prompt)

**Interfaces — Produces:** `orchestratorPrompt(spec: StartSpec, context: { label: string; text: string }[]): string`.

The prompt says, in this order: what it is (the orchestrator of the goal, the owner follows on the phone); the projects in scope with repos and scales; that it reads code in read-only checkouts and changes nothing itself; **Plan phase**: read trackers and code, ask the owner what is unclear, file missing items with `create_item`, then `set_plan` (one step = one batch = one branch and one PR per changed repo; small enough to review on a phone; `after` for order, also across projects; the step's `prompt` is everything the batch's agent needs beyond its items) and stop; **Run phase**: each message from Dispatch lists events and the plan; start what `Ready to start` names with `start_step`, then end the turn; never poll; on a failed step do not start its dependants, say what happened and what the options are; change the plan only with `set_plan`, which needs the owner's yes; when all steps are finished write the result and call `finish`; it never merges and never takes an item off hold. Then `spec.orchestration.status_md`, then the projects' rule files (`projectRuleLines`).

MCP tools for kind `orchestrator`: `list_projects`, `list_items`, `get_item`, `view_image`, `add_comment`, `create_item`, `update_item`, `set_plan`, `start_step`, `update_step`, `get_session`, `finish`. Runner: `disallowedTools: PLANNER_TOOLS_DENIED` for it; `context` = rule files of all its repos, as for a planner.

Fake runner, kind `orchestrator`:
- text has a line `Ready to start: <ids>` with ids → `start_step` for each, say the answers;
- text has `All steps are finished` → `rpc('finish', { result: '(fake) All done.' })`;
- first turn → `list_projects`, then per project `list_items`, then `set_plan` with one step per project that has open items, each after the one before; say `(fake) Plan ready.`;
- else `(fake) You said: …`.

- [ ] **Step 1: Write failing tests.** `orchestratorPrompt names the scope, the phases and the plan status` (unit). In `test/orchestrator-flow.test.ts`, with a real fake worker (`startWorker`), projects A and B with local-less GitHub repos as other fake-worker tests use: `plans, runs both steps in order and finishes`: start → wait for a plan with 2 steps → approve → wait for step 1's child → mark the child's PR merged (`upsertPr` + bus) → wait for step 2's child → merge it → wait for phase `done` and session `completed`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(orchestrator): the worker's prompt and tools for an orchestrator session`.

---

### Task 7: Web: start sheet and the orchestrator page

**Files:**
- Create: `web/src/components/orchestration.tsx`
- Modify: `web/src/api.ts`, `web/src/live.ts`, `web/src/pages/Activity.tsx`, `web/src/pages/Session.tsx`
- Test: `test/orchestrator-ui.test.ts` (with `test/web-render.ts`, as `failed-sessions-ui.test.ts` does)

**Interfaces — Produces:** `<NewOrchestration />` (button + sheet: goal, project picker with at least one, "At most N at once" 1–5 default 2, `RunOptionsFields`), `<OrchestrationPanel o={Orchestration} mine={boolean} />`.

Panel, top to bottom: projects · `X of N steps` · phase chip; the `waiting` line; **Approve plan** (primary) when a plan waits; the steps: mark (`✓` done, `●` running, `◐` review, `✕` failed, `–` skipped, `○` pending), place, project key, title, item keys, right side `#child status` or `after N` or `held by step N`; a failed step in the danger colour; a row links to its child session; a `⋯` menu per step with Skip (pending, failed, review), Retry (failed), Open the session (has child); header buttons **Pause** / **Resume** and **Stop** (confirm sheet with "Also stop the running sessions" ticked off by default). `plan_md` is shown collapsed under "The plan in full" (`RichMd`). Live: `apply` handles `orchestration` by writing `['orchestration', id]` and invalidating `['orchestrations']`, `['inbox']`.

Session page: for kind `orchestrator` the panel sits above the transcript (in the desktop side panel where the prompt is), the title has no project badge, and the page's own Stop/Complete buttons give way to the panel's.

- [ ] **Step 1: Write failing render tests**: `the panel lists steps with state, project and child`, `Approve shows only for a plan that waits`, `a held step says which step holds it`, `the step menu offers Retry only on a failed step`, `New orchestration needs a goal and a project`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Reuse `Sheet`, `Button`, `Card`, `Section` from `components/ui.tsx` and the batch sheet's `RunOptionsFields`.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run build` — PASS.
- [ ] **Step 5: Commit** `feat(web): start an orchestration and follow its plan on the session page`.

---

### Task 8: Web: Inbox, Activity, child link; README; e2e

**Files:**
- Modify: `web/src/pages/Inbox.tsx`, `web/src/pages/Activity.tsx`, `web/src/components/items.tsx` (`SessionRow`), `web/src/pages/Session.tsx`, `README.md`
- Test: `test/orchestrator-ui.test.ts`, `e2e/orchestrator.spec.ts`

- Inbox: attention `plan` rows go under "Questions & approvals" (`<title>: plan ready to approve`); `step_failed` rows under "Failed" with the text and a link to the orchestrator.
- Activity: an orchestrator's row in Live shows `X/N` and its `waiting` line instead of a project key.
- `SessionRow` and the child's session page: a tag `Part of <title> (step N of M)` linking to `/s/<orchestrator id>`.
- README: section "Orchestrator" after "Scheduled runs": what it is, the two phases, the rules the server enforces, the phase-1 limits (child questions go to you; one GitHub account for its own checkouts; no cost limit yet).

- [ ] **Step 1: Write failing tests**: render tests for the three rows; e2e `start an orchestration, approve the plan, see the first step run` (fake worker, as `flow.spec.ts`).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run build`, `npm run e2e -- --trace off e2e/orchestrator.spec.ts` — PASS.
- [ ] **Step 5: Commit** `feat(web): orchestrations in Inbox and Activity; docs`.
