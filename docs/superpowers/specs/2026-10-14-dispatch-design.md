# Dispatch — a personal Linear-like tracker that runs Claude Code agents

(Working name "Dispatch", new repo `~/projects/dispatch` on GitHub. Rename freely.)

## Context

You want one mobile-friendly place to track all your software projects (each with one or more
repos, a backlog and bug reports) **and** to put Claude Code to work on them: mark backlog items,
or chat with a planner that proposes the next batch, then start a session that does the work and
opens a PR. You want to watch agent work across all projects and get a PWA push whenever an agent
needs you. Target: an Azure VM later; **v1 runs locally in Docker** for testing.

**What you said:**
- Projects → 1+ repos; each project has a backlog and bugs/issues.
- Start an agent on marked items, or chat → suggested next batch → start it in a new session.
- **Batch = one session = one branch = one PR** (per changed repo).
- Result: branch + PR on GitHub. From the app you can also **merge**: via the GitHub API, or merge
  locally and push the result.
- Sessions behave like **normal Claude Code with superpowers** — Claude chooses the path
  (none / bounded / architectural); "force a plan" is a prompt option.
- Mobile-first PWA, push notices when input is needed, cross-project view of running work.
- Uses your Claude subscription login. A fresh build. TypeScript end to end.

**What I assumed (correct me):**
- Single user (you). Simple password login for v1.
- GitHub only. One fine-grained GitHub PAT, in `.env`.
- Agents run with full tool access inside an isolated worker container (no per-tool approval
  prompts). The only "needs input" events are Claude's own questions (AskUserQuestion), plan
  approval (ExitPlanMode), a turn ending while waiting for you, and PR ready / run failed.
- No GitHub webhooks in v1 (local box isn't reachable); poll GitHub for PR state.

**Subscription-auth note:** the Agent SDK docs say Anthropic does not allow *third-party
products* to offer claude.ai login. This is a personal single-user tool driven by your own
`claude setup-token` token, and the SDK runs the actual Claude Code binary. The worker reads
`CLAUDE_CODE_OAUTH_TOKEN`; setting `ANTHROPIC_API_KEY` instead switches to API billing with no
code change.

## Architecture

```
docker compose
├── server   Fastify API + serves PWA + SSE stream + web-push + GitHub client + SQLite (volume: /data)
├── worker   Runs Claude sessions via @anthropic-ai/claude-agent-sdk; owns git clones/worktrees
│            (volume: /workspaces, /home/agent/.claude). Has claude CLI, gh, git, node, python.
└── (later on Azure: caddy for TLS)
```

- **server** is the source of truth (DB, auth, push, GitHub merges/status). It holds no Claude token.
- **worker** connects to server over an internal WebSocket: receives `start / send / interrupt /
  resume` commands, streams SDK messages back. Agents can't reach the DB or VAPID keys.
- Worker runs up to `MAX_CONCURRENT_SESSIONS` (default 3) sessions as SDK `query()` calls with
  streaming input. Per-session containers are a later upgrade if isolation needs it.

### Monorepo layout (pnpm workspaces)
```
apps/server   Fastify, Drizzle + better-sqlite3, web-push, @octokit/rest, zod
apps/worker   Agent SDK runner, git workspace manager, in-process MCP tools
apps/web      React + Vite + Tailwind + TanStack Query + vite-plugin-pwa (injectManifest SW)
packages/shared  zod schemas + types for API and server↔worker protocol
docker/       Dockerfiles (server, worker), compose.yml, .env.example
```

## Data model (SQLite via Drizzle)

- `projects` (id, key e.g. "HC", name, description, default_force_plan,
  `importance_scale` json — exactly 4 labels, default `["Low","Medium","High","Critical"]`,
  `effort_scale` json — ordered labels, default t-shirt `["XS","S","M","L","XL"]`)
- `repos` (id, project_id, github_owner, github_name, default_branch, check_command?)
- `sources` (id, project_id, kind: manual|retro|skill_run|user_report|agent_session, title,
  body_md (the full retro / report text, kept as written), reporter (user name/email),
  version_tag (e.g. app/skill version the finding was against), skill_name?, session_id?,
  created) — one source → many items
- `items` (id, project_id, number → "HC-42", type: backlog|bug, title, body_md, status:
  triage|backlog|todo|in_progress|in_review|done|canceled, importance 1–4 (labels from project
  scale), effort index into project effort scale (nullable), source_id?, labels json,
  marked bool, sort_order, created/updated)

**Sources / retros:** capture a retro in the app (paste) or via `POST /api/projects/:key/sources`
(so a skill run can submit its own retro, with reporter + version tag). The source page shows
the retro text and all items split from it. **Split into items:** manually, or a one-shot
"split" planner session that reads the retro and calls `propose_items` → editable card →
create items linked to the source. Item detail links back to its source, reporter and version.
- `sessions` (id, project_id, kind: work|planner, title, status, force_plan, branch,
  sdk_session_id, initial_prompt, waiting_reason?, cost/usage json, created/updated/ended)
  - status: queued → running ⇄ waiting_input → idle → completed | failed | stopped
- `session_items` (session_id, item_id)
- `session_events` (id, session_id, seq, type, payload json) — the transcript
- `pending_inputs` (id, session_id, kind: question|plan_approval, payload, answered_at, answer)
- `pull_requests` (id, session_id, repo_id, number, url, state, mergeable, head_sha, last_synced)
- `push_subscriptions` (endpoint, keys, user_agent)

## Session runtime (worker)

1. **Workspace:** per repo a cached clone at `/workspaces/cache/<owner>/<repo>`; per session
   `/workspaces/sessions/<id>/<repo>` = `git worktree` on branch `dispatch/<project-key>-<id>-<slug>`
   for every repo in the project. Session `cwd` = the session dir (or the repo dir if only one repo).
2. **SDK call:** `query({ prompt: asyncInputQueue, options: { cwd, settingSources: ['user','project'],
   plugins: [superpowers path], canUseTool, mcpServers: { dispatch }, appendSystemPrompt,
   resume?: sdk_session_id } })`.
   - superpowers is installed into the worker's `~/.claude` at image build (pinned version).
   - `canUseTool`: allow everything, **except** `AskUserQuestion` and `ExitPlanMode` → create a
     `pending_inputs` row, set status `waiting_input`, push notify, and block until you answer in the
     app; return the answer as the tool result.
   - `appendSystemPrompt`: the items (HC-42 title + body), the branch name, "commit as you go; when
     done push the branch and open a PR with `gh pr create`, referencing the item keys". If
     `force_plan`: "Use the architectural path: write a spec and plan and get approval before code."
3. **Turn end:** SDK `result` message → status `idle` + push "HC: waiting for you". Your reply in the
   app is pushed into the input queue and the session continues. "Mark complete" ends it.
4. **Interrupt / stop:** `query.interrupt()`; stop cleans the worktree only after the PR is merged
   or you discard.
5. **Restart safety:** on worker boot, sessions in running/waiting are resumed with `resume:
   sdk_session_id` (~/.claude is on a volume).
6. **In-process MCP server `dispatch`** (createSdkMcpServer): `get_item`, `list_items`,
   `add_item_comment`, `create_item` (agent can file follow-up bugs/backlog it finds).

## Planner chat (per project)

- A `planner` session: same runtime, `cwd` = read-only checkout of the project's default branches,
  `allowedTools` limited to Read/Grep/Glob/WebSearch + dispatch MCP read tools + `propose_batch`.
- `propose_batch({ title, item_ids[], new_items[], prompt, force_plan })` renders a **batch card**
  in the chat. You toggle items, edit the prompt, tap **Start** → server creates new items if any,
  creates one `work` session with them, marks items `in_progress`.
- Same entry from the backlog: select / mark items → **Start batch** → same card, no planner needed.

## Git & GitHub (server)

- PR linking: poll every 2 min (and on demand) — `GET /repos/{o}/{r}/pulls?head=owner:branch`.
  PR opened → session items `in_review` + push "PR ready". PR merged → items `done`.
- **Review on phone:** PR view in the app with files list + per-file unified diff (from
  `pulls/{n}/files`), checks status, mergeable state.
- **Merge, option A (GitHub):** `PUT /pulls/{n}/merge` with squash|merge|rebase.
- **Merge, option B (local):** worker command — fetch, merge PR branch into default branch in a temp
  worktree, run the repo's `check_command` if set, push default branch, PR is closed as merged by
  GitHub automatically. On conflict: abort and offer **"Start session to resolve conflicts"**
  (new work session on the same branch).
- If no PR was opened by the agent: **Create PR** button (server pushes nothing; worker pushes branch,
  server opens PR via Octokit).

## PWA & notifications

- Tabs (bottom bar): **Inbox** (waiting-on-you across all projects, newest first), **Projects**
  (backlog / bugs / sessions per project), **Activity** (all running sessions across projects, live
  status + last line), **Settings**.
- Session screen: transcript (assistant text as markdown, tool calls collapsed to one line with
  expand), question cards with option buttons + free text, plan approval card (approve / reply),
  reply box, Interrupt / Stop / Mark complete, linked PRs.
- Live updates via SSE (`/api/stream`), TanStack Query cache updates from events.
- Push via `web-push` + VAPID keys in `.env`; service worker shows notice and deep-links to the
  session. Triggers: waiting_input, idle (turn ended), PR ready, failed. Per-project mute.
- iOS: push only works for an installed home-screen PWA over HTTPS. Desktop `localhost` works
  as-is; for phone testing locally use Tailscale `serve` or a cloudflared quick tunnel.
- Build to the iOS PWA rules (fixed body, single scroll container, safe-area insets, `100dvh`)
  — written from scratch, not copied.

## Auth & config

- `.env`: `APP_PASSWORD_HASH` (argon2), `SESSION_SECRET`, `CLAUDE_CODE_OAUTH_TOKEN` (worker only),
  `GITHUB_TOKEN` (fine-grained: contents rw, pull requests rw, on chosen repos), `VAPID_*`,
  `GIT_AUTHOR_NAME/EMAIL`, `MAX_CONCURRENT_SESSIONS`.
- Login → httpOnly cookie. Worker↔server channel uses a shared `WORKER_TOKEN`.
- Secrets live in `.env` locally (gitignored), with master copies in a password manager.

## Build order (milestones)

0. **Spike (throwaway, ~1 h):** in the worker image, prove: OAuth token works with the SDK;
   superpowers loads; AskUserQuestion/ExitPlanMode arrive in `canUseTool` and the answer flows
   back; streaming input gives multi-turn; `resume` works after a container restart. Adjust the
   runtime design if any of these fail before building on it.
1. **Skeleton:** monorepo, compose, Dockerfiles, auth, DB + migrations, CRUD for projects / repos /
   items, mobile UI for projects, backlog, bugs, item detail.
2. **Sessions:** worker protocol, workspace manager, run/stream/reply/interrupt/resume,
   session screen, Activity tab, start batch from marked items.
3. **Notifications:** VAPID, subscribe flow, SW, Inbox tab, push triggers.
4. **GitHub:** PR linking/polling, PR + diff view, merge via API, local merge + conflict session,
   item status sync.
5. **Planner chat:** planner session kind, `propose_batch` card, start-from-card.
6. **Polish:** cost/usage per session, per-project mute, README with Azure VM notes.

## Verification

- **Unit (vitest):** session state machine, item status transitions, GitHub poller (mocked Octokit),
  worktree manager (against temp git repos), server↔worker protocol schemas.
- **Fake runner:** worker flag `RUNNER=fake` replays scripted SDK message streams (question, plan
  approval, PR open) — drives UI and e2e without spending subscription usage.
- **E2E (Playwright, iPhone viewport, uses /opt/pw-browsers chromium):** create project → add items →
  mark → start batch → answer question card → see PR card → merge (mocked GitHub).
- **Real smoke test:** `docker compose up`, a scratch GitHub repo, one small backlog item → confirm
  question push arrives on phone (via tunnel), PR opens, merge from the app (both A and B), item
  becomes Done.

## Out of scope for v1

Azure VM provisioning/TLS, GitHub webhooks, multi-user, per-session containers,
Linear import.

## Decisions made during the build

- **Spike result (2026-10-14):** subscription OAuth works through the SDK (`apiKeySource: none`);
  superpowers loads as a local plugin; `AskUserQuestion` reaches `canUseTool` and the answer is
  returned via `updatedInput.answers` (question → answer); streaming input gives multi-turn;
  `resume` restores context. Not yet verified: `CLAUDE_CODE_OAUTH_TOKEN` inside the container.
- **No ORM, no native modules:** Node 24 built-in `node:sqlite` + plain SQL migrations, and Node's
  native TypeScript type stripping (no build step for server/worker). Password hashing uses
  `node:crypto` scrypt. One root `package.json`; the web app lives in `web/` and is built by Vite.
- **Idle sessions** keep their Claude process for `IDLE_CLOSE_MINUTES` (default 10), then close it;
  the next message resumes with `resume: sdk_session_id`. Only `running` and `waiting_input`
  sessions count against `MAX_CONCURRENT_SESSIONS`.
- **VAPID keys and the session secret** are generated on first start and stored in the DB
  `settings` table unless set in `.env`. An API token (Settings page) allows `Bearer` access for
  skills that post retros.
- **Superpowers in the container** is cloned at a pinned tag into `/opt/plugins/superpowers` and
  passed via `AGENT_PLUGIN_DIRS`.
