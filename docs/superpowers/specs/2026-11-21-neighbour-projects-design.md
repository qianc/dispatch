# Neighbour projects: sessions file items into an adjacent project (DISP-126)

## Why
Sessions often find work that belongs to a neighbouring project: for example, a slides batch that changed a
flow which a techdoc in another project describes. `create_item` wrote only to the session's own
project. The finding then sat in the wrong project until the owner moved it by hand.

## Model (picked by the owner)
For each project, the owner sets an allow-list of **neighbour projects** in the project's settings.
Work sessions and scheduled runs of that project may file items into those neighbours, and into no
other project.

- **One way.** If the owner ticks DOCS in SLIDES, SLIDES sessions can file into DOCS. DOCS sessions get nothing back.
- **Direct, but reviewed.** The item is created at once, in the neighbour's **Triage**, whatever its type. The owner sorts it there. The session does not wait.
- **Source recorded.** The item's source is the session's `agent_session` source in the neighbour project. Its title names the origin project: "Found during session #12 (SLIDES): …".
- **Rules first.** The neighbour's repo is not in the checkout. So the first filing per session and neighbour returns the neighbour's CLAUDE.md/AGENTS.md (`projectRules`), and nothing is created on that call. This is the same mechanism the Assistant uses.
- **Refused:** a project that is not a neighbour (the error lists the allowed keys), a disabled neighbour, and any other kind of session.
- **Filing only.** `get_item`, `update_item`, `add_to_batch` and `add_comment` stay limited to the session's own project.

## Options not picked
- **Ask each time.** This reuses the DISP-55 approval card. The session stops until the owner taps, so nightly and unattended runs would block.
- **Add the neighbour's repo to the checkout.** This puts the neighbour's CLAUDE.md in scope, but the session still cannot file items there.

## Shape
- `project_neighbours(project_id, neighbour_id)`, migration 045. `Project.neighbours` holds the neighbours' keys. `PATCH /api/projects/:key { neighbours: [keys] }` sets them.
- `StartSpec.neighbours` gives each neighbour's key, name and scales, for work sessions and scheduled runs. Disabled neighbours are left out.
- The worker's `create_item` gets an optional `project_key`, an enum of the neighbour keys, only when the project has neighbours. Its description lists each neighbour's scales.
- The work prompt and the scheduled-run prompt each get one line about neighbours.
- The project settings page gets a "Neighbour projects" section, with a checkbox for each other project.
