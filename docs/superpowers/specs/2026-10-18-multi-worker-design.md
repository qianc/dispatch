# Several workers: design

Date: 2026-10-18. Status: draft for review.

## Why

Dispatch has one server and one worker today, and both run on the same machine. Some work needs
a particular machine. Example: a project whose tests drive real PowerPoint, and a generator that
exists only as a Windows exe. That work must run on a Windows desktop that has those programs.
There is no way around that, and we do not look for one.

Later the server and a general Linux worker move to a cloud VM (Azure). The Windows desktop stays
at home, is often asleep, and still has to take the work that needs it.

The owner wants to start work from the app on several machines at once, without the machines
going out of sync.

## Anti-goal (the test of the whole design)

> It has failed if I can't use the app to start work on several machines without them quickly
> going out of sync and leaving me with a lot of manual merge fixes and reviews.

Every choice below is checked against this sentence.

## Goals

1. More than one worker can be connected to one server at the same time.
2. Each session runs on exactly one worker, for its whole life.
3. The planner proposes the worker for a session, from prose descriptions. The owner can change
   the choice.
4. A session whose worker is not connected waits in the queue. The owner gets a notice. The
   session can be paused.
5. Each worker keeps its own Claude login and its own GitHub access.
6. Three kinds of repo: GitHub, local (one worker only) and hosted (on the server).
7. Work started on different workers does not drift apart (see "Staying in sync").

## Non-goals

- A native Windows worker. The Windows desktop runs the worker in WSL, as today, and calls Windows
  programs from there (the worker already adds the Windows PATH for agents).
- Capability labels that the server matches. The server does not need to know what "PowerPoint"
  means. Prose plus the planner's judgement decide.
- Moving a running session between workers on its own. The worktree and the saved Claude
  conversation are on one machine.
- Handing Claude credentials from the server to workers. A subscription login stays on the
  machine where it was made.
- A VPN or tunnel built into Dispatch. A worker only needs to reach the server's address. How
  (public HTTPS with a token, WireGuard, or something else) is a deployment choice.

## What exists today (facts from the code)

- `src/server/workerHub.ts` holds **one** worker connection. A new connection replaces the old
  one. `hub.connected` is checked in `sessions.ts` and `janitor.ts`.
- Only the worker opens the connection (`/worker` WebSocket, `WORKER_TOKEN`). The server never
  connects to a worker.
- The server reads repo files only through worker commands (`read_file`, `branch_diff`,
  `branch_status`, `inspect_local_repo`, `leftovers`, `tidy`, `push_branch`, `merge_local` in
  `src/shared/protocol.ts`).
- The worker says `hello` with the sessions it runs and its Claude accounts
  (`ClaudeAccountInfo`, never credentials).
- Repos are GitHub repos (`github_owner`/`github_name`) or local repos (`local_path`, a folder
  inside the worker's `LOCAL_REPO_DIRS`). Sessions on a local repo are git worktrees of that
  folder.
- Projects name a GitHub account and Claude accounts (`007_accounts.sql`). The worker holds the
  credentials for those names.
- The queue starts sessions while slots are free (`MAX_CONCURRENT_SESSIONS`), and a queued
  "after" batch waits for each earlier batch to finish and merge (`sessions.ts`, about line 600).
- Planner, Discuss and Assistant are sessions too. They run on the worker.

## The design

### Workers

- A worker is a record on the server: id, name, description (prose), token hash, last seen,
  what it reported at `hello`.
- The owner makes a worker in Settings → Workers, like a personal token. The secret
  (`dsw_…`) shows once. The worker uses it instead of the shared `WORKER_TOKEN`. Revoking it
  cuts off that worker alone. Today's `WORKER_TOKEN` keeps working as one worker named
  "default" until the owner retires it, as the old API token did.
- The worker's description is prose that the owner writes. Example: "Windows 11 desktop in WSL.
  Has PowerPoint 365 and the Windows-only generator. Often asleep. Slow to build."
- At `hello` a worker also reports facts: its Claude accounts and their login state, its GitHub
  accounts, its local repos, its OS, and its free session slots. The server shows these with the
  worker and gives them to the planner. They are facts for warnings, not rules.
- Each worker has its own slot count. It is set on the worker record; the default is the number
  the worker reports at `hello`. The server-wide `MAX_CONCURRENT_SESSIONS` stays as an optional
  overall limit. *(Builder's call, settled in review.)*
- Settings has a global default worker. The Assistant (which has no project) runs there, and a
  project without its own default uses it. *(Builder's call.)*

### Placement

- Each project has a new prose setting, "Where work runs". It says when to use which worker.
  Example: "Use the desktop only for work that runs PowerPoint or the generator. Tests that only
  read PPTX files run on Linux."
- The planner gets the worker descriptions, their facts (online or not, accounts, local repos),
  and the project's text. Its proposal card names a worker and gives one line on why. The owner
  can change the worker on the card before the start.
- A batch started without the planner (marked items → Start) uses the project's default worker,
  and the start sheet lets the owner pick another one.
- Discuss, Assistant and planner sessions also need a worker. They use the project's default
  worker. A project with a local repo uses that repo's worker.
- Hard limits that the server enforces, whatever the planner says:
  - A session on a local repo can only run on that repo's worker.
  - All local repos of one project are on the same worker. Adding a local repo on another worker
    is refused. A project can mix that worker's local repos with GitHub or hosted repos; its
    sessions then run on the local repos' worker. *(Builder's call.)*
  - A worker without the project's Claude account or GitHub account cannot take the session.
    The card warns before the start.
- A session stores its worker. Every later message for that session (reply, answer, interrupt,
  resume, push, merge, tidy) goes to that worker.

### A worker that is not there

- A session for a worker that is not connected stays `queued`, with the reason "Waiting for
  worker <name>". The owner gets one push notice. It starts by itself when the worker connects
  and has a free slot.
- An idle session whose worker is away: a reply waits in the queue, and the session shows
  "Waiting for worker <name>".
- A session that was running when its worker went away waits for that worker. On reconnect the
  worker resumes it, as it does after a restart today.
- The owner can pause a waiting session. A paused session does not start when the worker comes
  back. The owner resumes it by hand.
- The owner can move a session that has not started to another worker. A session that has
  started keeps its worker. "Move" then stops it and makes a new session on the other worker,
  linked to the old one, that starts from the pushed branch with a fresh Claude conversation. The
  items and an open PR move to the new session. For a local repo there is no other worker, so
  the move is refused. *(Builder's call.)*

### Logins and tokens

- Each worker keeps its Claude login and its GitHub access on its own machine, as today.
- The server does not send its GitHub token to workers. Merges through the GitHub API stay on the
  server. A local merge runs on the session's worker with that worker's access.
- When a local repo is added, the owner picks the worker, and that worker checks the folder
  (`inspect_local_repo`). A project's Claude and GitHub account names are valid if the project's
  workers have them; the start warns when the chosen worker lacks one. *(Builder's call.)*
- If a worker cannot start a session (Claude login expired, no access to a repo), the session
  fails with that reason, and the owner gets a notice in the app. This uses the existing
  `notice` and `status` messages.

### Repo kinds

1. **GitHub** (today). Any worker with the GitHub account can clone it. Sessions push a branch
   and open a PR. Merge through the GitHub API or a local merge.
2. **Local** (today, now tied to a worker). A folder on one worker's machine. The repo record
   names its worker. Only that worker runs sessions on it, so it cannot drift.
3. **Hosted** (new). The server keeps a bare git repo in its data folder and serves git over
   HTTPS on its own address. Workers clone, fetch and push with their worker token. They need no
   GitHub access for it.
   - Review in Dispatch: the same diff view as a PR (files and a diff for each file, from the
     server's own repo). When the owner approves, the server merges the session branch into its
     default branch.
   - If the hosted repo has a GitHub remote (for example an enterprise GitHub), the server pushes
     the result there after the merge. The owner can choose to open a PR on that GitHub instead
     and review there. The PR choice shows only when a GitHub remote is set.
   - A failed merge offers "Start session to resolve conflicts" on the same branch, as today.
   - A hosted repo without a GitHub remote lives only on the server, so the server's backups must
     include its data folder.
   - Server-side reads (`read_file`, `branch_diff`) for a hosted repo use the server's own repo,
     with no worker needed.
   - A hosted repo gets a review record like a PR record (no GitHub number when there is no
     remote), so the "after" batches and auto-merge keep working. Auto-merge applies, and its
     check is the repo's `check_command`, run on the session's worker. *(Builder's call; phase 2.)*

### Staying in sync

These rules serve the anti-goal:

- Every session starts from a fresh fetch of the latest default branch on its worker. A session
  that waited in the queue fetches when it starts, not when it was queued.
- Before a merge, a branch that is behind is brought up to date the way it is today: Dispatch
  asks the session's agent to merge the default branch (`github.onBehind`), now sent to the
  session's worker. Dispatch does not rebase by itself. If the agent cannot settle it, the owner
  gets the "resolve conflicts" session, not a manual job. *(Builder's call.)*
- A merge through the GitHub API needs no worker. A step that needs the session's worker (asking
  the agent, a local merge) waits in the queue while that worker is away, with the waiting
  reason shown. *(Builder's call.)*
- The existing rules keep working across workers: no two open sessions on the same item, and an
  "after" batch waits for the earlier batch's merge, whichever worker ran it.
- The planner avoids parallel sessions on different workers that touch the same module. It
  proposes them one after the other instead (an "after" batch).
- Measure it, from phase 1: record how many commits behind the default branch a branch was at
  merge, and record each event that needed the owner's hands: a "resolve conflicts" session, an
  agent asked to update its branch, and a manual Merge after auto-merge stopped. Show them in the
  session's PR view. *(Builder's call on which events count.)*

## Phases

1. **Several workers, with today's machine as the Windows worker.** The Windows desktop that runs
   the server and the worker today *is* the Windows worker (it has PowerPoint and the generator,
   and its local repos stay local there). Phase 1 makes room for a second worker, a Linux one
   elsewhere, for work that does not need Windows. It builds: several worker connections, worker
   records and tokens, a session's worker, placement by the planner, waiting and pausing, local
   repos tied to a worker, the per-worker facts. Today's worker becomes the worker "default" with
   all of today's local repos. The server stays where it is.
2. **The cloud move.** Server and a Linux worker on the VM. Hosted repos, with review and merge
   in Dispatch and the optional push or PR to a GitHub remote. A route for `/worker` (and git
   over HTTPS) at the public address that does not go through the browser sign-in, as `/mcp`
   does today.

Plan phase 1 alone. Phase 1 only adds a repo `kind` column (`github`, `local`, later `hosted`)
so phase 2 has room; nothing else of hosted repos is built in phase 1. *(Builder's call.)*

## Left to the builder

- The table and column names, and the migration.
- How the hub keeps several connections and finds a session's worker.
- The git-over-HTTPS server for hosted repos (for example `git http-backend` behind Fastify, or a
  small library).
- How the planner prompt carries the worker descriptions and the project text.
- The exact screens, within the existing look: Settings → Workers, the worker on the proposal
  card and the start sheet, the waiting reason in the inbox.
- Tests for each rule above, with the fake runner and two fake workers.
