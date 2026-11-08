# Multi-user Dispatch: per-user GitHub identity, user-owned workers and schedules (DISP-63)

## Why
One Dispatch install can have several signed-in people (proxy auth with `AUTH_USERS`). Today every GitHub
action runs as the single account in `GITHUB_TOKEN` / `GITHUB_ACCOUNTS`, so commits, pushes, PRs and merges
show that account, and its access becomes everyone's access. Workers and schedules belong to nobody, so any
user can start work on any machine.

Goal: each GitHub action runs as the person who started it; each worker and schedule belongs to one person;
other people's sessions are read-only. A single-user install with only `GITHUB_TOKEN` behaves as today.

## Decisions by the owner
- Connect GitHub per user in Settings with a **GitHub OAuth App** (`GITHUB_OAUTH_CLIENT_ID`,
  `GITHUB_OAUTH_CLIENT_SECRET`; callback `/api/github/oauth/callback`; scopes `repo read:user user:email`).
  A pasted personal access token is the fallback. Tokens are stored on the server, AES-256-GCM encrypted,
  never sent to the browser.
- The encryption key is `DISPATCH_SECRET_KEY` (or `DISPATCH_SECRET_KEY_FILE`). Without it, Dispatch generates a
  key into a 0600 file `secret.key` next to the database and says so in Settings.
- **A user action never falls back to the shared account.** A user with no connected identity is refused before
  the session starts, with a one-click Connect link.
- **Install owner** = `DISPATCH_OWNER`, else the first `AUTH_USERS` entry, else the single-user principal.
  The owner inherits all existing workers, schedules, sessions, tokens and devices. The env GitHub accounts
  count as the owner's identity, so single-user installs are unchanged.
- Other users' sessions are **read-only** (the install owner may also stop them and clean up).
- Workers are **strictly per user**: only the owning user starts work on a worker.
- Each user manages their own workers, API tokens and devices. The install owner sees and can revoke all,
  and alone manages projects and install settings.
- Schedules belong to their creator; everyone can read them.

## Rules (builder's calls, approved with the plan)
**Identity resolution** (`resolveGithubIdentity`, one function):
| Who started it | Result |
|---|---|
| user with a connection | `user` (their token, name, email). Exception: the install owner on a project with `github_account` set uses that env account (`owner-env`). |
| install owner, no connection | `owner-env`: today's behaviour (worker env accounts, server env accounts). |
| other user, no connection | refused `github_not_connected` |
| nobody (`started_by` NULL: legacy token, system) | `shared` env account if configured, else refused `github_shared_missing` |
A project that needs no GitHub (only local repos, or hosted without upstream) needs no identity.
Schedules run as their owner. Never another user's token.

**Server-side calls:** writes (`pulls.create`, `pulls.merge`, `git.deleteRef`, hosted upstream pushes) use only
the starter's identity. Reads (PR sync, CI checks, compare) try the starter, then the shared client.

**Commit identity:** GitHub `name ?? login` and primary verified email, else `<id>+<login>@users.noreply.github.com`.

**Worker:** for source `user`, the server sends `StartSpec.github = {token, login, git_name, git_email}`
(memory only, never on disk). The worker uses it for the session's clone, push, setup and check commands and
the agent's `GH_TOKEN`. Otherwise the worker's env accounts are used as today. Workers report
`caps: ['github_cred']`; an older worker cannot run a user-identity session ("update the worker").

**No leaks:** no token in any API response, log or transcript. The worker scrubs every known secret from every
message it sends; the server scrubs again before saving events.

**Preflight:** every start path (batch, planner, release, discuss, schedule, move) resolves the identity
before creating any row. A refusal is a 403 with `{error, code, connect_url}`. A queued session re-checks at
dispatch and waits "Needs GitHub" until the user connects.

## UI
- Settings → "Your GitHub": Connect with GitHub, Paste a token, Disconnect, shows @login, name, email.
  The shared env account section shows only to the install owner. Status shows the install owner and the key-file warning.
- Session: "Started by X"; read-only banner and hidden controls for others.
- PR: "Opened by bob (@bob-gh)".
- Project: "Who can act on GitHub here" (connected users + owner env accounts, optional permission check),
  and a Connect banner when you cannot.
- Errors with `connect_url` show a Connect GitHub link. Schedules show their owner.

## Data
- `users(name, default_worker_id, created_at, last_seen_at)`; owner columns `workers.owner`,
  `api_tokens.user`, `schedules.owner`, `sessions.started_by`; `github_identities`; `sessions.github_login`.
- On first start after upgrade, `Users.claim()` gives every existing row to the install owner.

## Out of scope
Per-user push notifications (follow-up item). GitHub App tokens. Real OAuth round trip in tests (behind a seam).
