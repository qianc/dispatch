# Cost and time view (DISP-16)

Status: approved by the owner on 2026-11-15, and built.

## Why

Dispatch records a cost for every session (`sessions.usage.cost_usd`, a running USD total) and a
`duration_ms` on every turn result (`session_events`, kind `result`), but showed them only on a
single session's page. The owner could not see where the money goes or which kinds of items run
long. This view adds read-only totals per project and per item, groupable by item type and tag.
Nothing changes in how usage is recorded.

## What the data looks like

- A "batch" is a `sessions` row of kind `work`; its items are in `session_items`.
- One item can have several sessions (work, retry, moved to another worker, discuss, release).
- `planner` sessions have a project but no items. `assistant` and `orchestrator` sessions have no
  project and no items. An orchestrator's child sessions are normal `work` sessions with a project.
- Tags are `items.labels`, a JSON array. Item type is `backlog` or `bug`.
- A turn's `duration_ms` is that turn's own time (checked on recorded sessions), not a running
  total as the cost is.

## Rules

1. **Split rule: equal shares.** A session with N items gives each item 1/N of its cost and 1/N of
   its run time. N is the number of items linked now (an item added mid-run shares equally). Every
   session linked to an item counts: work, retries, failed runs, discuss, release.
2. **Project totals are unsplit.** A project's total is the plain sum over its sessions, so
   `project total = sum of item shares + "Not tied to an item"` always holds.
3. **Sessions with no items** are one line in the project: "Not tied to an item".
4. **Sessions with no project** are one line in the all-projects view: "Not tied to a project".
5. **Run time is agent working time**: the sum of the turn `duration_ms` values. Wall-clock time
   would count queue time and time waiting for the owner, and would mislead on which kinds of work
   run long.
6. **By type**, the lines add up to the item shares. **By tag**, an item with several tags counts
   in full under each tag and items with no tag go to "No tag", so tags can add up to more than the
   total; the view says so.
7. Each group line shows items, sessions, cost, run time, and the average cost and time per item.
8. **Period**: all time, 90 days or 30 days, by session start.

## Approaches

- **Sums in SQL at read time (chosen).** One CTE gives each session its cost, run time and item
  count; a second gives each item its share. Every list is a `GROUP BY` over those. Nothing new is
  stored, so the rules can change without a data migration. Three indexes keep it fast.
- A stored per-item cost table, updated as results arrive: faster reads, but a second copy of the
  truth that must be rebuilt whenever a rule changes or an item joins a batch late. Not needed at
  this size.
- Sums in the web app from the session list: the list is capped and has no turn times.

## Design

- `src/server/migrations/037_cost_indexes.sql`: indexes on `sessions(project_id)`,
  `session_items(item_id)`, and the `result` rows of `session_events`.
- `src/server/store.ts`: `projectCosts(projectId, since)` and `allCosts(since)`; the split rule is
  the `share` part of `costCte`.
- `src/server/routes/costs.ts`: `GET /api/projects/:key/costs` and `GET /api/costs`, both with an
  optional `?days=`; scope `read`.
- `web/src/pages/Costs.tsx`: `/p/:key/costs` (from the project's Sessions tab) and `/costs` (from
  Projects). Phone first: each line has its name, cost and run time, a bar for its share of the
  largest line, and a line of detail. `web/src/cost.ts` writes money and run time.
- The fake runner reports `FAKE_COST_USD` per turn (default 0) so the e2e test has a cost to show.

## Out of scope

Budgets, alerts, charts beyond the bars, token counts, and any change to how usage is recorded.
