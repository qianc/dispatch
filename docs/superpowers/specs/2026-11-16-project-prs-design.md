# Open pull requests of a project's GitHub repos (DISP-111)

Status: approved by the owner and built (DISP-111).

## Why

Dispatch shows a pull request only when it belongs to a session: the PR sync asks GitHub for the
PRs of each session's branch (`GitHub.syncSession`), and every `pull_requests` row has a session.
A PR opened by hand, by a dependency bot or by any tool outside Dispatch is invisible, so the owner
goes to GitHub to review it. This change brings every open PR of a project's GitHub repos into the
app, where the owner can read the diff and approve it (and merge it on GitHub), with or without an
item.

## Goals

- Each project lists the open PRs of its GitHub repos: title, author, branches, CI state, changed
  files, and whether a session and its items are linked.
- The list stays current: a timer and a refresh action. A PR that closes or merges on GitHub leaves
  the list on the next sync.
- The existing PR page (`/pr/:id`) shows the diff of any listed PR.
- The owner approves a PR from that page. The approval is stored in Dispatch and sent to GitHub as
  a review when GitHub accepts it.
- The list and the PR page are usable on a phone.

## Not goals

- No agent work on an unlinked PR: no auto-merge, no "resolve conflicts" session, no check run on a
  worker. Work starts from an item, as today.
- Local repos and hosted repos are not synced (a hosted repo's upstream PRs stay as they are today:
  seen through their session).
- No push notice and no Inbox entry for an unlinked PR. The Inbox stays "what waits on your
  sessions"; the list is on the project.
- No "request changes", comments or review dismissal from the app. An approval is not withdrawn
  from the app.
- Diffs are not stored. The PR page loads the diff from GitHub when it opens, as today.
- No linking of an unlinked PR to an item from the app (a later item if wanted).

## Anti-goals

- A second record for a PR that a session already has.
- A sync that changes what a session-linked PR does today (item status, notices, auto-merge).
- Acting on GitHub with someone else's account (the DISP-63 rule holds for approvals and merges).

## Approaches

- **A nullable session on `pull_requests` (chosen).** An unlinked PR is a `pull_requests` row with
  `session_id` NULL. `UNIQUE (repo_id, number)` already makes one row per PR, so a linked PR cannot
  get a second record, and a session that later meets the PR adopts the row. The PR page, the
  `PrDetail` / `PrFile` types, `/api/prs/:id` and the GitHub merge work by PR id and stay. The cost:
  `PullRequest.session_id` becomes `number | null` and the places that read it directly (about ten)
  handle "no session".
- A separate `synced_prs` table: no type change, but two id spaces. The PR page and the merge path
  take a `pull_requests` id, so they would need a second route and a second detail path, and the
  list would have to hide rows that both tables hold. More code, and the duplicate the owner asked
  to avoid.
- No storage, list from GitHub on every view: nothing to migrate, but slow on a phone, no place for
  the approval, and no stable id for `/pr/:id`.

## Data

Migration `040_project_prs.sql` rebuilds `pull_requests` (SQLite cannot drop NOT NULL; the runner
already turns foreign keys off for a rebuild, as `002_assistant.sql` did for `sessions`):

- `session_id` becomes nullable (still `REFERENCES sessions(id) ON DELETE CASCADE`).
- New columns, all nullable unless said:
  - `author` (GitHub login), `base_ref`, `draft` (INTEGER NOT NULL DEFAULT 0)
  - `changed_files` (INTEGER), `ci_state` (`pending` | `success` | `failure` | `none`; NULL: not known)
  - `gh_updated_at` (GitHub's `updated_at`, to see that a PR changed)
  - `approved_at`, `approved_by` (the Dispatch user or token name), `approved_sha` (the head commit
    that was approved), `review_state` (`sent` | `own_pr` | `failed`), `review_note`

`merge_events.pr_id` keeps pointing at `pull_requests(id)`; ids do not change.

`PullRequest` (shared type) gets `session_id: number | null`, `author`, `base_ref`, `draft`,
`changed_files`, `ci_state` and `approval: { at, by, sha, review, note } | null`.

`Store.upsertPr` takes `session_id: number | null` and, on conflict, sets the session only on a row
that has none (`COALESCE(session_id, excluded.session_id)`): a project sync never unlinks a PR, a
session sync links one that the project sync stored first, and a row that has a session keeps it,
as today. (A moved session hands its PR rows to its successor while the old, stopped session is
still polled on the same branch; it must not take them back.)

## Sync

`GitHub.syncProjectPrs(project, { full, caller })`, for each repo of the project with kind
`github` (not local, not hosted):

1. `pulls.list` with `state: 'open'` (paginated, 100 a page): one call per repo.
2. For each open PR:
   - A row with a session exists: only the new columns are written (author, base, draft, changed
     files, CI state). Title, state, mergeable and all side effects stay with the session sync.
   - Else: the row is stored without a session (title, url, state `open`, head ref and sha, and the
     new columns). No item changes, no notices, no auto-merge.
   - The details that the list call does not give (`changed_files` and `mergeable` from
     `pulls.get`; the CI state from the existing `checkRuns`, which already falls back to Actions
     runs for a token without the Checks permission) are fetched only when the row is new, its head
     sha or `updated_at` changed, its CI state is `pending` or not known, or the sync is `full`.
3. Rows of that repo that are `open` in Dispatch with a GitHub number but are not in the list any
   more go through `syncPr` (one `pulls.get` each), which records `closed` or `merged`. For a
   linked row that is the session path, so its items move as they do today when a PR merges.
4. A repo that fails (no client, 403, 404) does not stop the others; the project's last sync time
   and last error are kept in memory and shown on the list.

CI state from the check runs: none: `none`; any not completed: `pending`; any conclusion other than
success, neutral or skipped: `failure`; else `success`.

A settled CI state on an unchanged head is not asked again by the timer (a re-run of a failed check
shows after a refresh or when the PR page opens). That keeps a repo with twenty bot PRs at one call
per sync. `none` counts as settled only when GitHub's `updated_at` is more than 30 minutes old: a
PR synced before its checks register would else show no CI state until a refresh.

When it runs:

- **Timer:** `GITHUB_PR_SYNC_SECONDS` (default 300; 0 turns it off), started with the existing
  poller. It syncs every project that is not disabled, with the server's env account for the
  project (`clientFor(repo)`, the same client a session-less read uses today). A repo with no such
  client is skipped.
- **On demand:** `POST /api/projects/:key/prs/sync` runs a `full` sync and answers with the list.
  It reads as the caller: their own GitHub connection when they have one, else the env account
  (the `read` rule of `GitHub.as`).
- **On opening the list:** `GET /api/projects/:key/prs` answers from the database at once and, when
  the last sync is older than a minute, starts a sync in the background, reading as the caller. The
  `pr` live events the sync emits refresh the open list.
- **On opening a PR:** `detail` syncs that PR as today, and writes the changed-file count and CI
  state it has fetched anyway.

## As whom

`GitHub.as(session, repo, mode)` picks the session starter's identity. Two paths are added for a
PR without a session; both reuse its body:

- Reads with no caller (the timer): the env account, as `as(null, …)` does today.
- Reads and actions by a caller (the list's background sync, the PR page of an unlinked PR,
  refresh, approve, merge): `resolveGithubIdentity` for the caller's user name and the project
  (`app.ts` wires it, as it does `sessions.identity`). So a user with their own connection acts as
  themselves, the install owner uses the project's env account, a read falls back to the env
  account, and a refusal throws for a write. Nobody's token acts for somebody else. An install with
  no env account still shows unlinked PRs to a user who has a GitHub connection.
- The PR page of a linked PR reads as its session's starter, as today.

## Approve

`POST /api/prs/:id/approve` (scope `sessions`, any open GitHub PR, linked or not; not the local
review entries):

1. Store `approved_at`, `approved_by`, `approved_sha` (the current head).
2. Send `pulls.createReview` with `event: 'APPROVE'` and `commit_id` as the caller.
3. Record how that went and answer 200 in every case:
   - accepted: `sent`.
   - GitHub answers 422 for the author's own PR: `own_pr`, note "GitHub does not accept an approval
     of your own pull request."
   - anything else (no GitHub connection, 403 for a token without the permission, 404): `failed`,
     with the reason as the note.

An approval belongs to a commit: after a push, the page shows "Approved by … before the last push" and
offers Approve again.

The PR record holds one approval: the latest. Approve is offered to a caller unless their own
approval of the current head reached GitHub (`sent`) or cannot (`own_pr`). So a second person can
add their own GitHub review (their approval then replaces the first on the record; both reviews
stay on GitHub), and an approval that `failed` can be sent again once the cause is fixed.
`GET /api/prs/:id` carries that as `can_approve`.

A review is the caller's own act on GitHub, so anyone who may act (`sessions` scope) may approve
any PR, also one whose session someone else started. Merging a session's PR stays with its starter.

## Merge (small change, GitHub only)

An unlinked PR merges through the existing `merge` → `mergeOpen` with `how: 'github'`, as the
caller. What does not fit is refused or said, not built:

- A repo with a generate command always merges in Dispatch on a session's worker. Its unlinked PRs
  get no Merge button; the page says why.
- A repo's deploy command runs on a session's worker. For an unlinked PR it does not run; the page
  says so above the Merge button.
- "Merge locally + push" and "Start a session to resolve conflicts" need a session: not shown, and
  the routes refuse them, for an unlinked PR.

## API

| Route | Scope | Notes |
|---|---|---|
| `GET /api/projects/:key/prs` | read | `{ prs, synced_at, error }`; each PR with `linked: { session_id, title, item_keys } \| null` |
| `POST /api/projects/:key/prs/sync` | sessions | full sync, then the same answer; refused on a disabled project |
| `POST /api/prs/:id/approve` | sessions | the PR, with its approval |
| `GET /api/prs/:id` | read | as today, plus `can_approve`; for an unlinked PR `auto_merge: 'off'`, no hands, `can_merge` and a `merge_note` |

The three route tables that tests check for completeness get the new routes: `ROUTE_ACCESS`,
`SESSION_ROUTES` (both new POSTs: `null`, they act on nobody's session) and `PROJECT_WRITES` (by
project key; a PR's project comes from its repo, so the existing PR routes also work without a
session).

The Inbox leaves unlinked PRs out.

## Screens

A new tab **PRs** on the project page, after Sessions (its label carries the open count when there
is one). On a phone:

```
 Backlog  Bugs  Sessions  PRs · 3  Sources  Settings
 ──────────────────────────────────────────────────
 OPEN PULL REQUESTS            synced 2 min ago  ↻
 ┌────────────────────────────────────────────────┐
 │ Bump vite from 7.1 to 7.2                    ● │
 │ app#41 · dependabot · 2 files                  │
 │ [No item]                                      │
 ├────────────────────────────────────────────────┤
 │ Sync open PRs of GitHub repos                ◐ │
 │ app#40 · octo · 14 files                       │
 │ [DISP-111] [Approved]                          │
 └────────────────────────────────────────────────┘
```

- One row per PR, a link to `/pr/:id`; the title wraps to two lines; the dot is the CI state
  (green, red, pulsing for pending, none when unknown).
- Chips: the linked items' keys, or "Session" for a session without items, or "No item"; "Draft";
  "Approved" (or "Approved earlier" when the head moved on).
- With several GitHub repos, the repo name is in the second line (as shown).
- Empty: "No open pull requests." A project with no GitHub repo: "This project has no GitHub
  repo." A sync error shows above the list.

The PR page for an unlinked PR: the same header, checks, description and files. Under the header a
line "Not linked to an item · opened by @author". The action box has **Approve** (with a confirm),
the approval's state in words, and, when it may merge, the merge method and **Merge**. Linked
GitHub PRs get the same Approve button above their existing merge controls.

## Tests

- Sync: opened (two PRs with no session appear, with author, base, CI state, changed files),
  updated (same row, new title and head; an unchanged PR costs no `pulls.get`), closed and merged
  (leave the list; the state is recorded).
- Linked: a session's PR is one row before and after a project sync and keeps its session; a PR the
  project sync stored first is adopted by the session sync (same id), and its items move then.
- Approve: stored and sent; own PR (422) answers 200 with `own_pr`; a refused token answers 200
  with `failed` and can be sent again; in a multi-user install the review is made with the
  caller's token, and a second person is still offered Approve.
- Local and hosted repos are not listed from GitHub.
- No agent work: resolve-conflicts is refused for an unlinked PR; an unlinked merge calls
  `pulls.merge`; a repo with a generate command refuses it.
- The migration keeps existing rows and their merge events (a database built to 039, then opened).
- Route tables complete; the Inbox has no unlinked PR.
- Rendered screens: the list (linked, unlinked, approved, draft) and the PR page (Approve, the
  own-PR note). A phone-size screenshot of both is checked by eye before the PR opens.

## Left to the builder

File layout, names of helpers, the exact words of the notes, and how the list groups rows.
