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

## Several workers

A server can have several workers, for example a Linux VM for most work and a Windows desktop
(in WSL) for work that needs its programs. Each session runs on one worker for its whole life.

- **Make a worker** in Settings → Workers. It gets its own token (`dsw_…`, shown once) and a
  description, such as "Windows desktop. Has PowerPoint. Often asleep." The worker that connects
  with the server's `WORKER_TOKEN` is the worker "default"; it keeps working as before.
- **Placement.** Each project has a default worker and a "Where work runs" text. The planner reads
  the worker descriptions and that text, and proposes a worker on its card; you can change it on
  the card and on the batch sheet. A project's local repos are on one worker, so its sessions run
  there.
- **Away or busy.** A session for a worker that is not connected waits (`Waiting for worker
  <name>`), with one push, and starts when the worker connects. A worker with no free slot gives
  `Waiting for worker <name> (busy)`. A reply to an idle session waits too. You can pause a waiting
  session, and move it to another worker (a started work session moves as a new session that
  continues from its pushed branch).
- **Logins stay on the worker.** Each worker uses its own Claude login and GitHub token. The
  server never sends credentials to a worker.

**A worker that serves several servers** (for example a home server and a work server) reads a
JSON file named by `WORKER_CONFIG`. The worker owns its slots (`max_concurrent`, over all
servers), and each server gets only the folders and accounts listed for it:

```json
{
  "max_concurrent": 3,
  "servers": [
    { "name": "home", "url": "wss://dispatch.example.com/worker", "token_file": "~/.config/dispatch/worker-home.token",
      "local_repo_dirs": ["~/projects"], "read_dirs": ["~/projects"] },
    { "name": "work", "url": "wss://dispatch.work.example/worker", "token_file": "~/.config/dispatch/worker-work.token",
      "local_repo_dirs": ["~/work"], "claude_accounts": ["work"], "github_accounts": ["work"] }
  ]
}
```

These lists stop a server from asking for the wrong folder or account. They do not keep the agents
of one server from reading the other server's files on the same machine: agents have full tool
access. Use separate machines (or users) when that matters. Without `WORKER_CONFIG`, the worker
uses `SERVER_WS_URL`, `WORKER_TOKEN`, `LOCAL_REPO_DIRS` and `ASSISTANT_READ_DIRS` as one server.

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

## Sign-in, tokens and Claude connectors

Dispatch needs no other infrastructure: by default you sign in with a password (`AUTH_MODE=password`,
`APP_PASSWORD` or `APP_PASSWORD_HASH`). `DISABLE_AUTH=1` turns sign-in off for local testing.

**Behind a sign-in proxy** (e.g. Traefik with an SSO forward-auth): set `AUTH_MODE=proxy`,
`TRUSTED_PROXIES` to the proxy's address(es) (IPs or IPv4 CIDRs) and optionally `AUTH_USERS` to the
users allowed in (`AUTH_HEADER`, default `Remote-User`, names the user). Set `PROXY_SECRET` too and have
the proxy add it to every request (header `X-Proxy-Secret`): everything else on the proxy's host has
its address, and the secret is what tells the proxy apart. A tunnel or proxy on Dispatch's own machine
makes every request look local (full token scopes, password login): do not run one there. Dispatch then believes the
header only from those addresses, refuses every other request that does not come from the machine
itself (so the port is no way around the proxy), and keeps the password login for that machine
only, as a way in when the proxy is down. When the proxy's session expires the app shows
"Signed out" and sends you through `/signin`, which the proxy guards.

**Scopes.** Every API route needs one: `read`, `tracker` (items, comments, sources, images),
`sessions` (start and steer agents, merge) or `admin` (projects, repos, settings). A signed-in person
has all of them.

**Tokens** for scripts and skills: Settings → Tokens. A token has a name, scopes (`tracker` by
default), an optional expiry and a last-used time, is shown once and stored only as a hash, and can
be revoked on its own. Used from another machine, a token only gets `read` and `tracker`
(`TOKEN_REMOTE_SCOPES`), so a leaked token cannot start agents from outside. Making tokens needs a
signed-in person; a token cannot make tokens.

**Claude connector (MCP).** `PUBLIC_URL/mcp` is an MCP server with the tracker tools (list, read,
add and edit items, comments, sources, images, release labels; nothing that starts agents). Add it
as a connector in Claude (claude.ai, the apps, Claude Code: `claude mcp add --transport http dispatch
https://dispatch.example.com/mcp`). Claude registers itself, you approve it once on a consent page
(signed in as above), and it renews its access by itself (24 h access, 60-day rotating refresh
tokens). Settings → Connected apps lists them and disconnects them.

Behind a proxy, route these paths **around** the proxy's sign-in, because the client is not a
browser: `/.well-known/*`, `/register`, `/token`, `/revoke` and `/mcp`; and, for tokens,
`/api/*` requests that carry `Authorization: Bearer dsp_…`; and `/worker` (the WebSocket that
workers on other machines connect to, with their worker token). Keep `/authorize` (the consent
page) and everything else **behind** it. Dispatch checks all of these itself.

## Tools for agents

Agents use the tools on the worker's PATH. Put extra tool folders first with `AGENT_EXTRA_PATH`
(e.g. `~/.local/go/bin` for a Go install). Under WSL the worker also adds Windows' own PATH, as
a Windows terminal does, so agents can run `powershell.exe` (and through it PowerPoint) and other
Windows tools; a worker started by systemd does not get that PATH otherwise. `WINDOWS_PATH=off`
turns it off. The worker logs what it added when it starts.

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

## Claude Code skill: keep the backlog in Dispatch

`skills/dispatch-backlog` lets Claude Code manage a repo's backlog and changelog in Dispatch rather
than in a markdown file. It reacts to backlog, bug and changelog requests ("file a bug", "what's
next", "write the release notes", item keys like HC-42), and works through a small script
(`scripts/dispatch.mjs`, no dependencies).

1. Install it for your user: `ln -s "$PWD/skills/dispatch-backlog" ~/.claude/skills/dispatch-backlog`
2. Token: copy the API token from Settings into `~/.config/dispatch/tokens/<host>`, with `:` as
   `_` (e.g. `tokens/localhost_3000`), `chmod 600`. One file per server.
   Dispatch is assumed on `http://localhost:3000`; a repo names another server with `url:` in its
   `.dispatch.md` (`DISPATCH_URL` overrides it for the whole machine).
3. In each repo, add `.dispatch.md` (start from `skills/dispatch-backlog/dispatch.example.md`): the
   project key in the frontmatter, then your rules for naming, tags, modules and the changelog.

Items can carry images (screenshots, rendered output): add them in the app (camera, photo
library, file, or paste on desktop) or with the script. `images:` in `.dispatch.md`
(`always`, `when_possible`, `off`) says how hard Claude tries to attach an example image that
shows the issue, and the text below it can say how to make one. Agents working on an item can
look at its images.

The changelog stays a file in the repo. Claude writes it from done items without a `rel:<version>`
label, then labels them, so the next entry starts where this one ended.

## Backups

`node src/server/backup.ts --data /data --out /backups --at 03:15 --keep 14` runs in the server
image (for example as a second service of the stack) and makes, once a night, an online copy of
the SQLite database (consistent while the server runs) and a tarball of the attachments. It keeps
14 days. `--once` makes one copy now. Restore: stop the server, put the `.db` copy in place as
`dispatch.db` (remove any `-wal`/`-shm` files next to it) and unpack the attachments.

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
