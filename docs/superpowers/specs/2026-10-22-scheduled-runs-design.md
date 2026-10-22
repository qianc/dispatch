# Scheduled planner runs (DISP-13)

## Goal

The owner schedules planner runs per project ("every night at 02:00 on project X, scope: bugs in
module ui"). At that time a planner session looks at the backlog within the scope and starts the
work it picks, without anyone watching. This replaces the manual night-run batch. Each run shows in
the session list with its result.

## Decisions (from the owner)

- Several schedules per project, each with a time, days and a scope in prose (e.g. a filter by
  modules or tags, or "triage new bugs").
- Not greedy: starting nothing is a valid result. Items on hold are never started.
- Triage items are not locked out: the scope may say to triage items and update them.
- At most N batches per run, a setting per schedule, default 1.
- Missed slot (server or worker down): catch up once if the slot was less than 6 hours ago,
  otherwise skip to the next slot.
- No push from the scheduled planner itself; the batches it starts notify as usual.

## Data

Migration `018_schedules.sql`:

- `schedules` (id, project_id → projects ON DELETE CASCADE, name, at_time `HH:MM`, days (JSON
  array of weekday numbers 0=Sun…6=Sat; all seven by default), scope_md, max_batches (≥1, default
  1), options (JSON RunOptions), enabled, last_slot (ISO time of the last slot run, or null),
  last_session_id, created_at, updated_at).
- `sessions.schedule_id` (nullable): the schedule a planner session ran for.

Times are in the server's local time zone (as the backup's `--at`).

## Scheduler (`src/server/scheduler.ts`)

- `latestSlot(schedule, now)`: the most recent slot at or before `now` (on an enabled weekday).
- `due(schedule, now)`: enabled, latest slot exists, `now - slot < 6h`, and `last_slot` is before
  that slot. A schedule created after its slot today does not run until the next slot
  (`last_slot` is set to the current latest slot on create and when the time or days change).
- `nextSlot(schedule, now)` for the UI.
- `Scheduler.tick()` runs every minute (unref'd interval, stopped on close): for each due schedule,
  set `last_slot` first (so a crash never runs it twice), then `run(schedule)`.
- `run(schedule)` (also the **Run now** action): `Sessions.startScheduled(project, schedule)`.
  A failure to create the session (e.g. no repos) is logged and stored on the schedule as
  `last_error`; it shows in the UI.

## The scheduled planner

`Sessions.startScheduled` creates a `planner` session with `schedule_id`, title
`Scheduled: <name>`, on the project's default worker, with the scheduled-planner prompt as the
first message. `StartSpec.schedule` carries `{ name, scope_md, max_batches }`; `plannerPrompt`
uses it instead of "Your job":

- Nobody is watching: do not ask questions; decide yourself.
- Keep to the scope. Starting nothing is a fine result: only start work that clearly fits and is
  ready. Never start items on hold, items in progress or in review, or items already in a batch.
- Read each candidate in full (`get_item`, comments) before choosing.
- `propose_batch` starts the batch at once; at most N batches this run.
- `update_item` may change status, importance, effort, tags and modules, with a comment, when the
  scope asks for it (e.g. triage). `create_item` files new items.
- End with a short summary: what was started and why, or why nothing was.

MCP (worker `dispatchMcp`): a scheduled planner (spec has `schedule`) also gets `update_item` and
`create_item`; `propose_batch` says it starts the batch; `propose_items` is left out (no one is
there to accept the card).

Server rules (`Sessions.rpc` / `propose`), enforced whatever the prompt says:

- `propose` of type `batch` in a scheduled planner calls `startBatch` with the schedule's options
  and the proposal ref, and returns `Started session #N` or the error text. Items that are on hold,
  in progress, in review, done, canceled, or in an open work session are left out; if nothing is
  left the batch is refused. Batches past `max_batches` are refused.
- `update_item` is only for scheduled planners. It cannot change the status of an item on hold,
  and it can only set triage, backlog, todo, hold or canceled. A comment is added with author
  `claude`.
- At the end of the turn (`idle`) a scheduled planner is finished as `completed`; its last text
  is the result. No push is sent for it (proposal-ready, waiting-for-you). A question it asks
  anyway waits for the owner as usual.

## API

- `GET /api/projects/:key/schedules` → schedules with `next_run` and the last session (id, status,
  title, last_text).
- `POST /api/projects/:key/schedules`, `PATCH /api/schedules/:id`, `DELETE /api/schedules/:id`.
- `POST /api/schedules/:id/run` → the new session.

## UI (Project page)

A **Schedules** section: one row per schedule (name, time and days, next run, enabled switch, last
run linked to its session with its result line). Tapping a row opens a sheet to edit it: name, time,
days, scope, max batches, run options (`RunOptionsFields`), and **Run now** and Delete. An **Add
schedule** button opens the same sheet, empty.

## Tests

- Unit: `latestSlot` / `due` / `nextSlot` (weekday filter, catch-up window, created after the slot).
- Server with the fake worker: Run now → planner session with schedule → a `propose_batch` starts a
  work session with the schedule's options; a hold item is left out; a second batch past the cap is
  refused; `update_item` cannot lift a hold; the planner completes at turn end without a push.
- Routes: create, edit, delete, run.
- e2e: add a schedule on the project page and see it listed.
