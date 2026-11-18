# Dispatch updates itself when idle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dispatch finds new versions of its own repo, shows them to the install owner, and updates the server and then each worker, one at a time, in wait mode only. A version that does not start is rolled back.

**Architecture:** A launcher process outlives the restart and owns the checkout change and the rollback. The server's `Updates` service finds versions, decides when the gates are open and logs each attempt. Workers answer for their own gate. An image-based server is updated by a worker's own command.

**Tech Stack:** as the rest of the repo (Node 24 type stripping, Fastify, `node:sqlite`, Octokit, vitest).

**Spec:** `docs/superpowers/specs/2026-11-18-self-update-design.md`.

## Global Constraints

- Only a 40-hex commit travels between server, worker and launcher. The machine that applies it fetches from its own `origin` and checks the commit against its own release branch.
- A server never sends command text. The worker's update command comes from the worker's config.
- Every `/api/update*` route is `admin` in `ROUTE_ACCESS`; every non-GET one is `null` in `PROJECT_WRITES`.
- The version is read once at start.
- Each task ends with `npm run typecheck && npm test` green and one commit `feat(app-shell): … (DISP-112)`.
- No private data: the placeholder repo is `you/dispatch`. Run `node scripts/check-private.mjs --staged` before each commit.
- Prose and commits as before: plain short sentences.

## Review Focus

1. A session starts, or a message arrives, between the gate check and the stop: nothing is lost and nothing starts on a process that is about to stop.
2. The new version crashes at start, hangs before `ready`, or the launcher is killed mid-update: the old commit, packages and database are back.
3. A commit that is not on the release branch, a ref name, a URL, a downgrade: refused before anything changes.
4. Two workers behind: never both down. A worker that fails: logged, told, not asked again in a loop.
5. A worker that serves two servers: its gate looks at both, and either server may ask.
6. A non-owner: 403 on every update route, and no section on the page.

---

### Task 1: Version identity

**Files:** create `src/update/version.ts`, `test/update-version.test.ts`; modify `src/shared/types.ts`, `src/shared/protocol.ts`, `src/worker/serverLink.ts`, `src/worker/main.ts`, `src/server/app.ts`, `src/server/routes/ctx.ts`, `docker/Dockerfile.server`, `docker/Dockerfile.worker`, `compose*.yml`.

**Interfaces — Produces:**

```ts
export const SHA_RE: RegExp; // /^[0-9a-f]{40}$/
export interface VersionInfo { sha: string | null; tag: string | null; source: 'git' | 'env' | 'none' }
export function readVersion(dir?: string, env?: NodeJS.ProcessEnv): VersionInfo;
export function sameVersion(a: string | null | undefined, b: string | null | undefined): boolean;
// WorkerFacts.version?: { sha: string | null; updatable: boolean; why?: string; server_update?: boolean }
// ServerToWorker: | { t: 'welcome'; version: string | null }
// LinkShared.version?: WorkerFacts['version']
```

- [ ] Tests (write first, watch fail): a temp git repo gives its commit and tag; no git gives the env value; neither gives `none`; `sameVersion` with a short id; a hand-driven worker's hello gets `welcome`; `facts.version` is kept on the worker row.
- [ ] Implement. Commit.

### Task 2: Finding versions

**Files:** create `src/server/updates.ts`, `src/server/routes/updates.ts`, `test/update-check.test.ts`; modify `src/server/config.ts`, `src/server/routes/ctx.ts`, `src/server/app.ts`, `src/server/access.ts`, `src/server/projectLock.ts`, `src/shared/types.ts`.

**Interfaces — Produces:**

```ts
export interface ReleaseSource {
  latest(): Promise<{ branch_sha: string; branch_date: string; tags: { name: string; sha: string }[] }>;
  compare(base: string, head: string): Promise<{ status: 'ahead' | 'behind' | 'identical' | 'diverged'; ahead_by: number; commits: { sha: string; message: string }[] }>;
}
// types: UpdateState, UpdateSettings, updateSettings (zod), UpdateInfo (what GET /api/update answers)
export class Updates { source: ReleaseSource | null; version: VersionInfo; start(): void; stop(): void; check(): Promise<UpdateState>; target(): { sha: string; tag: string | null } | null; settings(): UpdateSettings; setSettings(p: Partial<UpdateSettings>): UpdateSettings; info(): UpdateInfo }
// Config: updateRepo: string | null; updateBranch: string; updatePollMinutes: number; updateGithubAccount: string | null
```

- [ ] Tests: the highest `v*` tag on the branch wins and a tag off the branch is ignored; `behind_by` and first lines; a source error is kept and the old state stays; one notice for each new target; no repo: "not configured"; a non-owner gets 403 on each route.
- [ ] Implement. Commit.

### Task 3: Apply and roll back

**Files:** create `src/update/apply.ts`, `src/server/preUpdate.ts`, `test/update-apply.test.ts`, `test/pre-update.test.ts`.

**Interfaces — Produces:**

```ts
export interface ApplyRequest { sha: string; branch: string; role: 'server' | 'worker'; dir: string; from?: string | null; installCommand?: string }
export interface ApplyResult { ok: boolean; from: string | null; to: string; rolled_back: boolean; error?: string; log_tail?: string }
export interface ChildControl { stop(): Promise<void>; start(expectSha: string): Promise<void> } // rejects when not healthy
export function verifyTarget(req: ApplyRequest, opts?: { fetch?: boolean; env?: NodeJS.ProcessEnv }): Promise<Verified>; // throws Refusal ('ahead' | 'refused')
export function applyUpdate(req: ApplyRequest, child: ChildControl, opts?: ApplyOptions): Promise<ApplyResult>;
export function recoverJournal(dir: string, opts?: ApplyOptions): Promise<ApplyResult | null>;
```

- [ ] Tests for the server's database copy (`preUpdate.ts`): copied at a stop while its own update runs; put back at a start on the old commit when the database has migrations the code does not know; left alone otherwise.
- [ ] Tests, on a real temp origin and clone with a small app (A healthy, B fails at start, C healthy): A→C ok; A→B rolls back, A runs again, the result says `rolled_back` with the error; refused with nothing changed: a commit off the branch, a URL or ref name, a changed tracked file, a downgrade, HEAD on another branch; a journal left behind is rolled back; HEAD already at the target: a server goes back to the commit it ran, a worker leaves the checkout.
- [ ] Implement. Commit.

### Task 4: Launcher

**Files:** create `src/launch.ts`, `src/update/ipc.ts`, `test/update-launch.test.ts`; modify `src/server/main.ts`, `src/worker/main.ts`, `package.json`, `docs/examples/dispatch-worker.service`, `web/src/workerSetup.ts`.

**Interfaces — Produces:**

```ts
export type ChildToLauncher = { t: 'ready'; sha: string | null } | { t: 'update'; req: Omit<ApplyRequest, 'dir'>; ctx?: unknown };
export type LauncherToChild = { t: 'result'; result: ApplyResult; ctx?: unknown };
export function launcherLink(): LauncherLink; // available, why, request(req, ctx), onResult(fn), ready(sha)
```

- [ ] Tests (the launcher on the small app): it passes SIGTERM on and ends with the child's code; an update request brings up a new child that gets `result`; `available` is false, with the reason, without IPC or without git.
- [ ] Implement. Commit.

### Task 5: Worker gate

**Files:** create `src/worker/updateGate.ts`, `test/worker-update-gate.test.ts`; modify `src/worker/runner.ts`, `src/worker/fakeRunner.ts`, `src/worker/turnCheck.ts`, `src/worker/serverLink.ts`.

**Interfaces — Produces:**

```ts
// AgentRunner.activity(): 'working' | 'asking' | 'limit_wait' | 'idle'
// TurnCheck.running: boolean
// ServerLink.busyReasons(): string[]
// Slots.drain(): void; Slots.draining: boolean
export function updateGate(links: Pick<ServerLink, 'busyReasons' | 'entry'>[]): string[];
```

- [ ] Tests: one reason for each busy source, over two links; an idle runner and a usage-limit wait are free; a runner with an open question blocks; a draining worker answers a start with `refused busy` and reports 0 slots.
- [ ] Implement. Commit.

### Task 6: Server gate and holds

**Files:** create `test/update-gate.test.ts`; modify `src/server/sessions.ts`, `src/server/github.ts`, `src/server/workerHub.ts`, `src/server/updates.ts`.

**Interfaces — Produces:**

```ts
// Sessions.hold: string | null; Sessions.workerHold: (workerId: number) => string | null; Sessions.settlingCount(): number
// GitHub.busy(): boolean; WorkerHub.pendingCommands(workerId?: number): number
// Updates.serverGate(): string[]; Updates.workerGate(workerId: number): string[]
```

- [ ] Tests: a running session closes the server gate; a session at turn end, with an open question or in a usage-limit wait does not; an open question closes that worker's gate; a hold keeps a queued session queued with its reason; a message to a held worker's session is kept in `pending_prompt`.
- [ ] Implement. Commit.

### Task 7: Rollout, server first

**Files:** create `src/server/migrations/040_updates.sql`; modify `src/server/store.ts`, `src/server/updates.ts`, `src/server/routes/updates.ts`, `src/server/main.ts`, `src/server/access.ts`, `src/server/projectLock.ts`, `src/shared/types.ts`; test `test/update-gate.test.ts`.

**Interfaces — Produces:**

```ts
// store: addUpdate(u): UpdateRow; closeUpdate(id, state, detail?): UpdateRow; updates(limit?): UpdateRow[]; runningUpdate(): UpdateRow | undefined
// Updates: launcher: LauncherLink; mode(): 'self' | 'worker' | 'none'; tick(): Promise<void>
//          startRollout(by: string, target?: 'commit' | 'tag'): void; cancel(): void
//          onLauncherResult(r: ApplyResult): void; reconcile(): void
```

- [ ] Tests, with a stand-in launcher: auto on, a new target, a running session → nothing is asked and `GET /api/update` gives the reasons; the turn ends → one row `running` and one request; an ok result closes it; a rolled-back result closes it, tells the owner, and stops the rollout for that target; auto off does nothing until `start`; `cancel` drops it.
- [ ] Implement. Commit.

### Task 8: Workers one at a time

**Files:** modify `src/shared/protocol.ts`, `src/worker/serverLink.ts`, `src/worker/main.ts`, `src/server/workerHub.ts`, `src/server/app.ts`, `src/server/updates.ts`; test `test/update-gate.test.ts`, `test/worker-update-gate.test.ts`.

**Interfaces — Produces:**

```ts
// WorkerCommand: | { c: 'self_update'; sha: string; update_id: number }   → { state: 'started' } | { state: 'busy'; reasons: string[] } | { state: 'ahead' } | { state: 'refused'; reason: string }
// WorkerToServer: | { t: 'update_result'; update_id: number; target: 'worker' | 'server'; ok: boolean; rolled_back: boolean; from: string | null; to: string; error?: string; log_tail?: string }
// HubHandlers.onUpdateResult(workerId: number, msg): void
// Updates.onWorkerHello(workerId: number, facts: WorkerFacts | null): void
```

- [ ] Tests (two hand-driven workers): the second gets `self_update` only after the first is back on the target; `busy` leaves no row and is asked again at the next tick; a failed `update_result` keeps the version, the row is `failed`, the owner is told, and it is not asked again until `start`; a worker that is not back in 15 minutes is `failed`; a worker without the capability is left out with its reason.
- [ ] Implement. Commit.

### Task 9: Image server through a worker

**Files:** create `src/worker/serverUpdate.ts`, `test/server-update.test.ts`; modify `src/shared/protocol.ts`, `src/worker/config.ts`, `src/worker/workspace.ts`, `src/worker/serverLink.ts`, `src/server/updates.ts`.

**Interfaces — Produces:**

```ts
// ServerEntry.server_update_command: string | null
// ServerToWorker: | { t: 'server_update'; update_id: number; sha: string; prev: string }
export function runServerUpdate(d: { command: string; sha: string; prev: string; branch: string; run(command: string, env: Record<string, string>): Promise<{ ok: boolean; output: string }>; waitVersion(sha: string, ms: number): Promise<boolean>; healthMs: number }): Promise<{ ok: boolean; rolled_back: boolean; error?: string; log_tail: string }>;
```

- [ ] Tests: the ok path; a command that fails, and a server that never returns, both run the command again with the old commit; the result closes the server's row after a reconnect; a worker without the command ignores the message; `mode()` is `worker` only when the server knows its commit.
- [ ] Implement. Commit.

### Task 10: Settings section

**Files:** create `web/src/components/updates.tsx`, `test/updates-ui.test.ts`; modify `web/src/pages/Settings.tsx`, `web/src/live.ts`, `src/shared/types.ts`.

- [ ] Tests (`test/web-render.ts`): the owner sees the version, "N commits behind", the switch, each worker with "cannot update: …" and the log; a non-owner sees no section.
- [ ] Implement. Commit.

### Task 11: Docs

**Files:** `README.md` (Configuration tables, a new "Updates" section), `.env.example`, `docker/server.env.example`, `docker/worker.env.example`, `docs/examples/worker.json`.

- [ ] Write. Commit `docs: …`.
