# Per-worker dev environments: research (DISP-43)

Date: 2026-10-30. Status: recommendation. Follow-up items will build it.

This note assumes three workers. Each worker has its own dev environment (env files, venv,
caches). The note answers two questions: how GitHub repos get a working environment on each
worker, and how a local in-place repo can sit at a different path on each worker.

## What exists today

- **Clones are already per worker.** Each worker keeps its own cache clone in
  `WORKSPACES_DIR/cache/<owner>/<name>` and makes a git worktree per session in
  `sessions/<id>/<repo>` (`src/worker/workspace.ts:190-302`). The worker creates both. The
  server never sees these paths.
- **Setup is declared per repo.** `repos.setup_command` runs once in each new session worktree
  (`src/worker/serverLink.ts:274`, `workspace.ts:347`) before the agent starts. It is the same
  text on every worker. `check_command` runs at the end of a turn and before a local merge.
  `deploy_command` runs after a merge.
- **There is no env-file or venv logic.** Commands get the worker's `process.env` and the repo's
  GitHub account env, and nothing more. `.env` files are git-ignored in Dispatch itself, but
  nothing copies them into worktrees.
- **Gap.** `mergeLocal` runs `check_command` in a fresh `merge/<uuid>` worktree, and `deploy` uses
  a fresh `deploy/<uuid>` worktree for non-local repos (`workspace.ts:387-457`). Neither worktree
  gets `setup_command`. A repo that needs a venv or a `.env` can pass its check in the session
  and then fail it at merge time.
- **Local repos are one path on one worker.** `repos.local_path` is an absolute path and
  `repos.worker_id` is its worker. All of a project's local repos must be on one worker
  (`src/server/repos.ts:14-21`), and sessions on them can run only there
  (`SessionManager.workerFor`, `src/server/sessions.ts:160`).

## Question 1: GitHub URL repos

### Where each worker's clone lives, and who creates it

Keep this as it is. Each worker clones into its own `WORKSPACES_DIR` and owns its cache, its
session worktrees and its cleanup. Three workers means three independent caches. No server
change is needed.

### How env files and venvs are provisioned, and kept out of the repo

| Option | Pros | Cons |
|---|---|---|
| A. Server stores env files per repo and sends them to workers | One place to edit | The server becomes a secret store. Secrets travel over the worker link. The same values go to every worker, but machine-specific values (paths, local ports) differ. |
| B. `setup_command` copies files itself (`cp ~/secrets/x.env .env`) | Works today, no code | The path is hard-coded in a command that every worker shares. It fails silently on a worker without the file. Nothing checks that the file is git-ignored. |
| **C. Worker-side env overlay (recommended)** | Secrets stay on the machine that uses them. Each worker can have its own values. The overlay is visible in worker facts. | Each worker has to be set up by hand, once per repo. |

**Recommendation: C, a worker-side env overlay.**

- The worker config gets `repo_env_dir`, either per server entry or at the top level. The default
  is `~/.config/dispatch/repo-env`. Files in `<repo_env_dir>/<owner>/<name>/` (for local repos:
  `local/<name>`) are copied into each new worktree, with the same relative paths, so
  `.../me/app/.env` becomes `<worktree>/.env`.
- Before it copies a file, the worker runs `git check-ignore` on its target path. If the path is
  not ignored, the worker does not copy it and reports this the same way as a failed setup. This
  keeps secrets out of commits.
- Commands get `DISPATCH_REPO_ENV_DIR`, so a setup script can read extra files without
  hard-coded paths.
- **Venvs** are built per worktree by `setup_command` (for example `uv sync` or
  `python -m venv .venv && ...`), as today. Venv folders must be git-ignored. Package caches
  (uv, npm, pip) are per worker without any extra work, so per-worktree installs stay fast.
- Worker facts add `repo_envs: string[]`, the repos that have an overlay on that worker. The UI
  can then warn that a repo has no env on worker X before a session starts there.

### Which setup steps run, in what order, and where they are declared

Every worktree that Dispatch makes (session, merge and deploy) runs the same steps:

1. Create the worktree (worker).
2. Copy the env overlay (worker config, per machine).
3. Run `setup_command`: install, venv (repo, the same on every worker).
4. Session worktrees: the agent works, then `check_command` runs at the end of each turn.
   Merge worktrees: `check_command`. Deploy worktrees: `deploy_command`.

Steps 2 and 3 for merge and deploy worktrees are new, and they close the gap described above.
Local repos that deploy from the repo itself skip steps 1 to 3, because that repo is already set up.

**Data model change:** none on `repos`. There is a new worker config key, `repo_env_dir`, and a
new worker fact, `repo_envs`. Per-worker overrides of `setup_command` are left out on purpose:
machine differences belong in the overlay, so the command stays the same everywhere.

## Question 2: local in-place repos

### Logical key or path?

**Use a logical key.** The `repos` row (its id, plus `github_name` as the readable key) is the
logical repo. Paths become per-worker **placements**. Items, sessions, check runs and PRs keep
pointing at `repo_id`, so nothing else changes.

### Where the per-worker path mapping lives

| Option | Pros | Cons |
|---|---|---|
| A. Worker config (`local_repos: {"<project>/<name>": "~/path"}`) | The machine owns its paths | You edit a file on each machine to add a repo. The server cannot show or validate the mapping until the worker connects. It duplicates the existing add-repo flow. |
| B. A local file in the repo (`.dispatch.md` or similar) | Travels with the repo | A path is a fact about a machine, not about the repo. Each worker's path differs, so the file cannot be shared. |
| **C. Server table, checked by the worker (recommended)** | One place in the UI. It reuses `inspect_local_repo` and the worker's `local_repo_dirs` as the security boundary. The planner can see where a repo is. | The worker must re-check the paths, because they can change on disk. |

**Recommendation: C, a server table.** The worker config keeps only the allowed roots
(`local_repo_dirs`), as today.

```sql
CREATE TABLE repo_placements (
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  worker_id  INTEGER NOT NULL REFERENCES workers(id),
  local_path TEXT NOT NULL,
  root_sha   TEXT,                           -- first commit, identifies the repo
  status     TEXT NOT NULL DEFAULT 'ok',     -- 'ok' | 'missing' | 'mismatch'
  detail     TEXT,                           -- why it is not ok
  checked_at TEXT,
  PRIMARY KEY (repo_id, worker_id)
);
-- migration: one row per local repo from repos.local_path + repos.worker_id
```

`repos.local_path` and `repos.worker_id` stay, and they name the **home** copy. The home copy is
used when no session names a worker: rule files, file links, releases. If the home copy is
removed, another copy becomes home.

**Built (DISP-45): merges land in the copy where the session ran.** This is different from the
first draft, where merges and deploys went only to the home copy. That would need a way to move
a session branch from one machine to another, and Dispatch has none. Today the session's
worker already runs the merge, the branch status and the deploy, so each copy acts as an
in-place repo on its own worker:

- A session on worker B makes its worktrees in B's copy. Its branch lives there, and Dispatch
  merges it into B's copy and deploys from there.
- The copies are separate git repos. The owner keeps them in step through a shared remote (for
  example gitea). A repo that has no shared remote and must run on several workers should be a
  **hosted** repo, which already works on any worker.
- A started session on a local repo cannot move to another worker, because its branch is in that
  worker's copy. A queued session that has not started can move to any worker that has an ok copy.

The rule that all of a project's local repos must be on one worker is gone. `workerFor` picks a
worker that has an `ok` copy of every local repo in the project. It tries the requested worker
first, then the project's worker, then the global default, then a connected worker.

Adding a local folder whose repo the project already has makes the folder that repo's copy on that
worker. The repos match by the same first commit, or else by the same name. A repo with the
same name but another first commit is refused.

### When a worker has no copy, or the path is wrong

- When a worker sends `hello`, the server re-checks each of that worker's copies with
  `inspect_local_repo`: the path exists, it is inside `local_repo_dirs`, it is a git repo, and its
  first commit equals `root_sha`. The first-commit check catches a path that now holds a different
  repo. The result is stored as `status` and `detail`.
- `workerFor` skips workers whose copy is `missing` or `mismatch`, or that have no copy. If no
  worker is left, the session is not made, and the error names each worker and what is wrong
  ("Worker b has app at /gone/app is missing (/gone/app is not a git repository)."). The project
  settings show the status and detail of each copy, and the batch sheet offers only workers that
  have an ok copy.

## Follow-up work

1. Per-worker env overlay for every worktree (session, merge, deploy), plus setup in merge and
   deploy worktrees (Question 1).
2. Per-worker placements for local repos (`repo_placements`) (Question 2).
