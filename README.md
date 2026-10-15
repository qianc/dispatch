# Dispatch

A personal, Linear-style tracker for your projects that also runs **Claude Code** on them.

- Projects → one or more GitHub repos → backlog items and bugs, with per-project **importance**
  (4 levels) and **effort** (t-shirt by default) scales.
- **Sources**: capture a retro, skill-run report or user report (reporter + version tag), and split
  it into linked items, by hand or with Claude.
- Mark items and **start a batch**: one Claude Code session (with superpowers) works on one branch
  and opens one PR per changed repo.
- Or open a **planning chat**: Claude reads the code and the tracker and proposes the next batch as
  a card you edit and start.
- Sessions are normal multi-turn Claude Code. Claude's questions and plan approvals show up as
  cards, with a **push notification** to your phone. **Activity** shows all running work across
  projects.
- Review the PR diff on your phone and **merge** on GitHub, or merge locally on the worker and push.
- An **Assistant** tab (Haiku by default) that runs the tracker for you: "new project Decks for
  github.com/me/decks", "read ~/projects/notes/retro.md and file the issues under Decks". It changes
  projects, repos, items and sources at once. To start agent work it shows a card you confirm. It
  can read files only in `ASSISTANT_READ_DIRS` and cannot edit files or run commands.
- **Discuss this** on any item: a read-only Haiku chat (`DISCUSS_MODEL`) that knows the item and the
  repo's `CLAUDE.md`, and can read the code in the project's repos (or the folder an imported source
  came from). It never changes anything; starting work stays on the item page.
- **Local repos** (no GitHub): add a project repo as a folder path (inside `LOCAL_REPO_DIRS`).
  Agents push their branches into that folder; Dispatch shows the branch for review (diff on the
  phone) and merges it by pushing the default branch back (the folder's working tree must be clean;
  set `receive.denyCurrentBranch updateInstead` there if the branch is checked out).
- **Accounts**: several GitHub accounts (a project picks one; its repos and commits use it) and several
  Claude accounts (a project has a default and an allowed list; a batch can pick another allowed one; a
  session keeps its account). SSO accounts log in once with `CLAUDE_CONFIG_DIR=… claude`. The Assistant
  has its own account setting. Secrets stay in env; see `.env.example`.
- Links in item text open in the app: repo files (markdown rendered, images shown), and `#anchor`
  links to other items imported from the same backlog.

Design spec: [`docs/superpowers/specs/2026-10-14-dispatch-design.md`](docs/superpowers/specs/2026-10-14-dispatch-design.md).

## Architecture

```
server  (Fastify, node:sqlite, web-push, Octokit)  — API, PWA, SSE live updates, GitHub sync/merge
  ⇅ internal WebSocket (WORKER_TOKEN)
worker  (Claude Agent SDK, git, gh)                — Claude sessions, git worktrees, local merges
web/    (React, Vite, Tailwind, vite-plugin-pwa)    — mobile-first PWA, built into dist/web
```

The server holds no Claude credentials. The worker runs agents with full tool access inside its
container, routes `AskUserQuestion` / `ExitPlanMode` to you, and keeps each session in its own
worktree under `/workspaces/sessions/<id>`.

## Run with Docker (local test)

```bash
cp .env.example .env      # fill in WORKER_TOKEN, APP_PASSWORD, GITHUB_TOKEN, CLAUDE_CODE_OAUTH_TOKEN
docker compose up --build
open http://localhost:3000
```

- **Claude subscription:** run `claude setup-token` on your own machine and put the token in
  `CLAUDE_CODE_OAUTH_TOKEN`. To bill the API instead, leave it empty and set `ANTHROPIC_API_KEY`.
- **GitHub:** a fine-grained PAT with *Contents* (read/write), *Pull requests* (read/write) and
  *Checks* (read) on the repos you add.
- **Try it without Claude usage:** set `RUNNER=fake`. The worker then plays a scripted session
  (plan approval, a question, a finished turn, planner proposals).

## Run without Docker (development)

Node 24+ (runs TypeScript directly, no build step for server/worker).

```bash
npm install
npm run build                      # PWA → dist/web (or use npm run dev:web on :5173)
APP_PASSWORD=dev WORKER_TOKEN=dev npm run dev:server
WORKER_TOKEN=dev RUNNER=fake npm run dev:worker
```

Without `RUNNER=fake` the worker uses your local Claude Code login. Set
`AGENT_PLUGIN_DIRS=~/.claude/plugins/cache/claude-plugins-official/superpowers/<version>` to load
superpowers, and `AGENT_SETTING_SOURCES=project` if you don't want your personal `~/.claude`
settings in agent sessions.

## Phone and push notifications

Push needs HTTPS, and on iPhone the app must be added to the home screen (Share → Add to Home
Screen) and opened from there. For local testing, expose the server over HTTPS, e.g.
`tailscale serve 3000` or `cloudflared tunnel --url http://localhost:3000`, set `PUBLIC_URL` to
that address, then turn on notifications in **Settings**. VAPID keys are generated on first start
and kept in the database.

You get a push when Claude asks a question, needs a plan approved, finishes a turn, proposes a
batch, opens a PR, or fails. Mute per project in project settings.

## Posting retros from skills or scripts

```bash
curl -X POST "$DISPATCH/api/projects/HC/sources" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"skill_run","title":"Slideshow run retro","reporter":"alex","version_tag":"v6.4.1",
       "skill_name":"deck-builder","body_md":"…full retro…",
       "items":[{"type":"bug","title":"Fonts wrong in Edge","importance":3,"effort":1}]}'
```

The API token is on the Settings page. `items` is optional; you can split later in the app.

## Tests

```bash
npm test                      # vitest: API, session flow with fake worker, git workspaces
npm run e2e                   # Playwright, iPhone viewport, against dist/web + fake worker
npm run typecheck
```

Set `CHROMIUM_PATH` if Playwright's own browser isn't installed.

## Going to Azure later

The same `compose.yml` runs on a VM. Put a TLS proxy (e.g. Caddy) in front of `server:3000`, set
`PUBLIC_URL` to the https address, and use `APP_PASSWORD_HASH`
(`node src/server/hash-password.ts '<password>'`) instead of a plain password.
