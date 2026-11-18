# Open pull requests of a project's GitHub repos (DISP-111) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each project lists the open pull requests of its GitHub repos, with or without a session, and the owner reads the diff, approves and (on GitHub) merges them in the app.

**Architecture:** An unlinked PR is a `pull_requests` row with `session_id` NULL, so the PR page, `PrDetail` and the GitHub merge keep working by PR id. A project sync in `GitHub` (timer, refresh, on opening the list) fills the rows from `pulls.list`; it never changes what a session-linked row does. Approvals are stored on the row and sent to GitHub as a review by the caller's own identity.

**Tech Stack:** Node 24 (TypeScript run directly), Fastify, `node:sqlite`, `@octokit/rest`, React 19 + TanStack Query + Tailwind, vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-project-prs-design.md`

## Global Constraints

- Private-data rule: no owner name, email or home path in code, tests or fixtures. Fixtures use `me/app`, `octo`, `dependabot[bot]`, `alice`, `bob`. Run `node scripts/check-private.mjs --staged` before each commit (the pre-commit hook does it).
- Commit messages name `DISP-111` and end with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Only repos of kind `github` (no `local_path`, not `hosted`) are synced.
- An unlinked PR never starts agent work: no auto-merge, no `sessions.send`, no worker command.
- A project sync never changes `session_id`, title, state or mergeable of a row that has a session, and never fires that row's side effects, except through `syncPr` for a row that left GitHub's open list.
- Diffs are not stored.
- New env var: `GITHUB_PR_SYNC_SECONDS`, default `300`, `0` turns the timer off.
- Check command of the repo: `npm run typecheck && npm test`. It must pass at the end of every task.
- Match the surrounding code: comment density, names, one-line doc comments that say why.

## Review Focus

1. **GitHub fails during a sync** (403 rate limit, 5xx, no client): the list keeps the last known rows, no row is marked closed, the error shows on the list, other repos still sync. Test in Task 2.
2. **Two syncs of one project at once** (timer, refresh and the list opening): one run, one row per PR. Test in Task 2.
3. **A PR from a fork, or by a deleted user** (`user: null`, head branch named like a session's branch): listed as unlinked, author empty, no crash, not linked to the session. Test in Task 2.
4. **More than one page of open PRs**: every PR is listed (the sync paginates; a PR on page two is not taken for closed). Test in Task 2.
5. **Approved, then the branch moves on**: the approval is shown as earlier, Approve is offered again, and a second approval replaces the first. Tests in Task 3 (server) and Task 4 (screen).

---

### Task 1: Data — nullable session, new columns, store

**Files:**
- Create: `src/server/migrations/040_project_prs.sql`
- Modify: `src/shared/types.ts` (`PullRequest`, new `CiState`, `PrApproval`, `ProjectPr`, `ProjectPrList`)
- Modify: `src/server/store.ts` (`PR_SELECT`, `toPr`, `prs`, `upsertPr`, new `prByNumber`, `setPrMeta`, `setPrApproval`, `setPrReview`)
- Modify (type fallout of `session_id: number | null` only, no behaviour change yet): `src/server/github.ts`, `src/server/routes/prs.ts`, `src/server/routes/sessions.ts`, `src/server/sessionGuard.ts`, `src/server/projectLock.ts`, `src/server/checkRuns.ts`, `src/server/orchestrator.ts`, `web/src/live.ts`, and test factories that build a `PullRequest` by hand
- Test: `test/project-prs-store.test.ts`

**Interfaces:**
- Produces (`src/shared/types.ts`):
  ```ts
  export type CiState = 'pending' | 'success' | 'failure' | 'none';
  export interface PrApproval { at: string; by: string; sha: string | null; review: 'sent' | 'own_pr' | 'failed' | null; note: string | null }
  // PullRequest: session_id: number | null; plus
  //   author: string | null; base_ref: string | null; draft: boolean; changed_files: number | null;
  //   ci_state: CiState | null; gh_updated_at: string | null; approval: PrApproval | null;
  export interface ProjectPr extends PullRequest { linked: { session_id: number; title: string; item_keys: string[] } | null }
  export interface ProjectPrList { prs: ProjectPr[]; synced_at: string | null; error: string | null; github_repos: number }
  ```
- Produces (`Store`):
  ```ts
  prs(filter?: { session_id?: number; repo_id?: number; open_only?: boolean }): PullRequest[]
  prByNumber(repoId: number, number: number): PullRequest | undefined
  upsertPr(p: { session_id: number | null; repo_id; number; url; title; state; mergeable; mergeable_state; head_ref; head_sha }): PullRequest
  setPrMeta(id: number, meta: Partial<Pick<PullRequest, 'author' | 'base_ref' | 'draft' | 'changed_files' | 'ci_state' | 'gh_updated_at'>>): void  // writes only the keys given
  setPrApproval(id: number, a: { by: string; sha: string | null }): void   // approved_at = now(); clears review_state and review_note
  setPrReview(id: number, review: 'sent' | 'own_pr' | 'failed', note: string | null): void
  ```

- [ ] **Step 1: Write the failing tests** in `test/project-prs-store.test.ts`:
  - `'a PR can be stored without a session, and a later upsert with a session links the same row'`: `upsertPr({ session_id: null, … number: 4 })`, then `upsertPr({ session_id: s.id, … number: 4 })`; expect the same `id`, `session_id === s.id`, and `store.prs({ repo_id }).length === 1`.
  - `'an upsert without a session never unlinks a row'`: linked row first, then `session_id: null`; expect `session_id` still `s.id`.
  - `'a row that has a session keeps it'`: linked to session A, then `upsertPr({ session_id: B.id, … })` with a new title; expect `session_id` still A's and the new title (a moved session's stopped predecessor is still polled on the same branch and must not take the PR back).
  - `'meta, approval and review are kept on the row'`: `setPrMeta(id, { author: 'octo', base_ref: 'main', draft: true, changed_files: 3, ci_state: 'pending', gh_updated_at: 't1' })`; a second `setPrMeta(id, { ci_state: 'success' })` leaves `author === 'octo'`; `setPrApproval(id, { by: 'alice', sha: 'abc' })` then `setPrReview(id, 'own_pr', 'n')` gives `approval` `{ by: 'alice', sha: 'abc', review: 'own_pr', note: 'n' }` with `at` set; a second `setPrApproval` gives `review: null`.
  - `'migration 040 keeps existing pull requests and their merge events'`: build a file database by running `001`–`039` by hand with `node:sqlite` (insert their names into `_migrations`), insert a project, repo, session, one `pull_requests` row with `blocked` and `behind_at_merge` set and one `merge_events` row for it, close, then open it with `new Db(file)`; expect the row unchanged (`id`, `session_id`, `blocked`, `behind_at_merge`), the merge event still pointing at it, and an insert with `session_id` NULL to succeed.
- [ ] **Step 2: Run** `npx vitest run test/project-prs-store.test.ts` — FAIL (unknown methods, NOT NULL constraint).
- [ ] **Step 3: Write `040_project_prs.sql`**: rebuild as `002_assistant.sql` does (`CREATE TABLE pull_requests_new`, `INSERT … SELECT` with the column list named, `DROP`, `RENAME`). Columns: the existing ones in today's order (`id, session_id` now nullable, `repo_id, number, url, title, state, mergeable, mergeable_state, head_ref, head_sha, last_synced, blocked, blocked_sha, behind_at_merge`), then `author TEXT, base_ref TEXT, draft INTEGER NOT NULL DEFAULT 0, changed_files INTEGER, ci_state TEXT, gh_updated_at TEXT, approved_at TEXT, approved_by TEXT, approved_sha TEXT, review_state TEXT, review_note TEXT`; keep `UNIQUE (repo_id, number)`; add `CREATE INDEX pull_requests_session ON pull_requests(session_id)`.
- [ ] **Step 4: Types and store.** `toPr`: `session_id` is `numOrNull`; `approval` is null unless `approved_at` is set. `upsertPr` on conflict: `session_id = COALESCE(pull_requests.session_id, excluded.session_id)` (only a row with no session takes one).
- [ ] **Step 5: Fix the type fallout, behaviour unchanged for linked rows.** In `github.ts` add `private sessionOf(pr: PullRequest): Session | undefined` and use it wherever `this.store.session(pr.session_id)` stands. `routes/sessions.ts` inbox: unlinked PRs are left out (`p.session_id !== null`). `sessionGuard.ts` `byPr` gives `undefined` for no session. `projectLock.ts`: the three PR routes find the project through the PR's repo (`store.repo(pr.repo_id)?.project_id`). `web/src/live.ts`: also invalidate `['project-prs']` on a `pr` event.
- [ ] **Step 6: Run** `npm run typecheck && npm test` — PASS (all existing tests too).
- [ ] **Step 7: Commit** `feat(prs): a pull request row can exist without a session (DISP-111)`.

---

### Task 2: Project sync

**Files:**
- Modify: `src/server/github.ts` (sync, session-less `syncPr` / `detail`, caller identity, timer)
- Modify: `src/server/config.ts` (`prSyncSeconds`), `src/server/main.ts`, `src/server/app.ts` (wire `github.callerIdentity`)
- Create: `test/project-prs-helpers.ts`
- Test: `test/project-prs-sync.test.ts`

**Interfaces:**
- Consumes: Task 1's store methods and types.
- Produces (`src/server/github.ts`):
  ```ts
  /** Who asks, for actions outside a session: `user` picks the GitHub identity, `name` goes on the record. */
  export interface Caller { user: string | null; name: string }
  export function ciStateOf(checks: { status: string; conclusion: string | null }[]): CiState
  // on class GitHub:
  callerIdentity: ((user: string | null, repo: Repo) => GithubIdentity | IdentityRefusal | null) | null = null
  syncProjectPrs(project: Pick<Project, 'id'>, opts?: { full?: boolean; caller?: Caller | null }): Promise<void>
  syncOpenPrs(): Promise<void>                       // every project that is not disabled
  prSyncInfo(projectId: number): { synced_at: string | null; error: string | null }
  startPolling(seconds: number, prSeconds?: number)  // prSeconds 0 or missing: no PR timer
  syncPr(prId: number, caller?: Caller | null): Promise<PullRequest>
  detail(prId: number, caller?: Caller | null): Promise<PrDetail>
  ```
  `PrDetail` gains `merge_note: string | null` and `merge_here: boolean` (Task 3 fills them; here `null` and `true`).
- Produces (`test/project-prs-helpers.ts`):
  ```ts
  /** One open PR as GitHub's API gives it. */
  export function ghPr(number: number, over?: Record<string, unknown>): Record<string, any>
  // defaults: html_url `https://github.com/me/app/pull/${number}`, title `PR ${number}`, state 'open', merged_at null, draft false,
  //   user { login: 'dependabot[bot]' }, head { ref: `dep-${number}`, sha: `sha${number}` }, base { ref: 'main' },
  //   updated_at '2026-11-01T00:00:00Z', mergeable true, mergeable_state 'clean', changed_files 2, body ''
  /** A test server with project PP, GitHub repo me/app, and a fake GitHub that answers from `prs` (a Map the test changes). */
  export async function prServer(start?: typeof startServer): Promise<{ s; project; repo; prs: Map<number, Record<string, any>>; checks: Map<string, { name: string; status: string; conclusion: string | null }[]>; gh: ReturnType<typeof fakeGithub>; fail: { list: unknown | null; review: unknown | null } }>
  // pulls.list filters by `state` and by `head` (`me:<ref>`); pulls.get answers by number; checks.listForRef by sha;
  // pulls.listFiles one file; pulls.createReview and pulls.merge record and obey `fail`; paginate calls the method once.
  ```

- [ ] **Step 1: Write the helpers and the failing tests** in `test/project-prs-sync.test.ts` (each calls `s.ctx.github.syncProjectPrs(project)` directly):
  - `'opened: PRs with no session appear with author, branches, CI state and changed files'`: `prs` holds #41 (checks: one `completed`/`success`) and #42 (`draft: true`, no checks); after a sync `store.prs({ repo_id, open_only: true })` has both with `session_id === null`; #41 has `author: 'dependabot[bot]'`, `base_ref: 'main'`, `head_ref: 'dep-41'`, `changed_files: 2`, `ci_state: 'success'`; #42 has `draft: true`, `ci_state: 'none'`.
  - `'updated: the same row gets the new title and head; an unchanged PR costs no pulls.get'`: sync; change #41's `title`, `head.sha` and `updated_at`; clear `gh.calls`; sync; #41 keeps its `id` with the new title and `head_sha`; `gh.calls` has `pulls.get` for 41 only.
  - `'a pending CI state is asked again, a settled one is not'`: #41 pending (`status: 'in_progress'`), #42 success; second sync asks `checks.listForRef` for `sha41` only; with `{ full: true }` for both.
  - `'no checks yet on a fresh PR is asked again; on an old PR it is not'`: #41 with no checks and `updated_at` one minute ago, #42 with no checks and `updated_at` a day ago; the second sync asks `checks.listForRef` for `sha41` only; give `sha41` a successful check and sync: `ci_state` is `'success'`.
  - `'closed and merged PRs leave the open list and keep their state'`: sync; set #41 `state: 'closed', merged_at: 'now'` and #42 `state: 'closed'`; sync; `open_only` list is empty; rows are `merged` and `closed`.
  - `'a session's PR stays one row and keeps its session'`: a work session on branch `dispatch/pp-1-x` with one item, PR #5 with that head ref; `syncSession` then `syncProjectPrs`; one row for #5, `session_id` the session's, `author` filled by the project sync, the item still `in_review` and no second `PR ready` notice.
  - `'a PR the project sync stored first is adopted by its session'`: `syncProjectPrs` first (row unlinked), then `syncSession`; same `id`, now linked, and the item moved to `in_review`.
  - `'local and hosted repos are not asked'`: add a local repo and a hosted repo with an upstream to the project; after a sync every `pulls.list` call names `me/app` with `state: 'open'`.
  - `'a failing GitHub keeps the list and reports the error'` (Review Focus 1): sync; set `fail.list` to an error with `status: 403`; sync again; both rows still `open`; `prSyncInfo(project.id).error` contains the message; a second GitHub repo in the project still synced.
  - `'two syncs at once run once'` (Review Focus 2): `await Promise.all([sync, sync])`; exactly one `pulls.list` call per repo and one row per PR.
  - `'a fork's PR and a deleted author'` (Review Focus 3): #43 with `user: null` and `head: { ref: 'dispatch/pp-1-x', sha: 'f', repo: { full_name: 'other/app' } }` while a session has that branch name; after both syncs #43 is listed with `author: null` and `session_id === null`.
  - `'more than a page of open PRs'` (Review Focus 4): 120 PRs and a `paginate` that walks pages of 100; all 120 rows are open after a second sync.
  - `'a disabled project is skipped by the timer sync'`: disable PP; `syncOpenPrs()` makes no `pulls.list` call.
  - `'the PR page of an unlinked PR'`: `GET /prs/:id` answers 200 with `files.length === 1`, `auto_merge: 'off'`, `hands: []`, `base_ref: 'main'`.
  - `'ciStateOf'`: `[]` → `'none'`; one `in_progress` → `'pending'`; `completed` with `failure` → `'failure'`; `success` + `skipped` + `neutral` → `'success'`.
- [ ] **Step 2: Run** `npx vitest run test/project-prs-sync.test.ts` — FAIL (`syncProjectPrs` is not a function).
- [ ] **Step 3: Identity for a caller.** Split `as()`: `private actingAs(id: GithubIdentity | IdentityRefusal | null, repo: Repo, mode: 'read' | 'write'): Acting` holds today's body after the identity lookup; `as(s, repo, mode)` calls it with `s ? this.identityOf(s) : null`; `private asCaller(caller: Caller | null | undefined, repo: Repo, mode)` calls it with `caller && this.callerIdentity ? this.callerIdentity(caller.user, repo) : null`. `app.ts`: `github.callerIdentity = (user, repo) => { const project = store.project(repo.project_id); return project ? resolveGithubIdentity(identityDeps, { started_by: user }, project) : null; }`.
- [ ] **Step 4: Implement `syncProjectPrs`** as the spec's "Sync" section says. Decisions the tests do not fix:
  - One run per project at a time: a `Map<number, Promise<void>>` of runs in flight; a second call gets the same promise.
  - Per repo, in `try/catch`: the reader is `asCaller(opts.caller, repo, 'read').octo`; none: skip the repo. `octo.paginate(octo.pulls.list, { owner, repo, state: 'open', per_page: 100 })`.
  - Details (`pulls.get` for `changed_files`, `mergeable`, `mergeable_state`; `checkRuns` → `ciStateOf`, a failed check lookup gives `ci_state: null`) only when: no row, `head_sha` differs, `gh_updated_at` differs, `ci_state` is `'pending'` or null, `ci_state` is `'none'` and `gh_updated_at` is less than 30 minutes old, or `opts.full`.
  - A row with a session: `setPrMeta` only, then `bus.emit({ t: 'pr', pr })` when something changed. Else `upsertPr({ session_id: null, … })` + `setPrMeta` + emit.
  - Gone rows: `store.prs({ repo_id, open_only: true })` with `number > 0` that the list lacks → `this.syncPr(row.id, opts.caller)`; only after the list call succeeded.
  - `prSyncInfo`: `synced_at` is set after every run; `error` is the first repo error of the run as `owner/name: message`, or null.
- [ ] **Step 5: Session-less `syncPr` and `detail`.** Add `private recordUnlinked(repo: Repo, p: GhPull): PullRequest` (upsert with `session_id: null`, emit `pr`, nothing else). `syncPr`: no session → `pulls.get` through `asCaller(caller, repo, 'read')` → `recordUnlinked`. `detail`: no session → `auto_merge: 'off'`, `hands: []`, the same three GitHub calls through the caller's reader. For every GitHub PR, `detail` also writes `setPrMeta(pr.id, { changed_files: files.length, ci_state: ciStateOf(checks), base_ref })` from what it fetched.
- [ ] **Step 6: Timer and config.** `config.ts`: `prSyncSeconds: Number(env.GITHUB_PR_SYNC_SECONDS ?? 300)`. `startPolling(seconds, prSeconds = 0)`: when `prSeconds > 0`, a second interval runs `syncOpenPrs()` (first run after 15 s), cleared in `stop()`. `main.ts` passes `cfg.prSyncSeconds`.
- [ ] **Step 7: Run** `npm run typecheck && npm test` — PASS.
- [ ] **Step 8: Commit** `feat(github): sync the open pull requests of a project's GitHub repos (DISP-111)`.

---

### Task 3: List, refresh, approve and merge over the API

**Files:**
- Modify: `src/server/github.ts` (`approve`, `merge` with a caller, `merge_note` / `merge_here` in `detail`)
- Modify: `src/server/routes/prs.ts` (new routes, caller passed on, refusals)
- Modify: `src/server/access.ts` (`ROUTE_ACCESS`), `src/server/sessionGuard.ts` (`SESSION_ROUTES`), `src/server/projectLock.ts` (`PROJECT_WRITES`)
- Test: `test/project-prs-api.test.ts`

**Interfaces:**
- Consumes: Task 2's `Caller`, `syncProjectPrs`, `prSyncInfo`, `syncPr`, `detail`, `asCaller`; `test/project-prs-helpers.ts`.
- Produces (`GitHub`):
  ```ts
  approve(prId: number, caller: Caller): Promise<PullRequest>
  merge(prId: number, how: 'github' | 'local', method: 'squash' | 'merge' | 'rebase', caller?: Caller | null)
  ```
- Produces (HTTP):
  - `GET /api/projects/:key/prs` → `ProjectPrList` (scope `read`). Open rows with `number > 0` of the project's `github` repos, newest PR number first per repo. Starts a background `syncProjectPrs(p, { caller })` when `synced_at` is null or older than 60 s and the project is not disabled.
  - `POST /api/projects/:key/prs/sync` → `ProjectPrList` after `syncProjectPrs(p, { full: true, caller })` (scope `sessions`; `SESSION_ROUTES`: `null`; `PROJECT_WRITES`: `byKey`).
  - `POST /api/prs/:id/approve` → `PullRequest` (scope `sessions`; `SESSION_ROUTES`: `null`; `PROJECT_WRITES`: the PR's repo's project).
  - `GET /api/prs/:id` → calls `detail(id, caller)`; adds `merge_note`, `merge_here`; `can_merge` is `merge_here && (session ? canDrive(…) : true)`; `can_approve` is true for an open GitHub PR (`number > 0`) to a caller with the `sessions` scope, unless `approval.sha === head_sha && approval.by === caller.name` and `approval.review` is `sent` or `own_pr`.
- Exact texts:
  - own PR: `GitHub does not accept an approval of your own pull request.`
  - generate command: `This repo merges only in Dispatch, on a session's worker (it has a generate command). A pull request without a session cannot be merged here.`
  - deploy command: `The repo's deploy command does not run for this merge: it needs a session's worker.`
  - resolve-conflicts and local merge without a session (HTTP 400): `This pull request has no session. Start work from an item.`

- [ ] **Step 1: Write the failing tests** in `test/project-prs-api.test.ts`:
  - `'the list marks each PR as linked or not'`: #41 unlinked, #5 on a session with item `PP-1`; `POST /projects/PP/prs/sync` answers `github_repos: 1`, `error: null`, `synced_at` set; #41 has `linked: null`; #5 has `linked.item_keys` `['PP-1']` and the session's id and title.
  - `'opening the list starts a sync when the last one is old'`: `GET /projects/PP/prs` on a fresh server answers at once with `prs: []`, and `waitFor` a second GET to list #41.
  - `'approve: stored and sent to GitHub as a review'`: `POST /prs/:id/approve` → 200; `approval` is `{ by: 'local', sha: 'sha41', review: 'sent', note: null }` with `at` set; `gh.calls` has `pulls.createReview` with `{ owner: 'me', repo: 'app', pull_number: 41, event: 'APPROVE', commit_id: 'sha41' }`.
  - `'approve your own PR: stored, and said clearly'`: `fail.review` is an error with `status: 422` and message `Unprocessable Entity: "Can not approve your own pull request"`; 200 with `review: 'own_pr'` and the exact own-PR note.
  - `'approve with a token that may not review: stored, not sent'`: `fail.review` with `status: 403`, message `Resource not accessible by personal access token`; 200 with `review: 'failed'` and a `note` that contains that message.
  - `'approved, then the branch moves on'` (Review Focus 5): approve; change #41's head sha and `updated_at`; sync; the row's `approval.sha` is `'sha41'` while `head_sha` is the new one; a second approve sets `approval.sha` to the new head and `review: 'sent'`.
  - `'a second person is offered Approve, and a failed review can be sent again'` (with `startMultiUser`): after alice's `sent` approval, `GET /prs/:id` gives alice `can_approve: false` and bob `can_approve: true`; bob approves: `approval.by === 'bob'` and two `pulls.createReview` calls in all. After an approval that ended `failed`, the same caller has `can_approve: true`; with `fail.review` cleared, a second approve ends `sent`.
  - `'a closed PR and a local review cannot be approved'`: 400 for a row with `state: 'closed'` and for a local repo's review row (`number < 0`).
  - `'each person approves as themselves'` (with `startMultiUser`, bob connected with his own token as `test/github-as-user.test.ts` does): bob's approve makes `pulls.createReview` with bob's token (`gh.by(BOB_TOKEN)`), `approval.by === 'bob'`. A user with no GitHub connection gets 200 with `review: 'failed'` and the identity refusal's message as the note.
  - `'an unlinked PR merges on GitHub, as the caller'`: `POST /prs/:id/merge { how: 'github', method: 'squash' }` → `pulls.merge` called once, the row ends `merged`; no worker command and no session event.
  - `'an unlinked PR of a repo with a generate command is not merged here'`: `GET /prs/:id` has `merge_here: false`, `can_merge: false` and the exact generate note; the merge route answers 400 and makes no `pulls.merge` call.
  - `'a deploy command is named, not run'`: repo with `deploy_command`; `merge_note` is the exact deploy note, `merge_here: true`.
  - `'no agent work on an unlinked PR'`: `POST /prs/:id/resolve-conflicts` → 400 with the exact text; `POST /prs/:id/merge { how: 'local' }` → 400 with the same text; `store.sessions({})` is unchanged.
  - `'the Inbox has no unlinked PR'`: `GET /inbox` → `prs` is empty while the project list has #41.
  - `'a disabled project refuses refresh and approve'`: 423 for both.
  - The route-table tests that already exist (`test/access.test.ts`, `test/session-guard.test.ts`, `test/project-disable.test.ts`) must pass with the new routes.
- [ ] **Step 2: Run** `npx vitest run test/project-prs-api.test.ts` — FAIL (404 on the new routes).
- [ ] **Step 3: Implement `approve`.** Refuse (error with `status: 400`) unless the row is `open` and `number > 0`. `setPrApproval` first, then `createReview` through `asCaller(caller, repo, 'write')` inside `try/catch`: success → `sent`; `status === 422` and the message matches `/own pull request/i` → `own_pr` with the exact note; any other error (a refusal from `asCaller` too) → `failed` with the error's message. Emit `pr`; return the row.
- [ ] **Step 4: Implement the unlinked merge.** `merge(…, caller)` passes the caller to `mergeOpen`; there, for a row with no session: `how === 'local'` or a `generate_command` → error with `status: 400` and the texts above; else `pulls.merge` through `asCaller(caller, repo, 'write')`, then the existing wait loop (`syncPr(prId, caller)`). `deploy` already returns for no session. `detail` sets `merge_note` / `merge_here` for unlinked rows; linked rows get `null` / `true`.
- [ ] **Step 5: Routes and tables.** A `caller(req): Caller` helper in `routes/prs.ts` (`{ user: req.principal!.user, name: principalName(req.principal) }`). The list builder joins each row's session (`linked`) with `store.itemsByIds(session.item_ids)`. `resolve-conflicts` throws `HttpError(400, …)` for no session; the `manual_merge` event is written only for a linked row.
- [ ] **Step 6: Run** `npm run typecheck && npm test` — PASS.
- [ ] **Step 7: Commit** `feat(prs): list, refresh, approve and merge pull requests without a session (DISP-111)`.

---

### Task 4: Screens

**Files:**
- Create: `web/src/prs.ts` (pure helpers), `web/src/components/projectPrs.tsx` (the list)
- Modify: `web/src/pages/Project.tsx` (tab `prs`), `web/src/pages/Pr.tsx` (Approve, unlinked state, notes), `web/src/api.ts` (`PrDetail` gains `merge_note`, `merge_here`, `can_approve?`)
- Test: `test/project-prs-ui.test.ts`

**Interfaces:**
- Consumes: `ProjectPr`, `ProjectPrList`, `PrApproval`, `CiState`; the routes of Task 3.
- Produces (`web/src/prs.ts`):
  ```ts
  /** The chips that say what a PR belongs to: its items' keys, "Session" for a session with no item, or "No item". */
  export function linkLabels(pr: Pick<ProjectPr, 'linked'>): string[]
  /** null: not approved. `current`: the approval is of the head commit. `text`: the state in words. */
  export function approvalView(pr: Pick<PullRequest, 'approval' | 'head_sha'>): { current: boolean; chip: 'Approved' | 'Approved earlier'; text: string } | null
  /** The CI dot: a class for the colour and a word for screen readers; null: not known, no dot. */
  export function ciLook(ci: CiState | null): { cls: string; label: string } | null
  ```
  `approvalView().text`, by `approval.review` — `sent`: `Approved by {by}. Sent to GitHub as a review.`; `own_pr`: `Approved by {by} in Dispatch. GitHub does not accept an approval of your own pull request.`; `failed`: `Approved by {by} in Dispatch. The review did not reach GitHub: {note}`; null: `Approved by {by} in Dispatch.` When not `current`, the text is `Approved by {by} before the last push.` followed by the same second sentence (none for null).
- Produces (`web/src/components/projectPrs.tsx`): `export function ProjectPrs({ project }: { project: ProjectSummary })` and `export function useProjectPrs(key: string)` (query key `['project-prs', key]`, `GET /projects/${key}/prs`).

- [ ] **Step 1: Write the failing tests** in `test/project-prs-ui.test.ts` (static render with `renderPage` / `textOf`, the query client seeded, as `test/orchestrator-comfort-ui.test.ts` does):
  - `'linkLabels'`: `linked: null` → `['No item']`; items `['PP-1', 'PP-2']` → those; a session with no items → `['Session']`.
  - `'approvalView'`: null approval → null; same sha + `sent` → `current: true`, chip `Approved`, the exact `sent` text; other sha → `current: false`, chip `Approved earlier`, text starts `Approved by alice before the last push.`; `own_pr` and `failed` give the exact texts (the `failed` one ends with the note).
  - `'the list shows each PR with its link state'`: seeded with #41 (unlinked, draft, CI success, 2 files, author `dependabot[bot]`) and #40 (linked to `PP-1`, approved); the text contains `PR 41`, `#41`, `dependabot[bot]`, `2 files`, `No item`, `Draft`, `PP-1`, `Approved`; the HTML has `href="/pr/` once per row.
  - `'the list says when there is nothing to show'`: `prs: [], github_repos: 1` → `No open pull requests.`; `github_repos: 0` → `This project has no GitHub repo.`; an `error` is shown.
  - `'the PR page of an unlinked PR'`: seeded `['pr', id]` with `session_id: null`, `author: 'octo'`, `can_merge: true`, `can_approve: true`, `merge_note` the deploy note: the text contains `Not linked to an item`, `@octo`, `Approve`, `Merge`, the deploy note; it does not contain `Merge locally` or `resolve conflicts`.
  - `'the PR page says an approval of your own PR stays in Dispatch'`: `approval.review: 'own_pr'` → the exact `own_pr` text, and no `Approve` button with `can_approve: false`.
  - `'no Merge button when the PR cannot merge here'`: `merge_here: false`, `can_merge: false`, `can_approve: true` → the generate note, no `Merge` button, `Approve` still there.
  - `'a linked GitHub PR also gets Approve; a local review does not'`.
- [ ] **Step 2: Run** `npx vitest run test/project-prs-ui.test.ts` — FAIL (modules missing).
- [ ] **Step 3: Helpers and list.** `ProjectPrs`: a `Section` titled `Open pull requests` whose action is `synced {timeAgo}` and a ↻ button (`POST /projects/${key}/prs/sync`, the answer replaces the query data; disabled while it runs and on a disabled project). Rows in a `Card`, each a `Link` to `/pr/${id}` with `min-w-0`: line one the title (`line-clamp-2`) and the CI dot; line two, muted 12px, `repo#number · author · N files` (repo name only when the project has more than one GitHub repo); line three the chips (`linkLabels`, `Draft`, `approvalView().chip`). Touch target at least 44px high; nothing scrolls sideways at 390px.
- [ ] **Step 4: Tab.** `Project.tsx`: `Tab` gains `'prs'`, placed after `sessions`; label `PRs`, or `PRs · N` when `useProjectPrs` has N > 0 open; the tab renders `<ProjectPrs project={project} />`.
- [ ] **Step 5: PR page.** In `Pr.tsx`: an `approve` mutation (`POST /prs/${id}/approve`, then refetch and invalidate `['project-prs']`); under the header, for `pr.session_id === null`: `Not linked to an item` and `opened by @{author}` when known. The action box shows for an open PR when the caller may merge **or** the PR is a GitHub PR: `Approve` (with `confirm('Approve #N?')`; shown when `can_approve`), the `approvalView().text`, `merge_note`, then the merge controls only when `can_merge`. For an unlinked PR the how-switch and the conflict button are not rendered and `how` is `'github'`.
- [ ] **Step 6: Run** `npm run typecheck && npm test` — PASS.
- [ ] **Step 7: Commit** `feat(web): a project's open pull requests, with approve (DISP-111)`.

---

### Task 5: Docs, phone check, pull request

**Files:**
- Modify: `README.md` (a feature bullet after the "Review the PR diff on your phone" line; the `GITHUB_PR_SYNC_SECONDS` row under `GITHUB_POLL_SECONDS`), `.env.example` if it lists the poll setting
- Modify: `docs/superpowers/specs/2026-11-16-project-prs-design.md` (status line: approved and built)

- [ ] **Step 1: README.** The bullet says: the PRs tab lists every open PR of the project's GitHub repos, linked to an item or not; refresh and the timer; approve (stored in Dispatch, sent as a review; GitHub refuses your own PR and Dispatch says so); merge on GitHub; what an unlinked PR does not do (no agent work, no deploy or generate command).
- [ ] **Step 2: Phone check.** Start a dev server with a throwaway database and a seeded project (rows put in with a small script through the store: one unlinked draft with a long title, one linked and approved, one with failed CI), build the web app, and run `node scripts/screens.mjs <outdir> list=/p/PP?tab=prs pr=/pr/<id>` (iPhone 14 viewport). Look at both screenshots: no sideways scroll, the tab row reaches PRs, chips wrap, buttons are full width. Fix what is off and repeat. The server and its files live in the session's scratch folder, not in the checkout.
- [ ] **Step 3: Whole-branch review** (a fresh reviewer on the diff against `main`, with the spec), fix what it finds.
- [ ] **Step 4: Run** `npm run typecheck && npm test` — PASS. `node scripts/check-private.mjs --range main..HEAD` — no hits.
- [ ] **Step 5: Commit** `docs: open pull requests of a project's GitHub repos (DISP-111)`, push, and open the pull request (body: what changed, `DISP-111`).
