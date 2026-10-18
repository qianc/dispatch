# Several workers, phase 1: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One server takes several worker connections; each session runs on one named worker that
the planner proposes; a worker can serve several servers and owns its slots.

**Architecture:** The server's `WorkerHub` becomes a set of `WorkerLink`s keyed by worker id; every
caller names the worker it talks to (the session's, the repo's or the default one). Worker records
and tokens live in a new `workers` table, made in Settings like personal tokens. The worker process
wraps today's per-connection state in a `ServerLink`, one per configured server, with per-server
allow lists and one shared slot count.

**Tech Stack:** Node 24 (`node:sqlite`, type stripping), Fastify 5, `ws`, React 19 + TanStack Query,
vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-multi-worker-design.md` (phase 1 only).

## Global Constraints

- Today's setup keeps working with no config change: `WORKER_TOKEN` connects as the worker
  "default"; `SERVER_WS_URL`/`LOCAL_REPO_DIRS`/`ASSISTANT_READ_DIRS` act as a config with one server;
  today's workspace layout (`WORKSPACES_DIR/sessions/<id>`) stays for that server.
- The server never holds or sends Claude credentials; the worker reports account names only.
- Worker token secrets: `dsw_` + 32 random bytes base64url; only the sha256 hash is stored.
- Waiting reasons, exact text: `Waiting for worker <name>`, `Waiting for worker <name> (busy)`,
  `Paused`.
- No private names, hosts or addresses in the repo (examples use example.com, 192.0.2.x).
- Repo `kind` column values: `github`, `local` (`hosted` is phase 2 and not accepted yet).

## Review Focus

1. A worker reconnects while the other worker has running sessions: only the reconnecting
   worker's sessions may be resumed or closed (onHello must be scoped to that worker).
2. The worker "default" disconnects while a session waits: other workers' sessions keep starting;
   the queue must not stop at the first session that cannot start.
3. A revoked worker token while connected: the link is closed at once, and the worker's sessions
   wait as for an absent worker.
4. A start that the worker refuses (`busy`) must return the session to `queued` without a
   duplicate start when the worker reports a free slot.
5. Two servers send session id 5 to one worker: the two sessions must not share a runner,
   workspace or Claude conversation folder.

Tests for these are in Tasks 2, 3 and 6.

---

### Task 1: Worker records, tokens and the session/repo/project columns

**Files:**
- Create: `src/server/migrations/013_workers.sql`, `src/server/workers.ts`, `test/workers.test.ts`
- Modify: `src/server/store.ts`, `src/shared/types.ts`, `src/server/access.ts` (route table),
  `src/server/routes/` (new `workers.ts`, registered in `app.ts`)

**Interfaces:**
- Produces: table `workers(id, name UNIQUE, description, prefix, hash UNIQUE, created_at,
  last_seen_at, revoked_at, facts JSON)`; columns `sessions.worker_id`, `sessions.paused`
  (0/1), `sessions.pending_prompt`, `sessions.moved_from`; `repos.kind` (default from
  `local_path`), `repos.worker_id`; `projects.worker_id`, `projects.placement_md`; setting
  `default_worker_id`.
- Produces: `class Workers { list(): WorkerRecord[]; get(id); byName(name); create(name, description): { worker, secret }; update(id, { name?, description? }); revoke(id); verify(secret): WorkerRecord | null; legacy(): WorkerRecord /* the "default" row, made on first use */; defaultId(): number; setFacts(id, facts: WorkerFacts) }`.
- Produces types in `types.ts`: `WorkerRecord { id, name, description, prefix, created_at, last_seen_at, revoked_at, facts: WorkerFacts | null, connected: boolean }`, `WorkerFacts { os, hostname, slots, free_slots, claude_accounts: ClaudeAccountInfo[], github_accounts: string[], local_repo_dirs: string[] }`.
- Routes (scope `admin`, tokens excluded as for `/api/tokens`, i.e. `user`): `GET /api/workers`,
  `POST /api/workers {name, description}` → `{worker, secret}`, `PATCH /api/workers/:id`,
  `DELETE /api/workers/:id` (revoke), `PUT /api/settings/default-worker {worker_id}`.

- [ ] Step 1: tests in `test/workers.test.ts`: create returns `dsw_` secret and stores no secret
  (`JSON.stringify(db rows)` lacks it); `verify` finds it; revoked → null; `legacy()` is idempotent
  and named `default`; migration sets `repos.kind='local'` where `local_path` is set and
  `repos.worker_id`/`sessions.worker_id` to the default worker for existing rows; the route test in
  `access.test.ts` still passes (new routes in `ROUTE_ACCESS`).
- [ ] Step 2: run, see them fail. Step 3: implement. Step 4: `npx vitest run` all green.
  Step 5: commit.

### Task 2: Server hub with several links; every caller names its worker

**Files:**
- Modify: `src/server/workerHub.ts`, `src/server/app.ts` (`/worker` route), `src/server/sessions.ts`,
  `src/server/github.ts`, `src/server/janitor.ts`, `src/server/repos.ts`, `src/server/routes/*.ts`
  that use `hub`, `src/shared/protocol.ts`
- Test: `test/multi-worker.test.ts` (two fake workers, real processes via `startWorker`)

**Interfaces:**
- Produces: `WorkerHub { link(workerId): WorkerLink | undefined; connected(workerId): boolean; connectedIds(): number[]; attach(ws, worker: WorkerRecord); claudeAccounts(workerId?): ClaudeAccountInfo[] }` and `WorkerLink { workerId; send(msg): boolean; cmd<T>(cmd, timeoutMs?): Promise<T>; facts: WorkerFacts | null; close(code, reason) }`. Handlers get the worker id: `onHello(workerId, live)`, `onMessage(workerId, msg)`, `onRpc(workerId, sessionId, method, params)`, `onDisconnect(workerId)`.
- Protocol: `hello` gains `facts?: WorkerFacts`; new worker → server `{ t: 'slots'; free: number }` and `{ t: 'refused'; session_id; reason: 'busy' | string }`.
- `/worker` auth: `x-worker-token` is either the legacy `WORKER_TOKEN` (→ `workers.legacy()`) or a
  worker secret (`workers.verify`). A second connection of the same worker replaces the first (as
  today); different workers coexist. Revoke closes the live link (code 4001).
- Routing rules (the code that picks a worker): a session's messages → `session.worker_id`; repo
  reads with no session (`read_file`, `inspect_local_repo`) → the repo's `worker_id`, else the
  project's worker, else the default; PR `branch_status`/`branch_diff`/`merge_local` → the
  session's worker. Rpc/messages from a worker for a session whose `worker_id` differs are
  ignored.
- `GET /api/worker` keeps `{ connected }` (any worker connected) for the old app, and adds
  `workers: { id, name, connected }[]`.

- [ ] Step 1: tests: two workers connect at once and both show connected; a session on worker B
  starts only on B (worker A's fake runner never sees it: check by stopping A first and seeing the
  session still run); A reconnecting does not resume or close B's running session (Review Focus 1);
  revoking B closes its link and B's queued session shows `Waiting for worker B` (Review Focus 3).
- [ ] Steps 2–5 as usual; all existing tests stay green (they use the legacy token).

### Task 3: Queue per worker, waiting, pausing, replies while away, refusal

**Files:**
- Modify: `src/server/sessions.ts`, `src/server/store.ts` (`queued()` order unchanged)
- Test: `test/multi-worker.test.ts`

**Interfaces:**
- `Sessions.dispatch()`: for each queued, not paused session, in order: skip with reason
  `Waiting for worker <name>` when its worker is not connected (one push notice per session,
  tag `worker-wait-<id>`); skip with `Waiting for worker <name> (busy)` when that worker's
  `free_slots` (from facts/`slots`) is 0; the server-wide `maxConcurrent` stays a cap; `after`
  rules unchanged. Never `return` early on one worker's limit (Review Focus 2).
- `pause(id)` / `resume(id)` (routes `POST /api/sessions/:id/pause|resume`, scope `sessions`): only
  for `queued`; paused shows reason `Paused`.
- `send()` while the session's worker is away: store the user event, set `pending_prompt`, status
  `queued`, reason `Waiting for worker <name>`; `dispatch()` then starts it with
  `resume: sdk_session_id` and prompt `pending_prompt` (cleared after the start).
- `chatSend()` for a new chat while its worker is away: create it `queued` (no 503).
- On `refused`: set the session back to `queued` (no status change on the item), reason busy;
  next `slots` message triggers `dispatch()` (Review Focus 4: one start only).
- `onWorkerHello(workerId, live)`: both loops filter on `worker_id === workerId`.

- [ ] Step 1: tests: a session for an absent worker stays queued with the exact reason and starts
  when that worker connects; another worker's session starts meanwhile; pause → not started on
  connect, resume → starts; a reply to an idle session while its worker is down is delivered after
  reconnect (fake runner echoes it); a worker with `MAX_CONCURRENT_SESSIONS=1` refuses the second
  start and it starts after the first ends, exactly once.
- [ ] Steps 2–5.

### Task 4: Placement: defaults, hard limits, planner input, start options, move

**Files:**
- Modify: `src/server/sessions.ts`, `src/server/repos.ts`, `src/server/routes/projects.ts`,
  `src/server/routes/sessions.ts`, `src/shared/types.ts` (RunOptions/Proposal), `src/worker/prompts.ts`,
  `src/worker/mcp.ts` (propose_batch schema), `src/server/assistant.ts` (add_repo worker)
- Test: `test/placement.test.ts`

**Interfaces:**
- `Sessions.workerFor(project | null, requested?: number | null, kind): number` — local repos'
  worker if the project has any (a different `requested` → `SessionError` "This project's local
  repos are on worker <name>."); else `requested` ?? `project.worker_id` ?? default. Used by
  `startBatch`, `startPlanner`, `discussSend`, `assistantSend` (assistant: default worker).
- Account check at start: if the worker's facts list Claude accounts and lack the session's, or
  list GitHub accounts and lack the project's: `SessionError` naming the worker and the account.
- `RunOptions.worker_id?: number`; batch proposal gains `worker?: string` (a worker name) and
  `worker_reason?: string`; `startBatch` maps the name to an id.
- `addLocalRepo(store, hub, project, path, { worker_id? })`: runs `inspect_local_repo` on that
  worker; refuses when the project already has local repos on another worker.
- Planner context: `StartSpec.workers?: { name, description, connected, local_repo_dirs, claude_accounts, github_accounts }[]` and `StartSpec.placement_md?: string`, filled for planner sessions; `prompts.ts` adds a "Where work runs" block telling the planner to set `worker` and a one-line `worker_reason` on `propose_batch`, to keep work that needs a particular machine there, and to propose an `after` batch instead of parallel work on the same module on different workers.
- `Sessions.move(id, workerId)`: queued → change `worker_id`; started work session with no local
  repos → finish old as `stopped` without resetting items, create a new work session (same items,
  same branch, `moved_from`), move its open PR rows, prompt "Continue the work on branch <b>; it was
  started on worker <old> and pushed." Local repos → `SessionError`. Route
  `POST /api/sessions/:id/move {worker_id}` (scope `sessions`).
- Project PATCH accepts `worker_id`, `placement_md`.

- [ ] Step 1: tests: `workerFor` cases (local repo forces worker; conflicting request refused;
  project default; global default); add local repo on a second worker refused; planner spec
  carries workers and placement text; a proposal with `worker: "B"` starts on B; move of a queued
  session; move of a started session creates a linked one; move with local repos refused; start
  refused when the worker lacks the Claude account.
- [ ] Steps 2–5.

### Task 5: Merge metrics

**Files:**
- Create: `src/server/migrations/014_merge_metrics.sql`
- Modify: `src/server/github.ts`, `src/server/app.ts` (`onBehind`), `src/server/sessions.ts`
  (resolve-conflicts start), `src/shared/types.ts`, `web/src/pages/` PR view
- Test: `test/merge-metrics.test.ts`

**Interfaces:**
- Table `merge_events(id, session_id, pr_id NULL, kind, detail, created_at)`, kinds
  `asked_update`, `resolve_conflicts`, `manual_merge`; column `pull_requests.behind_at_merge`.
- `Store.addMergeEvent(sessionId, kind, prId?, detail?)`, `Store.mergeEvents(sessionId)`.
- Recorded: `onBehind` → `asked_update`; starting the resolve-conflicts session →
  `resolve_conflicts`; an owner Merge click on a PR whose session has auto-merge on and whose
  auto-merge stopped (blocked/conflict) → `manual_merge`; on merge, `behind_at_merge` from the
  last `branch_status`.
- `GET /api/prs/:id` adds `behind_at_merge` and `hands: { kind, created_at }[]`.

- [ ] Step 1: tests for each recorded event with the mocked GitHub of `sessions.test.ts`.
- [ ] Steps 2–5.

### Task 6: Worker process: several servers, allow lists, owned slots

**Files:**
- Create: `src/worker/config.ts`, `src/worker/serverLink.ts`
- Modify: `src/worker/main.ts`, `src/worker/workspace.ts` (root per link only), `.env.example`, `README.md`
- Test: `test/worker-config.test.ts`, `test/multi-worker.test.ts`

**Interfaces:**
- `loadWorkerConfig(env): WorkerConfig` — `WORKER_CONFIG` (path to JSON) or env fallback:
  `{ max_concurrent: number; servers: ServerEntry[] }`, `ServerEntry { name; url; token;
  local_repo_dirs: string[]; read_dirs: string[]; claude_accounts: string[] | null /* null = all */;
  github_accounts: string[] | null }`. Env fallback: one entry named `default` from
  `SERVER_WS_URL`, `WORKER_TOKEN`, `LOCAL_REPO_DIRS`, `ASSISTANT_READ_DIRS`; `max_concurrent` from
  `MAX_CONCURRENT_SESSIONS` (default 3). Names must be unique and match `^[a-z0-9-]+$`.
- `class ServerLink` holds one connection: ws, outbox, rpc waiting, runners and starting maps
  (keyed by session id, so per server — Review Focus 5), its `Workspaces` (root: first entry
  `WORKSPACES_DIR`, others `WORKSPACES_DIR/servers/<name>`), its allow lists.
- Slots: one counter for all links; `launch` of a new runner when full sends `refused` (busy);
  every start/close sends `slots` to all links.
- Allow lists: `inspect_local_repo`/`read_file` outside the entry's dirs → error; a spec whose
  `claude_account`/`github_account` is not allowed → `status failed` with "This worker does not
  allow account <x> for server <name>."; `hello.facts` reports only allowed accounts and dirs.

- [ ] Step 1: tests: config from env equals today's behaviour; JSON config with two servers; bad
  names rejected; one fake worker connected to two test servers runs session 1 of each at the same
  time without sharing a workspace; the allow list refuses a folder of the other server; with
  `max_concurrent: 1` the second server's start is refused and runs later.
- [ ] Steps 2–5.

### Task 7: The app

**Files:**
- Modify: `web/src/api.ts`, `web/src/pages/Settings.tsx` (Workers section), project settings page,
  the proposal card, the start sheet, the session header, the inbox row
- Test: `e2e/flow.spec.ts` (one new test)

**Interfaces:** consumes the routes of Tasks 1–5.
- Settings → Workers: list (name, online dot, last seen, OS, slots, accounts), New worker (name,
  description; secret shown once with copy), edit description, revoke, default worker picker.
- Project settings: default worker select, "Where work runs" textarea.
- Proposal card and start sheet: worker select (default: the proposal's `worker` or the project
  default), the planner's `worker_reason` under it, a warning line when the worker is offline or
  lacks an account.
- Session header: worker name; Pause/Resume for queued; Move (worker select) with the confirm text
  "This stops the session and starts a new one on <name> from the pushed branch." for started
  sessions.
- Inbox/activity: waiting reason as today (it already shows `waiting_reason`).
- PR view: "Behind at merge: n commits", and the hands events.

- [ ] Step 1: e2e: create worker B in Settings, see the secret once; start a batch with worker B
  picked while B is offline → session shows `Waiting for worker B`; Pause shows `Paused`.
- [ ] Steps 2–5; full unit + e2e suites green; typecheck clean.

### Task 8: Deployment notes in the repo

**Files:** `README.md`, `.env.example`, `docker/` (server image unchanged; document the
`/worker` route that must bypass the browser sign-in, as `/mcp` does).

- [ ] Document the worker config file with an example (example.com hosts), the per-worker tokens,
  and the proxy route for `/worker`. Commit.
