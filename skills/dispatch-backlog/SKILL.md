---
name: dispatch-backlog
description: Use for any backlog, bug or changelog work, including screenshots or images that show an issue, in a project tracked in Dispatch. Triggers include "add to the backlog", "file a bug", "log an issue", "what's on the backlog", "what's next", "close/finish/park an item", "mark as done", "tag these", "write the changelog", "release notes", "what changed since", or a retro to split into items. Also use when an item key like HC-42 is mentioned. The repo has a .dispatch.md, or the user names a Dispatch project. Dispatch replaces backlog.md files; changelogs stay in the repo but are written from Dispatch items.
---

# Dispatch backlog

Dispatch is the user's tracker: projects, backlog items and bugs, retros ("sources"), and Claude
sessions. In repos that use it, the backlog lives in Dispatch, **not** in a markdown file. Read and
change it with the script in this skill. Never call the API by hand, and never write the API token
into a file in a repo, a commit or a message.

```bash
node <this skill's folder>/scripts/dispatch.mjs <command> ...
```

Below, `dispatch` means that command.

**If the Dispatch MCP connector is connected** (tools such as `list_items`, `get_item`, `add_item`,
`update_item`, `add_comment`, `add_source`, `release_items`), use those tools instead of the script:
same rules, no token needed. The project's conventions are still in `.dispatch.md`; read the file.

## 1. Start with the project's settings

Run `dispatch config` first, once per conversation. It shows:

- the server, and where that address came from (it also names a `url:` in `.dispatch.md` that
  something else overrides)
- whether the server takes the token: `valid`, `rejected` (with the reason) or `missing`
- the project key (from `.dispatch.md` in the repo, searched upwards from the current folder)
- the project's **conventions**: the text in `.dispatch.md`. Follow them exactly. They say how to
  name items, which tags and modules to use, and how to write the changelog.

If something is missing:

| Problem | What to do |
|---|---|
| No `.dispatch.md`, but a `backlog.md` or similar | Ask the user if this repo should use Dispatch. Do not move a backlog on your own. If yes, set it up as in 1a. Existing markdown backlogs are best imported in the Dispatch app: ask its Assistant to import the file. |
| No `.dispatch.md` and no backlog, and the user asks to set the repo up | Follow 1a. |
| No token | Each server has its own token file, named after its host: `~/.config/dispatch/tokens/<host>` (`:` written as `_`, e.g. `localhost_3000`). `dispatch config` shows the exact path. Tell the user to make a token in Dispatch → Settings → Tokens (scope `tracker` is enough) and save it there (`chmod 600`). Do not ask them to paste it in the chat. |
| `token: rejected`, "not signed in", or "redirected to …" | Tokens are per server, see 1b. |
| "This needs the … scope" | The token may not do that. Tracker work needs `tracker`; tokens used from another machine never get more than `read` and `tracker`. |
| Cannot reach the server | See the server order below. Ask the user which address to use. |

**Which server.** The first of these that is set wins:

1. `--url URL` on the command line
2. `DISPATCH_URL`: an override for one shell or one run
3. `url:` in the repo's `.dispatch.md`
4. `~/.config/dispatch/default-url`: this machine's default server
5. `http://localhost:3000`

`dispatch config` says which one won. When `DISPATCH_URL` beats a different `url:` in
`.dispatch.md`, it says so: `server: http://… (from DISPATCH_URL, overrides url: https://… in
.dispatch.md)`. If that is not what the user wants, unset `DISPATCH_URL`. Use `default-url`, not
`DISPATCH_URL`, for a machine's usual server.

### 1a. Setting up a new repo

1. **Check the server**: `dispatch config`. The server must answer and the token must be `valid`
   (if not, see the table above and 1b).
2. **List the projects**: `dispatch projects`. Find this repo's project. Do not guess the key.
   **This script cannot create projects.** If there is none for the repo, ask the user to make one
   in the Dispatch app, then go on.
3. **Read the sibling repos' files for house style**: `ls ../*/.dispatch.md`, and read them. They
   show how this user names modules and tags, what images to ask for, and how changelogs look. Copy
   that style where it fits.
4. **Write the file**: `dispatch init --project KEY` (add `--url URL` only if the repo must name
   its server). Without `--project`, `init` lists the projects and suggests the one that matches
   the folder name, but writes nothing. It writes `.dispatch.md` at the repo root from
   `dispatch.example.md`, never overwrites one, and prints what is still to do: a missing token,
   no `CHANGELOG.md`, the sibling files, and the example conventions to rewrite.
5. Rewrite the conventions (the text after the frontmatter) for this repo, from what you read in
   step 3 and in the repo. Show the user the result.

### 1b. Tokens are per server

A token works only on the server that made it. A token from the LAN address (e.g.
`dispatch.home.example`) is refused by the public address (e.g. `dispatch.example.com`), even when
both are the same Dispatch install. So each server address has its own token file,
`~/.config/dispatch/tokens/<host>`.

When a token is refused (`token: rejected`, "not signed in", or "redirected to …"):

1. Run `dispatch config` and check the server. Is it the address the user means? A wrong
   `DISPATCH_URL` or `url:` is the usual cause.
2. If the address is right, the token for it is missing or old. Tell the user to make a token on
   that server (Settings → Tokens, scope `tracker`) and save it in the file `config` names. Do not
   copy a token from another server's file.
3. "redirected to auth.…" means a sign-in proxy answered, not Dispatch. The token is not valid for
   that host, or the host does not let tokens through. Use the address the token was made on, often
   the LAN one.

`dispatch scales` shows the project's importance labels (4 levels) and effort labels. Use those
labels in `--importance` and `--effort`.

## 2. Reading

- `dispatch list`: open items. Add `--type bug`, `--tag ux`, `--module charts`, `--q "words"`,
  `--status hold,done`, `--all`, or `--json`.
- `dispatch show HC-42`: one item in full, with its comments and agent sessions.
- `dispatch facets`: tags and modules already in use, with counts.
- `dispatch images HC-42`: downloads the item's images and prints their paths. Read those files to
  look at them. Do this whenever `show` lists images: they often show the problem better than the text.

When the user asks "what's next", list the open items and recommend a few, with reasons. Put
importance first, then items that unblock others, then small quick wins.

## 3. Adding items

1. **Look for duplicates first**: `dispatch list --all --q "key words"`. If one exists, update it
   or comment on it.
2. **Reuse vocabulary**: `dispatch facets`. Use existing tags and modules. Add a new one only when
   none fits, and follow the conventions.
3. Add the item:
   ```bash
   dispatch add --type bug --title "Chart legend overlaps the axis" \
     --importance High --effort S --modules charts --tags layout \
     --body-file /tmp/item.md
   ```
   - Title: short, says what is wrong or what to make. No key and no ending full stop.
   - Body (markdown): the context, what you saw or what is wanted, and how to know it is done.
     Name files with repo paths (`src/chart/legend.ts`). Use `--body-file` for anything longer
     than one line.
   - Default status is `backlog` (bugs: `triage` is fine too).
4. Attach images that show it (see 3a), with `--images` or `dispatch attach`.
5. Report the new keys to the user.

### 3a. Example images

A picture of the problem is often the fastest way for a person, or the agent that picks the item
up, to see it. The `images:` setting in `.dispatch.md` (shown by `dispatch config`) says how hard
to try:

| `images:` | What to do |
|---|---|
| `always` | Every new bug and every item about visible output gets at least one image. If you cannot make one, say so to the user. |
| `when_possible` (default) | Attach one whenever you have it or can make it cheaply. Do not stop work to make one. |
| `off` | Do not attach images unless the user asks. |

Good images: a screenshot or rendered output that shows the defect, a before/after pair, or the
expected result next to the actual one. Crop to the part that matters. Make them with the
project's own tools when it has them (its conventions may say how, e.g. a preview renderer).
Name files so the name says what they show (`legend-overlaps-axis.png`). Mention in the
description what each image shows.

Never attach an image that holds secrets, personal data, or content the conventions say to keep
out (e.g. client material). Only PNG, JPEG, GIF and WebP are accepted.

```bash
dispatch add --type bug --title "..." --images /tmp/legend-overlap.png,/tmp/expected.png ...
dispatch attach HC-42 /tmp/after-fix.png
dispatch comment HC-42 "Fixed; this is the output now" --images /tmp/after.png
```

**Retro or report with several findings:** keep the full text as a source, then link each item to it:
```bash
dispatch source add --kind retro --title "Slideshow run retro" --reporter alex --version v6.4.1 --body-file /tmp/retro.md   # prints the id
dispatch add --source 12 --title "..." ...
```

## 4. Changing items

- `dispatch update HC-42 --importance Critical --add-tags regression --body-file /tmp/new.md`
- `dispatch status done HC-42 HC-43`. Statuses: `triage, backlog, todo, in_progress, in_review,
  hold, done, canceled`. Use `hold` for parked work and `canceled` for "won't do".
- `dispatch comment HC-42 "Found the cause: ..."`: notes, findings and decisions. Comments are
  signed "claude". Add `--images` to show what you found, or the result after a fix.

Rules:
- Items `in_progress` or `in_review` belong to a running agent session. Do not change their status
  unless the user asks.
- When you finish work on an item in this conversation, set it to `done` and add a one-line comment
  on what changed (commit or PR if there is one). Put the item key in the commit message.
- Never delete items. Cancel them, with a comment saying why.
- `--body` and `--body-file` replace the whole description. Read it with `show` first and keep what
  is still true.

## 5. Changelog and releases

The changelog stays a file in the repo (path and style in the conventions). Dispatch gives the
content: done items that are not in a release yet.

1. `dispatch unreleased`: done items without a release label.
2. Write the entry in the changelog file, as the conventions say (default: a `## <version> — <date>`
   heading, then grouped lines: Added / Changed / Fixed, one per item, ending with its key).
   Write for the people who use the project, not about the code.
3. After the user agrees to the entry: `dispatch release v1.4.0 --unreleased` (or list the keys).
   This adds the release label (default `rel:v1.4.0`), so the next changelog starts after it.

**No `CHANGELOG.md`.** Some repos have no changelog file and publish releases with GitHub's
generated release notes (this is in their conventions, or `changelog:` is missing). Then skip
step 2: do not create a `CHANGELOG.md`. To see what a past release held, read its notes with
`gh release view v1.3.0` (or `gh release list`). Still do step 3 when a release is made, so
`unreleased` stays correct. If the user wants written notes, give them the text to paste into the
GitHub release.

"What changed since v1.3?" → `dispatch list --status done --tag rel:v1.3.0`, or
`dispatch unreleased` for the work since the last release.

## Mistakes to avoid

- Writing items into `backlog.md` or a TODO file in a repo that has `.dispatch.md`.
- Inventing tags (`perf` when the project uses `performance`).
- Creating a duplicate instead of updating the existing item.
- Putting a token anywhere except `~/.config/dispatch/tokens/` or the environment.
