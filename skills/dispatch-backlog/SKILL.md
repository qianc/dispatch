---
name: dispatch-backlog
description: Use for any backlog, bug or changelog work in a project tracked in Dispatch. Triggers include "add to the backlog", "file a bug", "log an issue", "what's on the backlog", "what's next", "close/finish/park an item", "mark as done", "tag these", "write the changelog", "release notes", "what changed since", or a retro to split into items. Also use when an item key like HC-42 is mentioned. The repo has a .dispatch.md, or the user names a Dispatch project. Dispatch replaces backlog.md files; changelogs stay in the repo but are written from Dispatch items.
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

## 1. Start with the project's settings

Run `dispatch config` first, once per conversation. It shows:

- the server and whether a token is set
- the project key (from `.dispatch.md` in the repo, searched upwards from the current folder)
- the project's **conventions**: the text in `.dispatch.md`. Follow them exactly. They say how to
  name items, which tags and modules to use, and how to write the changelog.

If something is missing:

| Problem | What to do |
|---|---|
| No `.dispatch.md`, but a `backlog.md` or similar | Ask the user if this repo should use Dispatch. Do not move a backlog on your own. If yes, offer to add `.dispatch.md` from `dispatch.example.md` in this skill. Existing markdown backlogs are best imported in the Dispatch app: ask its Assistant to import the file. |
| No token | Tell the user to copy the API token from Dispatch → Settings into `~/.config/dispatch/token` (`chmod 600`). Do not ask them to paste it in the chat. |
| Cannot reach the server | Dispatch runs at `http://localhost:3000` by default. Ask the user, or use `DISPATCH_URL`. |

`dispatch scales` shows the project's importance labels (4 levels) and effort labels. Use those
labels in `--importance` and `--effort`.

## 2. Reading

- `dispatch list`: open items. Add `--type bug`, `--tag ux`, `--module charts`, `--q "words"`,
  `--status hold,done`, `--all`, or `--json`.
- `dispatch show HC-42`: one item in full, with its comments and agent sessions.
- `dispatch facets`: tags and modules already in use, with counts.

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
4. Report the new keys to the user.

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
  signed "claude".

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

"What changed since v1.3?" → `dispatch list --status done --tag rel:v1.3.0`, or
`dispatch unreleased` for the work since the last release.

## Mistakes to avoid

- Writing items into `backlog.md` or a TODO file in a repo that has `.dispatch.md`.
- Inventing tags (`perf` when the project uses `performance`).
- Creating a duplicate instead of updating the existing item.
- Putting the token anywhere except `~/.config/dispatch/token` or the environment.
