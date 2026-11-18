# Dispatch updates itself when idle (DISP-112)

Status: approved by the owner on 2026-11-18.

## Why

Updating Dispatch is manual: someone runs a deploy script for the server and restarts each worker.
Nothing in the code knows which commit it runs, there is no health check, and a restart at the
wrong moment cuts off a working session. Dispatch should find new versions of its own repo, show
them to the install owner, and (when the owner turns it on) update the server and then each
worker, one at a time, only while no session is working. A failed update goes back to the version before.

## Goals, and what is not one

- The owner sees the running version, the newest version, and what lies between.
- With auto-update on, the server and each worker update without a person, in wait mode only.
- A version that does not start is taken back; the install keeps running on the old one.
- Only a commit on the release branch of the install's own `origin` can be installed. No address
  and no ref name from outside is ever fetched or run.
- Not a goal: signed releases, updating worker Docker images, a public health address.
- Must not happen: an update that cuts off a working session or loses an open question; a fleet
  with every worker down at once; a server that sends a command line to a worker.

## Approaches

1. **Update in the process, then exit and let systemd or Docker restart it.** Small, but nothing
   is alive to see that the new version does not start, so there is no rollback. Not chosen.
2. **A launcher that stays alive** (chosen for git checkouts). `src/launch.ts` starts the server
   or worker as a child. It applies the update while the child is stopped, checks the new child,
   and puts the old commit back when the check fails. It works the same under systemd, Docker and
   a plain shell.
3. **A worker runs an update command** (chosen for a server that runs as an image; the owner's
   decision). An image has no checkout, so the server cannot change itself. A worker that has an
   update command in its own config runs it with the commit, and again with the old commit when
   the server does not come back.

## Design

### Version

- Server and worker read their commit once at start: `git rev-parse HEAD` when the code is a git
  checkout, else the env `DISPATCH_VERSION` (images; a build argument of the Dockerfiles), else
  unknown. The value is not read again: server and worker may share one checkout.
- A worker sends `facts.version = { sha, updatable, why?, server_update? }` in its hello, and the
  capability `self_update`. `updatable` is false with a reason when it was not started through
  the launcher or is not a git checkout.
- The server answers each hello with `{ t: 'welcome', version }`. This is the health signal for a
  worker that updates the server: it works behind a sign-in proxy, where a plain HTTP address
  would not.
- Two versions are the same when one is a prefix of the other (7 characters or more), so a short
  commit id in `DISPATCH_VERSION` works.

### Finding versions (server)

- Service `Updates` (`src/server/updates.ts`), with `start()`, `stop()` and `check()`. It asks
  GitHub with Octokit every `UPDATE_POLL_MINUTES` (default 30; 0 turns the poll off) and on
  "Check now".
- Config: `UPDATE_REPO` (`owner/name`; default: the `origin` of the server's checkout; an image
  must set it), `UPDATE_BRANCH` (default `main`), `UPDATE_GITHUB_ACCOUNT` (default: the first
  shared GitHub account; none: no token, which is enough for a public repo).
- It keeps in the setting `update_state`: when it looked, the branch's newest commit, the highest
  version tag (`v1.2.3`, by `maxVersion`) that is on the branch, how many commits the server is
  behind, their first lines (at most 20), and the last error.
- Setting `update_settings`: `{ auto: boolean, follow: 'commits' | 'tags' }`, default
  `{ auto: false, follow: 'commits' }`. The target is the newest commit, or the newest tag's
  commit with `follow: 'tags'`. A target that is not ahead of the running version is no target.
- The owner gets one notice for each new target.
- With no repo known, the section says how to set it and nothing else runs.

### The launcher and one update (git checkout)

`node src/launch.ts server|worker` starts `src/<role>/main.ts` as a child with an IPC channel and
passes SIGTERM and SIGINT on. Outside an update it ends with the child's exit code, so the outside
restart rule stays as it is. An update has two halves.

**The child, before it asks** (it has the GitHub account; the launcher has none): the id must be
40 hex characters. A fetch of the release branch of `origin` (into `refs/remotes/origin/<branch>`),
and of the tags for the version shown, with the GitHub account `UPDATE_GITHUB_ACCOUNT` names (else
the first the process has, else the machine's own git credentials). The commit must be an ancestor of `origin/<branch>`.
HEAD must be an ancestor of the commit: there is no step back this way, and a process that is
already at or past the commit answers "ahead" and nothing happens. No tracked file may be changed.
HEAD must be on the release branch or detached. The branch is the machine's own `UPDATE_BRANCH`
(default `main`); no message carries a branch or an address.

**The launcher**, asked over IPC with `{ sha, branch, role, from }` (`from`: the commit the child
runs; a full commit id or nothing), runs `applyUpdate`:

1. **Check again, without the network, with the child still running.** Take the lock
   (`<git dir>/dispatch-update.lock`). The same rules as above, on the commits that are now in the
   checkout. A refusal here changes nothing and the child keeps running. The lock holds the
   launcher's process id and start time, so a lock left by a crash is not taken for a live one
   when another process has that id after a reboot.
2. **Journal.** Write `<git dir>/dispatch-update.json`: HEAD, the commit the child ran, the
   target, whether HEAD was on the branch, whether this launcher moves the checkout, whether the
   lock file differs.
3. **Stop the child.** A server that stops for its own update copies its database first (below).
   A server that does not end cleanly (it could not make that copy) is started again as it was,
   and nothing is changed.
4. **Change.** Move the checkout to the commit: `git merge --ff-only` when on the release branch,
   `git checkout --detach` otherwise. `npm ci` when `package-lock.json` differs (without dev
   packages when `vite` is not installed now), and `npm run build` for a server.
   `UPDATE_INSTALL_COMMAND` on that machine replaces the two npm steps. Each step has a time limit.
5. **Start and check.** Start the child. It is healthy when it sends `ready` with the expected
   commit (server: after it listens, so the migrations ran; worker: after its links exist) and is
   still alive after a settle time (10 s). The limit for `ready` is 90 s. A server in its settle
   time takes no worker connection, so nothing a worker sends can land in a database that may be
   put back.
6. **Roll back** on any failure after step 3: stop the child, put the old commit back
   (`git reset --hard` on the branch, `git checkout --detach` otherwise), install again when the
   lock file differs, build again for a server, start the old child.
7. The result `{ ok, from, to, rolled_back, error, log_tail }` goes to the child that runs now,
   over IPC, after its `ready`. The journal and the lock are removed.

A launcher that starts and finds a journal finishes the rollback first. When that fails (no
network for `npm ci` right after a boot), it keeps the journal and exits, so the service starts it
again; after three tries it starts the child on the checkout as it is, and says so. The journal is
removed as soon as the old version is in place, before the old child starts.

A stop of the whole service while the new child is checked is no failed check: the launcher keeps
the journal and ends, and the next start takes the update back. The unit example has
`KillMode=mixed`, so a stop goes to the launcher only.

**The database.** The server owns its copy, the same way for a checkout and for an image. A
server that stops while its own update runs copies the database after it closed it
(`dispatch.db.pre-update`, with a note of the two commits). A server that starts, finds that copy,
runs the old commit of the note, and finds migrations in the database that its own code does not
have, puts the copy back before it opens the database, and keeps the changed database next to it
(`dispatch.db.failed-update`). The copy is removed when the update is logged as ok. Lost on a rollback: what the new server wrote while it lived (a few seconds of the
owner's own edits at most).

**One checkout for server and worker** (my call). The lock lets one launcher work at a time. The
second process finds HEAD at the target: it installs and builds by the commit it ran, restarts
and checks. A server always goes back to the commit it ran, also when the worker moved the
checkout. A worker never moves a checkout back that it did not move itself: the server already
runs the new code on a migrated database. Such a worker reports the failure and starts again on
the new code. A worker that also serves other servers should have a checkout of its own: the
server's `npm ci` can disturb a session that it runs for another server.

**The launcher's own code** (my call). The launcher keeps running old code. It loads the update
steps (`src/update/apply.ts`, which imports nothing of Dispatch) fresh for each update, so they
are those of the version it updates from. Its own small part (start, stop, pass messages on)
changes at the next restart of the service; the three IPC messages stay as they are.

### A server that runs as an image

- A worker's server entry may have `server_update_command` (worker.json), or the env
  `SERVER_UPDATE_COMMAND` for the one server from the env. The worker then reports
  `version.server_update: true` to that server only.
- The server sends `{ t: 'server_update', update_id, sha, prev }`. The worker runs its own command
  with `DISPATCH_UPDATE_SHA`, `DISPATCH_UPDATE_PREV` and `DISPATCH_UPDATE_BRANCH`, with a time
  limit (`UPDATE_TIMEOUT_MIN`, default 20). Only a full commit id reaches the command. A worker
  that runs from a checkout of Dispatch first fetches the release branch itself and refuses a
  commit that is not on it.
- Then it waits (`UPDATE_HEALTH_MIN`, default 5) for a `welcome` from the server with that commit.
- When the command fails or the wait runs out, it runs the command again with
  `DISPATCH_UPDATE_SHA=<prev>` and `DISPATCH_UPDATE_ROLLBACK=1`, and waits for the old commit.
  A worker that can check does so for `prev` too: the way back is also only to a commit of the
  release branch.
- The result is an `update_result` message. Like a deploy result, it waits in the worker's outbox
  until the server is back.
- The server uses this way only when it cannot update itself and knows its own commit. It asks
  the first connected worker of the install owner that has the command (another user's worker
  could say "ok" for an update it never ran), holds queued sessions while the command runs, and
  counts only that worker's result. An "ok" counts only when the server runs the commit. A start
  of the server does not close the update: the worker may still wait for it, or run its way back.
  With no result in 60 minutes the server closes the update by the commit it runs.
- The database copy is the server's own (above): the old image, started again by the rollback,
  puts it back when the new image had migrated the database.

### Wait mode

- **Server gate.** After a `dispatch()` pass (so nothing that can start is left in the queue):
  no session of any kind (work, assistant, discuss) is `running`, no merge and no auto-merge check is in flight, no worker command waits
  for its answer. A session in a usage-limit wait, at turn end or with an open question does not
  close the server gate: the worker keeps its runner and the question is a row in the database.
  While the server updates, a hold keeps queued sessions in the queue with a reason.
- **Worker gate**, checked on the worker over all the servers it serves: no runner in a turn (a
  background task or a set wake-up counts as a turn), none with an open question, nothing
  starting, no turn check, deploy, command or update of a server running, and an empty outbox.
  Then the worker reports 0 free slots to every server and refuses a start as `busy`. Any server
  the worker serves may ask: the worker checks the commit against its own `origin` each time.
- A chat, a reply or a command takes no slot, so the worker looks once more after its answer is
  out. When work came in, it does not stop: it opens its slots and sends `update_result` with
  `not_now`, and the server drops the log row and asks again later. Else it hangs up on all its
  servers before it asks the launcher, so nothing can start that the stop would cut off. When the
  launcher refuses, the same process connects again.
- The server holds a worker from the moment it sends `self_update` until the worker is back or
  the time limit (15 minutes) passed. Queued sessions for it show "Waiting for worker X
  (updating)", and a message to one of its sessions is kept and delivered after.
- A session at turn end never blocks. A usage-limit wait does not block a worker either: it can
  last days, and the restarted session goes back into the wait.

### Rollout

- A rollout starts when a target exists and auto-update is on, or when the owner presses "Update
  now". A manual one is kept in the setting `update_rollout`, so it goes on after the server's
  own restart.
- Order: the server first, then the workers, one at a time. The next starts only when the one
  before is back on the target or failed.
- Workers follow the server: a connected worker that can update and does not run the server's
  commit is asked to move to it (when the last check found that commit on the release branch).
  This also brings the workers along after a server update done by hand.
- A worker checks the commit itself before it starts. One that is already at or past it (another
  server it serves moved it on) answers "ahead": no log row, no notice, and it is not asked again
  for that commit.
- A worker that answers `busy` is asked again at the next tick (30 s). A worker that is not
  connected is passed over. A worker whose link breaks before its answer keeps its log row
  running until it is back, its result comes, or the time limit passed. Back on its old commit
  without an answer "started", it was only asked: the row is dropped and it is asked again.
- A worker's hello on the target closes its update as ok. When it then does not hold (its
  launcher puts the old version back in the settle time), its `rolled_back` result overrules
  that.
- A failed worker stays on its version. The attempt is logged, the owner is told, and the worker
  is not asked again for that target until "Update now".
- A failed server update stops the rollout for that target until "Update now".
- A manual rollout notes the commit the server ran at its start. When the server later runs
  another commit that is not the target (someone deployed by hand), the rollout is dropped: no
  update goes back to an older commit.
- "Update now" on a server that cannot be updated moves only the workers, or says why.
- Table `updates` (migration 041): `target` (`server` or `worker`), `worker_id`, `triggered_by`
  (`auto` or the user), `from_sha`, `to_sha`, `to_tag`, `state` (`running`, `ok`, `failed`,
  `rolled_back`), `detail`, `created_at`, `ended_at`. A `running` row of the server's own update
  by its launcher that a crash left is closed at start by comparing the running commit with the
  target.

### Routes and page

All routes are `admin` (the install owner only):

- `GET /api/update`: versions of the server and the workers, the state above, settings, the
  rollout and why it waits, the last 30 log rows.
- `PUT /api/update/settings`, `POST /api/update/check`, `POST /api/update/start`
  (`{ target?: 'commit' | 'tag' }`), `POST /api/update/cancel`.

Settings gets a section "Updates", for the owner only: the running version, the newest commit and
tag, "N commits behind" with their first lines, the auto-update switch, what to follow, "Check
now", "Update now", "Cancel", why it waits, each worker's version or why it cannot update, and the
log. A live event `{ t: 'update' }` refreshes it.

## Left to the builder

Time limits of the single steps, the exact texts, and the layout of the section.

## Not in this change

Signed releases; updating worker images; a retry button for one worker ("Update now" does it);
a public health address.
