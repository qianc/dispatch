# Releases from the interface: design

Date: 2026-10-22 · Status: approved · Item: DISP-8

## Context
Today a release is only made by hand through the worker side: an agent or the owner writes the CHANGELOG entry, runs the repo's own release step (e.g. `./release.sh <v> --yes` in one repo, `tools/release.sh` in another), and then labels the items `rel:<v>` (the `release_items` MCP tool or `dispatch release`). Dispatch has no release model and no worker capabilities. Releases differ per worker (one repo's release needs a credential that only one machine has) and per project (a project can have two release lines, e.g. `rel:` in one repo and `convert:` in another).

Goal: on a project page the owner sees which worker can release which repo, reviews a proposed version, edits it if needed, and starts the release. The result shows in the app.

Owner decisions: (1) the release runs as a **Claude session of the new kind `release`** that follows the repo's own rules; (2) capabilities are **declared in the worker config**; (3) the proposed version starts from the **repo's latest tag** (then the VERSION file, then Dispatch labels).


## Design

### Worker capability
- `src/worker/config.ts`: `ServerEntry.releases: { repo, label_prefix, command|null, notes|null }[]`. It comes from the `releases` key of a `WORKER_CONFIG` server entry, or from the env var `RELEASES` (a JSON array) for the single-server setup. A `repo` is `owner/name`, a unique bare repo name, or a local path (`~` expanded).
- `WorkerFacts.releases?` is set in `ServerLink.facts()`. `WorkerHub.handle('hello')` fills in `releases: []` for old workers.
- **Trust:** the worker takes `command` and `notes` from its own config, never from the server. `refusal()` refuses a release spec that is not in its config.

### Matching and proposal (server)
- New `src/server/releases.ts`:
  - `matchesRepo`: matches `owner/name` (case-insensitive), a local path on the same worker, or a bare name that is unique in the project. Hosted repos never match in v1.
  - `releaseOptions(project)` gives `{worker_id, worker, repo_id, repo, label_prefix, command, notes}[]` for connected workers.
  - `labelReleased(...)` is moved out of `release_items` in `src/server/mcp.ts:230`, which then calls it.
- New `src/shared/release.ts` holds pure helpers shared with the web app: `VERSION_RE` (`v?X.Y.Z[-pre]`), compare/max, `bump` (keeps a leading `v`), `normalizeVersion` (adds `v` if the last version had one), `unreleased(items, prefix)` (the same rule as `release_items`), `highestLabelVersion`, and `proposeVersion`. `proposeVersion` bumps the minor version if any unreleased done item is type `backlog`, else the patch version. With no last version it gives `v0.1.0`.
- New WorkerCommand `release_version {repo}` returns the newest `git tag --merged <default>` version and `VERSION` at the default branch. Last version = the highest of tag, file and `<prefix>` label, so the app never proposes a version that is already used. The response says which source it came from.

### Endpoints (`src/server/routes/releases.ts`)
- `GET /api/projects/:key/releases` returns the capability options. It is cheap and decides whether the button shows.
- `GET /api/projects/:key/releases/proposal?worker_id&repo_id` returns `{last:{version,from}|null, proposed, bump, items, label_prefix, command, warning?}`. If the worker command fails, it falls back to labels and adds a warning.
- `POST /api/projects/:key/releases {worker_id, repo_id, version}` runs these checks:
  - The option exists and the worker is connected, else 400.
  - The version is valid, else 400.
  - The version is not already used, else 409.
  - There is at least one unreleased item, else 400.
  - No release of that repo is still running, else 409.

  Then it calls `sessions.startRelease`.

### Release session
- `'release'` is added to `SESSION_KINDS` (not to the chat kinds). Migration `016_release_sessions.sql` adds `sessions.release TEXT` (JSON `ReleaseInfo`: repo_id, cap_repo, version, label_prefix, command, notes, last_version). The store maps the column, and `StartSpec.release` carries it to the worker.
- `startRelease` places the session on the capability's worker directly (it skips `workerFor`), with `branch: null` and the unreleased items as `item_ids`. `reposOf` returns only the release repo.
  - **Guard:** never store `main` in `session.branch`, because the tidy code would delete it.
- Workspace `prepareRelease`:
  - **Local repo:** runs in the owner's checkout, where the credential and remotes are. It must be on the default branch with no uncommitted changes, else the start fails with a clear message.
  - **GitHub repo:** a cache worktree on `<default>` that tracks `origin/<default>`. An existing worktree is never reset.
- Context: the repo's CLAUDE.md/AGENTS.md plus `.dispatch.md`.
- `releasePrompt` (`src/worker/prompts.ts`) gives the agent:
  - **Inputs:** version, label, the configured command with `{version}` filled in (or "follow the repo's documented steps; else make an annotated tag and push it"), notes, and the unreleased items.
  - **Steps:** read the repo's release rules, check the checkout is clean, pick the items that belong to this repo, write and commit the changelog, then run the command.
  - **If a step fails:** stop, label nothing, and ask the owner.
  - **On success:** call `release_items` with the keys, then summarise.
  - **Limits:** never choose another version, no force-push, no other changes.
- New worker MCP tool and rpc `release_items {keys}`, for release sessions only:
  - Every key must be a done item in the project. The version and prefix come from the session.
  - It adds a system event to the session.
  - A release session gets only `list_items`, `get_item`, `view_image`, `add_comment` and `release_items`.
- Fake runner: a release turn emits a Bash tool_use for the command. A command that contains `fail` gives an error and no labels; otherwise it calls `release_items` and reports.

### Web
- `web/src/pages/Project.tsx`:
  - A "Release" header action appears only when the options list is not empty.
  - `<Sheet>` with a `ReleaseForm` that follows the `PlannerForm` pattern:
    - **Pick:** a picker `{repo} · {worker}` when there are several options.
    - **Shows:** the last version and its source, any warning, the unreleased items, and the label and command.
    - **Version:** an editable version field filled with the proposal, with a live label preview and client-side validation.
    - **Create:** goes to the new session.
- `Session.tsx` shows `release vX.Y.Z` in place of the branch. `web/src/api.ts` gets the `ReleaseOption` and `ReleaseProposal` types.
- README: a "Releases" section covering:
  - the config example (two release lines, and a local path with `--yes` and a credential note)
  - matching and the version rule
  - the clean-checkout precondition
  - that labels are added only after success
  - that hosted repos are not supported

### Known limits (v1)
- In shared projects (one project, several repos), the unreleased list for one prefix includes items from the other line. The agent picks per repo and labels by key, but the proposed bump can be too high. The owner can edit the version. A per-capability module filter can follow if needed.
- Hosted repos: the agent cannot push them.

