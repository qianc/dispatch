# Multi-user GitHub identity — implementation plan (DISP-63)

Spec: `docs/superpowers/specs/2026-11-08-multi-user-github-design.md`.
Six phases, each committed on its own after `npm run typecheck && npm test` pass. TDD: write the phase's
tests first, see them fail, implement, see them pass.

## Phase 1 — users and the install owner
**Migration `src/server/migrations/027_users.sql`**
```sql
CREATE TABLE users (
  name TEXT PRIMARY KEY,
  default_worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT
);
ALTER TABLE workers    ADD COLUMN owner TEXT;
ALTER TABLE api_tokens ADD COLUMN user TEXT;
ALTER TABLE schedules  ADD COLUMN owner TEXT;
ALTER TABLE sessions   ADD COLUMN started_by TEXT;  -- NULL after claim = started by no user
CREATE INDEX workers_owner ON workers(owner);
CREATE INDEX sessions_started_by ON sessions(started_by);
```
- `config.ts`: `installOwner` (= `DISPATCH_OWNER` || proxy `authUsers[0]` || `'local'` when off || `'owner'`),
  `secretKey` (`DISPATCH_SECRET_KEY`, `_FILE` via `withFileSecrets`), `githubOAuth` ({clientId, clientSecret} | null).
- `access.ts browserUser()`: return `cfg.installOwner` where it returns `'local'` (off) and `'owner'` (password cookie).
- New `src/server/users.ts` `Users(db, cfg)`: `claim()` — first time (no `settings.install_owner`) fill NULL
  `workers.owner`, `api_tokens.user`, `schedules.owner`, `sessions.started_by`, and set `devices.user`,
  `oauth_grants.user` placeholders, insert `users` row, copy `settings.default_worker_id`; save
  `settings.install_owner`. Later, if the owner changed and the old one was `'owner'`/`'local'`, move rows;
  otherwise warn. `touch(name)` (≤1/min), `isOwner`, `defaultWorker(name)`, `setDefaultWorker`, `list()`.
- `Principal.user: string | null` (user → name; token → `api_tokens.user`; legacy `settings.api_token` → null
  + `legacy: true`; oauth → `oauth_grants.user`).
- `app.ts`: build `Users`, `claim()` after `new Db`; `admin` routes also need `who.user === installOwner` or
  legacy token → 403 "Only the install owner (X) can change this."; `users.touch()`; `users` on `Ctx`.
- `Workers.legacy()` inserts with owner = installOwner.
- `/api/me` adds `is_owner`, `install_owner`. Tokens, devices, OAuth grants: list your own (owner: all, with
  `user`); revoke your own (owner: any). Non-owners cannot create `admin`-scope tokens (400).
- Tests `test/users.test.ts`; helpers `startMultiUser(env)` (proxy mode, `AUTH_USERS=alice,bob`, loopback is the
  proxy) and `as(user)` header helper in `test/helpers.ts`.

## Phase 2 — ownership of workers, schedules and sessions
- `store.createSession` requires `started_by: string | null`; drop the default-worker fallback; `Session.started_by`.
- `sessions.ts`: required `startedBy` on `startBatch` (route: `req.principal.user`; with `proposal` check the user
  may drive that session), `startPlanner`, `startRelease`, `assistantSend`/`discussSend` (threads per user:
  `currentAssistant`/`currentDiscuss` filter by `started_by`), `startScheduled` (= `schedule.owner`),
  `startScheduledBatch` and `move` (inherit). Tests use `OWNER = 'local'` from helpers.
- `workerFor(project, requested, user)`: only workers with `owner === (user ?? installOwner)`; order
  requested → project default if allowed → `users.defaultWorker` → connected → rest; none →
  "You have no worker yet. Add one in Settings → Workers." Same filter for local-repo holders,
  `plannerWorkers`, `move`.
- `PUT /api/settings/default-worker` sets the caller's own default.
- Worker routes: list own (owner: all with `owner`), create = caller, patch = owner, delete = owner or install
  owner, claude-account check = owner. `Workers.create(name, desc, owner)`; `WorkerRecord.owner`.
  Repo placements: install owner or worker's owner.
- Schedules: `owner` on create (refused for user-less token), patch by owner (install owner may only disable),
  delete/run by owner (+ install owner may delete). Reads open.
- New `src/server/sessionGuard.ts` (`SESSION_ROUTES` map like `PROJECT_WRITES`, `canDrive`, `canStop`) and a
  preHandler → 403 "Started by bob: you can read it, not act on it." `GET /api/sessions/:id` adds
  `access: {drive, stop}`; `GET /api/prs/:id` adds `can_merge`. Inbox only for sessions you can drive;
  cleanup only for install owner. Assistant tools that change projects only when starter is install owner.
- Tests: `test/session-guard.test.ts` (route completeness, 403s, owner can stop not reply, per-user inbox),
  `test/ownership.test.ts`; update workers/multi-worker/schedules tests.

## Phase 3 — encryption and per-user GitHub connection
**Migration `028_github_identities.sql`**
```sql
CREATE TABLE github_identities (
  user TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('oauth','pat')),
  github_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  git_name TEXT NOT NULL,
  git_email TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  scopes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  verified_at TEXT,
  last_error TEXT
);
```
- `src/server/secretBox.ts`: `loadKey(cfg, dbFile)` (env key: 64 hex or base64 32 bytes, else throw; else
  `secret.key` beside the DB, `wx` 0600; `:memory:` → random), `seal(plain, aad)` → `v1.` + base64url(iv‖tag‖ct),
  `open(sealed, aad)`. Key-check value in `settings.secret_key_check`; mismatch → identities get
  `last_error` "Connect again".
- `src/server/identities.ts` `Identities`: `profile(token)` and `exchange(code)` seams; `connect(user, token, kind)`
  (classic PAT must have `repo` scope); `get`, `info` (no token), `listConnected`, `disconnect` (OAuth: revoke grant,
  best effort), `markRejected`.
- `src/server/routes/github.ts`: `GET/PUT/DELETE /api/me/github`, `GET /api/github/oauth/start?to=` (state map
  + `dsp_gh_state` cookie, safe `to`), `GET /api/github/oauth/callback` (state, cookie and same user checked).
  All in `ROUTE_ACCESS` as `user`.
- Settings "Your GitHub" section; shared env section and settings query for the owner only; Status shows the
  install owner and the generated key-file path.
- Tests `test/secret-box.test.ts`, `test/github-identity.test.ts` (no token / `token_enc` in any GET response).

## Phase 4 — resolver, preflight, server calls as the starter
- Migration `029_session_github_login.sql`: `ALTER TABLE sessions ADD COLUMN github_login TEXT;`
- `src/server/identity.ts`: `needsGithub(store, project)`, `resolveGithubIdentity(deps, {started_by}, project,
  workerId?)` → `{source:'user', token, login, git_name, git_email}` | `{source:'owner-env'|'shared', account}` |
  refusal `{refused, code, user, message, connect_url}`.
- `sessions.ts preflight()` in every start path before rows are created; `SessionError` carries `extra`
  (code, connect_url) and the app error handler returns it. `dispatch()` re-resolves; refused → wait
  "Needs GitHub: …"; connecting calls `sessions.dispatch()`. `spec()` sets `github` for source `user`, records
  `github_login`. `checkAccounts` skips the env-account check for source `user`. Source `user` on a worker
  without `caps: ['github_cred']` → refused.
- `github.ts`: `clientForToken(token)` (cached), `as(session, repo, 'read'|'write')` → `{octo, gitEnv}`.
  Writes: `createPr`, `openUpstreamPr`, `mergeOpen`, upstream push after merge, mirror push in `syncSession`,
  `deleteRemoteBranch(repo, branch, s)`. Reads with fallback: PR list/get/files, checks, compare, pull upstream.
  Hosted merges commit with the user's author. Octokit 401 on a user token → `markRejected`.
  `push_branch`/`merge_local` commands carry `github` for source `user`.
- `test/github.ts`: `fakeGithub(ctx, impl)` replaces `octo` and `clientForToken`, records tokens per call.
- Tests `test/identity-resolve.test.ts`, `test/github-as-user.test.ts`.

## Phase 5 — worker protocol, env, scrubbing
- `protocol.ts`: `GithubCred`, `StartSpec.github`, `github?` on `push_branch`, `merge_local`, `read_file`,
  `release_version`; `WorkerFacts.caps?`.
- `shared/accounts.ts`: `githubCredEnv(c)` (DISPATCH_GH_TOKEN, GH_TOKEN, GITHUB_TOKEN, author/committer),
  `sessionGithubEnv(spec, envAccounts)`.
- Worker `main.ts`: session env via `sessionGithubEnv`; empty-safe credential helper. `serverLink.ts`: `caps`,
  in-memory creds per session, skip worker.json allow-list for `spec.github`, scrub every send.
  `workspace.ts`: cred threaded through `withRepo`, `prepare`, `pushBranch`, merge, setup/check `commandEnv`.
- `src/shared/scrub.ts` + `src/worker/secrets.ts`; server backup scrub in `Sessions.onWorkerMessage`.
- `fakeRunner`: `[fake:env]` prints the session env's GitHub values (for the leak test).
- Tests `test/worker-github-cred.test.ts`, `test/scrub.test.ts`.

## Phase 6 — UI
- Session: "Started by X", read-only banner, controls gated by `access`.
- PR views: "Opened by …"; merge gated by `can_merge`. `PR_SELECT` joins session `started_by`, `github_login`.
- Project: "Who can act on GitHub here" (`GET /api/projects/:key/github-access`, `?verify=1` permission check,
  10 min cache) + Connect banner.
- `ApiError` keeps `code`, `connect_url`; `ErrorText` links Connect GitHub. Schedules show owner and gate edits.
- Tests: github-access route cases; pure web helpers tested like `test/nav.test.ts`.
