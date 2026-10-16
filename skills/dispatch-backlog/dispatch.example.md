---
project: HC
# url: https://dispatch.example.com   # only if Dispatch is not on this machine's port 3000;
#                                     # its token goes in ~/.config/dispatch/tokens/dispatch.example.com
changelog: CHANGELOG.md
release_label_prefix: "rel:"
---

How Claude keeps this project's backlog and changelog in Dispatch. Copy this file to the repo root
as `.dispatch.md` and change the rules below. Everything after the frontmatter is read as
instructions.

## Items

- Titles: short and plain. Bugs say what is wrong ("Legend overlaps the axis"); backlog items say
  what to make ("Export charts as SVG").
- Modules (the part of the product): `charts`, `export`, `import`, `settings`.
- Tags: `ux`, `performance`, `regression`, `quick-win`, `docs`. No new tags without asking.
- Importance: Critical = blocks users or loses data; High = this release; Medium = soon; Low = some day.
- Effort: XS < 1 h, S ≈ half a day, M ≈ 1–2 days, L ≈ a week, XL = split it first.

## Changelog

- File: `CHANGELOG.md`, newest first.
- Heading: `## v1.4.0 — 2026-10-16`.
- Groups: **Added**, **Changed**, **Fixed**. One line per item, user's point of view, item key in
  brackets at the end: `- Charts can be exported as SVG (HC-42)`.
- Leave out internal items tagged `chore`.
