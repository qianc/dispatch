# Orchestrator part 3: timers, cost limit, settings, Assistant card, folded batches — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The orchestrator can wake itself later, stops at a cost limit, and its owner can change its limits and scope while it runs, start one from the Assistant, and see its batches folded under it in Activity.

**Architecture:** All server rules stay in `Orchestrator`. A timer is a queued event with a due time, so it is as durable as any other wake-up. Cost is read from the sessions' own usage, never counted twice. Settings are one PATCH route.

**Tech Stack:** as parts 1 and 2.

**Spec:** `docs/superpowers/specs/2026-11-13-orchestrator-design.md`, Build order part 3.

## Global Constraints

- `wake_me_in`: 5 minutes to 7 days, at most 3 timers waiting per orchestration, only in phase `plan` or `run`. A paused orchestration keeps its timers; they are delivered after resume if due. A closed one drops them.
- Cost of an orchestration = the `usage.cost_usd` of its own session plus that of every session that is or was a batch of one of its steps. `cost_limit_usd` is optional (null: no limit), more than 0, at most 10000.
- At the limit: the orchestration is paused with the reason shown, no new step starts, running batches go on, the owner gets one push, and its batches' open questions go to the owner (as for any pause). Resume is refused while the cost is at or over the limit.
- Settings (`PATCH /api/orchestrations/:id`, the starter only, not on a closed orchestration): `max_children` 1–5, `cost_limit_usd`, `answer_children`, `project_keys`. A project that a step works in cannot leave the scope. A new project must exist and not be disabled. The orchestrator is told what changed.
- The Assistant only proposes an orchestration (a card the owner starts); it starts none itself.
- In Activity an orchestrator's batches are folded under its row. A batch that needs the owner himself is shown without unfolding.
- Prose and commits as before.

## Review Focus

1. A timer comes due while the orchestrator works, is paused, or the server is down: delivered once when it can take it; not lost, not twice.
2. The cost passes the limit in the middle of a batch: nothing is interrupted, nothing new starts, one push; a batch that finishes later still closes its step.
3. The owner removes a project from the scope that a pending step uses, or lowers the limit under what is spent: a clear refusal, or a clean pause.
4. The model sets many timers, or a timer of 0 or of a year: refused.
5. An Assistant card for an orchestration is started twice, or names a project that was disabled since: one orchestration, or a clear refusal.

---

### Task 1: Timers, cost limit and settings on the server

**Files:** create `src/server/migrations/035_orchestrator_comfort.sql`; modify `src/shared/types.ts`, `src/shared/protocol.ts`, `src/server/store.ts`, `src/server/orchestrator.ts`, `src/server/routes/orchestrations.ts`, `src/server/access.ts`, `src/server/sessionGuard.ts`, `src/server/projectLock.ts`, `src/worker/mcp.ts`, `src/worker/prompts.ts`; test `test/orchestrator-comfort.test.ts`.

**Interfaces — Produces:**

```ts
// migration: orchestration_events.due_at TEXT; orchestrations.cost_limit_usd REAL, orchestrations.paused_reason TEXT
// types: Orchestration.cost_usd: number; cost_limit_usd: number | null; paused_reason: string | null; next_wake: string | null
//        orchestrationInput.cost_limit_usd; orchestrationPatch = { max_children?, cost_limit_usd?, answer_children?, project_keys? }
// store: addOrchEvent(id, text, dueAt?: string); pendingOrchEvents(id, now?: string)  // only those due
//        waitingTimers(id, now?: string): { id: number; due_at: string }[]; dueOrchestrations(now?: string): number[]; orchestrationCost(id): number
// orchestrator: tick(): void   // every minute: checkDelegated, and flush every orchestration with a due event
//               now: () => Date   // tests replace it
//               update(sessionId: number, patch): Orchestration
// rpc: wake_me_in { minutes: number, reason: string }
```

- `wake_me_in` answers `Dispatch wakes you in N minutes (at <ISO time>). End your turn.`; the event text is `Your timer: <reason>`. The turn counts as acted (no "waiting for you" push). While a timer waits and nothing else needs the owner, `attention` is null and `waiting` is `Waits for its own timer`.
- Cost check on every session event of the orchestrator or one of its batches when a limit is set: at or over it, in phase `plan` or `run` → `pause` with `paused_reason` `Cost limit reached: $X of $Y used.`, push `<title>: cost limit reached` with body `$X of $Y used. Running sessions go on; no new step starts. Raise the limit to go on.` `resumeOne` clears `paused_reason`, and refuses with `It has used $X of its $Y limit: raise the limit first.`
- `update`: rules of Global Constraints; refusal for a used project `Step N works in KEY: it stays in the scope.`; system line in the chat `Settings changed by the owner: <what>`; wake `The owner changed your settings: <what>.` when `max_children` or the scope changed; `answer_children` off hands open questions over; then the cost check.

- [ ] Tests first: `wake_me_in queues a wake-up that comes when it is due`; `a timer is refused when too short, too long, or the fourth` (Review Focus 4); `a timer that comes due while it works, or while it is paused, is delivered once afterwards` (Review Focus 1); `a restart delivers a timer that came due meanwhile, once`; `a turn that sets a timer does not ask for the owner`; `the cost of an orchestration is its own and its batches'`; `at the limit it pauses once, starts nothing new, and a batch that finishes still closes its step` (Review Focus 2); `resume is refused until the limit is raised`; `settings: limits change, the orchestrator is told`; `settings: a used project stays in scope; a disabled or unknown one is refused; a lowered limit pauses` (Review Focus 3); `settings: another user, and a closed orchestration, are refused`.
- [ ] Implement. `npm test`, typecheck. Commit `feat(orchestrator): timers, a cost limit, and settings that change while it runs`.

### Task 2: The Assistant proposes an orchestration

**Files:** modify `src/shared/types.ts` (`Proposal` gains `{ type: 'orchestration'; title: string; goal: string; project_keys: string[] }`), `src/server/sessions.ts` (proposal schema), `src/server/assistant.ts`, `src/server/routes/orchestrations.ts` (`proposal` ref on POST), `src/worker/mcp.ts`, `web/src/components/transcript.tsx`; tests `test/orchestrator-comfort.test.ts`, `test/orchestrator-comfort-ui.test.ts`.

- Assistant tool `propose_session` gains `type: 'orchestration'` with `goal` and `project_keys` (each must exist and be writable). The card shows the goal (editable) and the projects, with **Start orchestration**; started, it says `Started orchestration #N` and cannot start again (409, Review Focus 5).

- [ ] Tests first, implement, commit `feat(assistant): propose an orchestration as a card`.

### Task 3: The app: settings, cost, folded batches

**Files:** modify `web/src/orchestration.ts`, `web/src/components/orchestration.tsx`, `web/src/pages/Activity.tsx`, `web/src/components/items.tsx`, `README.md`, the spec's "As built"; tests `test/orchestrator-comfort-ui.test.ts`, `e2e/orchestrator.spec.ts`.

- Panel header: cost `$4.10`, or `$4.10 of $20`; a settings button (who may act, open orchestration) opens a sheet with "Batches at once", "Cost limit ($, empty: none)", "It answers its batches' questions", and the projects (a project a step works in is fixed). The start sheet gets the cost limit field too. A paused orchestration shows its reason; `next_wake` shows as `Wakes itself <time>`.
- `foldLive(live, orchestrations, attention)` in `web/src/orchestration.ts`: rows for Activity's Live list. A batch whose orchestrator is in the list is not a row of its own: it is under its orchestrator, behind `N sessions` (closed by default), except a batch that needs the owner (`waiting_input` and not asked to the orchestrator, or an attention that waits on the owner), which shows directly under the orchestrator.

- [ ] Tests first, implement, `npm test`, typecheck, build, e2e. Commit `feat(web): an orchestration's cost and settings; its batches folded under it in Activity`.
