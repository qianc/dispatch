# Several workers, phase 2: hosted repos and the public worker route

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The server can keep a project's repo itself ("hosted"): workers clone from and push to the
server, the owner reviews and merges in Dispatch, and the result can go on to a linked GitHub repo
(or become a PR there). Workers can connect at the public address.

**Architecture:** A bare repo per hosted repo under `DATA_DIR/git/r<id>.git`. The server serves it
with `git http-backend` at `/git/r<id>.git/…`, for worker tokens only (Bearer header). To a worker a
hosted repo is a remote like GitHub: `remoteUrl` points at the server and git gets the token through
`http.extraHeader`. Review, diff, file reads and merges run on the server with plain git
(`merge-tree --write-tree` + `commit-tree`, no worktree); a repo with a `check_command` merges on the
session's worker instead (today's `merge_local`, which runs the check). After a merge into the hosted
default branch the server pushes it to the upstream GitHub repo, if one is linked.

**Tech Stack:** Node 24, Fastify 5, git ≥ 2.38 (server image gets git), vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-multi-worker-design.md` (phase 2; the cloud move itself is
out of scope: the server stays on its current host).

## Global Constraints

- Repo `kind`: `github` | `local` | `hosted`. Hosted rows: `github_owner = 'hosted'`, `github_name` = the
  repo name, `local_path = NULL`; optional `upstream_owner` / `upstream_name` (a GitHub repo).
- Git URL path: `/git/r<id>.git`. Only worker tokens (`dsw_…` or the legacy `WORKER_TOKEN`) may use it;
  anything else gets 401. Credentials never appear in a URL or in process arguments.
- A review row of a hosted repo is like a local repo's: `number = -session id`, `url = ''`. A PR opened
  on the upstream GitHub repo is a normal PR row (number > 0). `PullRequest.local` means "no GitHub
  PR" and is computed from `number < 0`.
- No private names, hosts or addresses in the repo.

## Review Focus

1. A push from a worker that is not allowed (no token, bad token, a personal token) is refused, and a
   path outside `r<id>.git` (`/git/../`, another id) cannot reach another repo.
2. A merge on the server must not move the default branch when it conflicts, and must not lose a
   concurrent push (update-ref with the old value).
3. A failed push to GitHub after a merge leaves Dispatch's repo merged and tells the owner once.
4. A hosted repo's PR opened on GitHub, merged there, brings the result back into the hosted repo
   (fast-forward only; a diverged hosted branch is reported, not overwritten).
5. Backups include the hosted repos.

---

### Task 1: Hosted repos on the server (storage and git)

**Files:** Create `src/server/migrations/015_hosted_repos.sql`, `src/server/hosted.ts`, `test/hosted.test.ts`.
Modify `src/server/store.ts` (map upstream columns), `src/shared/types.ts` (Repo kind/upstream).

**Produces:** `class HostedGit { constructor(dataDir); dir(repo): string; create(repo, defaultBranch): Promise<void>; importFrom(repo, url, env): Promise<void>; branchStatus(repo, branch): Promise<BranchStatus>; branchDiff(repo, branch): Promise<BranchFile[]>; readFile(repo, path): Promise<Buffer>; merge(repo, branch, message, method: 'merge' | 'squash'): Promise<{ ok: true; sha: string } | { ok: false; conflict: boolean; output: string }>; deleteBranch(repo, branch): Promise<boolean>; pushUpstream(repo, refs: string[], env): Promise<{ ok: boolean; output: string }>; fetchUpstreamDefault(repo, env): Promise<{ ok: boolean; output: string }> }`.

- [ ] Tests (real git, temp dirs): create → empty bare repo with HEAD on the default branch; a branch
  pushed into it shows ahead/behind/merged/conflicts like the worker's `branchStatus`; diff lists files;
  merge (merge and squash) moves the default branch and leaves the branch merged; a conflicting merge
  returns `conflict` and leaves the default branch where it was; `readFile` reads the default branch;
  `pushUpstream`/`fetchUpstreamDefault` against a second bare repo standing in for GitHub;
  fetch refuses a non-fast-forward.

### Task 2: Git over HTTP for workers

**Files:** Create `src/server/routes/git.ts`; modify `src/server/app.ts` (register; stream bodies),
`docker/Dockerfile.server` (install git). Test `test/git-http.test.ts`.

- [ ] Tests: `git clone` and `git push` of a branch through the test server with
  `-c http.extraHeader="Authorization: Bearer <worker secret>"` work; no token, a wrong token and a
  personal `dsp_` token get 401; `/git/r999.git` and `/git/..%2Fx` get 404; a GitHub repo's id gets 404.

### Task 3: Making hosted repos (API, Assistant, app)

**Files:** `src/server/routes/projects.ts`, `src/server/repos.ts`, `web/src/pages/Project.tsx` (repo form),
`src/shared/types.ts` (repoInput). Test in `test/hosted.test.ts`.

- [ ] `POST /api/projects/:key/repos { hosted: { name, default_branch?, import?: 'owner/name', upstream?: 'owner/name' } }`
  creates the row and the bare repo (import clones from GitHub with the project's GitHub account);
  `PATCH /api/repos/:id { upstream: 'owner/name' | null }` links/unlinks. Deleting a hosted repo keeps
  the bare repo on disk (renamed `r<id>.deleted-<stamp>.git`).

### Task 4: The worker uses hosted repos

**Files:** `src/worker/workspace.ts` (remoteUrl/cacheDir/gitEnv for hosted), `src/worker/serverLink.ts`
(git base from the link URL, token), `src/worker/main.ts` (agent env), `src/worker/prompts.ts`
(push instructions). Test `test/hosted-worker.test.ts`.

- [ ] Tests: a fake worker on a test server prepares a session on a hosted repo (worktree from the
  server's default branch), commits, `push_branch` lands the branch in the server's bare repo; the
  work prompt tells the agent to push the branch to `origin` and not to open a PR.

### Task 5: Review and merge in Dispatch, and GitHub

**Files:** `src/server/github.ts`, `src/server/routes/prs.ts`, `src/server/store.ts` (`local` from number),
`web/src/pages/Pr.tsx`. Test `test/hosted-review.test.ts`.

- [ ] Tests: a pushed session branch shows as a review row (number −session id) without any worker
  online; the PR view's diff comes from the server; Merge merges on the server (no check command) and
  marks items done; with a check command the merge goes to the session's worker (`merge_local`);
  with an upstream, the merged default branch is pushed to it, and a failed push is reported once;
  "Open a PR on GitHub" pushes the branch to the upstream and records the GitHub PR (mocked Octokit);
  when that PR is merged, the hosted default branch fast-forwards from the upstream.

### Task 6: The rest of the app around hosted repos

**Files:** `src/server/routes/files.ts` (server reads), `src/server/janitor.ts` (delete merged branches
in the hosted repo), `src/server/backup.ts` (tar the `git` folder). Tests in the existing files.

### Task 7: Deploy and docs

- [ ] Server image with git; Traefik: `/worker` and `/git/` on the public host and `/git/` on the LAN
  host, around the browser sign-in, with the proxy secret; README "Hosted repos"; wiki.
