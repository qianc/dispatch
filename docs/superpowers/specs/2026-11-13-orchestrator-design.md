# Orchestrator: a long-running session that drives a plan over one or more projects

Status: proposal, not approved. Nothing here is decided by the owner yet; every choice is marked
as a call he can change.

## Why

Today a larger plan (several batches, sometimes several projects) is run from a Claude Code
session outside Dispatch. That session writes the plan, files the items and tells the owner which
batch to start next. Two things are wrong with it:

- It is not in the app. The owner cannot follow or steer it from the phone.
- It cannot act. An outside session has `read` and `tracker` only: it cannot start a batch, answer
  an agent's question, see that a branch merged, or start the next step. The owner does all of
  that by hand.

Inside Dispatch the parts exist but do not connect. A scheduled planner starts batches with no
approval, but it is one project, one turn, no memory. The Assistant sees all projects but only
shows cards. No session is told when another one finishes.

## Goal

An **orchestrator** is a new kind of session that:

1. holds a plan the owner agreed to, over one or more projects;
2. starts the batches of that plan itself;
3. is woken when one of its batches finishes, merges, fails or asks something, and then decides
   the next step;
4. is an ordinary chat in the app: the owner reads it, writes to it, pauses it and stops it there.

Non-goals:

- No new way to run code. All code changes still happen in normal work sessions, one branch and
  one PR each. The orchestrator edits no files and runs no commands in project repos.
- Not a replacement for the planner chat or for schedules. They stay as they are.
- No orchestrators that start orchestrators.

Anti-goals (it fails if this happens, even when it works):

- Work starts in a project the owner did not put in scope.
- It keeps going after something went wrong, and stacks batches on a broken base.
- The owner cannot tell from the phone what it is doing and why it is waiting.

## Approaches

**A. A new session kind inside Dispatch (picked).** The orchestrator is a session on a worker, as
a planner is, with tools that start and steer child sessions, and the server wakes it on child
events. Fixes both problems: it is in the app, and it can act. Most work, but it reuses what the
scheduled planner already does (`startBatch` without a card, server-side rules).

**B. Open the session API to outside sessions.** Add start, answer and merge to the CLI and `/mcp`,
and let the outside Claude Code session poll. Small to build. But the session is still not in the
app, it dies when the dev machine sleeps, and it widens what a leaked token can do (the reason
remote tokens are `read` and `tracker` today). Rejected.

**C. Give the Assistant the power to start work.** The Assistant already spans projects. But it is
one endless chat per person on a small model, with no plan and no wake-ups; making it own several
long plans turns it into something else. Rejected. The Assistant should instead be able to
*propose* an orchestrator, as it proposes a batch today.

## Design

### Two phases

- **Plan.** The owner starts an orchestrator with a goal in prose and a list of projects. It reads
  the trackers and the code, asks questions, and writes the plan. This is a normal chat with
  questions and a plan-approval card. Nothing is started.
- **Run.** After the owner approves the plan, it works alone. It asks only when the plan does not
  answer something, or when a rule below says it must.

The owner can write to it at any time in both phases, and can send it back to Plan ("change the
plan: skip step 4").

### The plan is data on the server

The plan is not only chat text. The server keeps it, so it survives a resumed or compacted
session, and the app can show it.

- `orchestrations` row: goal, scope (project ids), options, phase (`plan`, `run`, `paused`,
  `done`, `stopped`), plan text (markdown, the full reasoning).
- `orchestration_steps`: order, title, project, what to do, depends-on (other steps), state
  (`pending`, `running`, `review`, `done`, `failed`, `skipped`), the items it covers, the child
  session.

The orchestrator writes these with a tool (`set_plan`, `update_step`). The first message of every
wake-up turn carries the current plan and step states, so it never has to remember them.

A step is one batch (one work session, one branch, one PR per changed repo). A step in project B
can depend on a step in project A; "done" means merged, and deployed when the repo has a deploy
command.

### Tools (worker `dispatchMcp`, kind `orchestrator`)

Inside its scope, with no approval card:

- read: `list_projects` (scope only), `list_items`, `get_item`, `view_image`, project instructions,
  and the code of the scope's repos (read-only checkouts, as a planner has, one per repo);
- tracker: `create_items`, `update_item`, `add_comment` (the scheduled planner's limits apply: it
  cannot take an item off hold or close one);
- plan: `set_plan` (Plan phase, and in Run only after the owner agreed to a change), `update_step`;
- children: `start_step` (starts the step's batch now, through `startBatch`), `get_session` (state,
  last text, PRs, check and deploy result), `send_to_session` (a follow-up message),
  `answer_session` (answer a child's question or plan approval), `stop_session`;
- `finish` (all steps done or given up: writes the result).

Outside its scope it has nothing: no cross-project request cards. To widen the scope the owner
edits the scope.

There is no merge tool. Merging follows each step's run options: with auto-merge on, Dispatch
merges when the checks pass, as today. With it off, the step waits in `review` for the owner.

### Wake-ups

The orchestrator's turn ends when it has nothing to do. Its Claude process closes after the idle
time, as any session's does. The server starts its next turn with a short event text when:

- a child session's turn ended (with its last text and the turn check result);
- a child's PR merged, or the deploy after it finished or failed;
- auto-merge stopped (blocked, conflicts, branch behind);
- a child failed, or waits for a worker for longer than a set time;
- a child asked a question or wants a plan approved;
- the owner wrote to the orchestrator;
- a timer it set itself fired (`wake_me_in`, for "look again tomorrow").

Events that arrive while it works are queued and given together in the next turn. The server, not
the model, links children to steps and keeps the step states for merge and failure, so a missed
wake-up cannot leave the plan wrong.

### Child questions

This is the main thing that removes the manual steps.

- A question or plan approval from a child goes to the orchestrator first, not to the owner's
  Needs you list.
- The orchestrator answers it when the plan or the tracker answers it. The answer shows in the
  child's chat as "answered by orchestrator #N", so the owner can read and overrule it.
- When it does not know, it asks the owner with its own question card (one push), then passes the
  answer on. A setting can turn this off: "send every child question straight to me".

### Rules the server enforces

Whatever the prompt says:

- only projects in scope; a locked project refuses, as for everything else;
- at most N child sessions at once (default 2) and at most M steps started in total (default: the
  number of steps in the approved plan, so extra steps need the owner);
- an optional cost limit over the orchestrator and its children; at the limit it pauses and asks;
- a step starts only when the steps it depends on are `done`;
- **stop on red**: when a step fails, or its auto-merge stops and one fix attempt
  (`send_to_session`) does not clear it, the steps that depend on it do not start, and the owner
  gets a push. Steps that do not depend on it go on;
- items on hold, in progress, in review or in another open session are never started;
- children run as the owner who started the orchestrator (GitHub identity, worker ownership,
  pushes), as a schedule's runs do.

### Pause, stop, restart

- **Pause**: no new steps start, wake-ups are held. Running children go on. Resume gives it the
  held events.
- **Stop**: pause, and the sheet offers to stop the running children too.
- A server restart loses nothing: plan, steps and queued events are in the database.
- A child moved to another worker stays the same step.

### Where it runs

On a worker, as the Agent model (not the small Assistant model), with superpowers loaded so the
Plan phase is the usual brainstorm and plan. Default worker: the first project's default. It needs
that worker to be up to think; children on other workers still run and their events wait.

### App

No new tab. An orchestrator is a session and shows where sessions do, plus one page for the plan.

**Start.** "New orchestration" in Activity opens a sheet: the goal in prose, the projects it may
touch, the limits, and the default run options for its steps (`RunOptionsFields`). Or the
Assistant proposes one as a card the owner confirms.

**The orchestrator page** is the session page with the plan above the chat (in the side panel on
desktop):

```
‹  Auth rework                    Running   ⏸ Pause  ■ Stop
   HC · DISP    3 of 6 steps    $4.10
   Waiting for #212 to merge in HC
──────────────────────────────────────────────────────────
 ✓ 1  HC    Token store            HC-41, HC-42     #209 merged
 ✓ 2  HC    Login page             HC-43            #210 merged
 ● 3  HC    Session refresh        HC-44            #212 checking
 ○ 4  DISP  Use the new tokens     DISP-90          after 3
 ○ 5  DISP  Remove old sign-in     DISP-91          after 4
 ○ 6  HC    Docs and changelog     HC-45            after 3
──────────────────────────────────────────────────────────
 chat, and the message box
```

- The header shows the phase, the projects, steps done, cost so far, and in one line what it
  waits for.
- A step row opens its child session. A failed step is red; a step it holds says "held by step 3".
- **Step menu**: Skip, Retry, Open the session. Skip and Retry are server actions (they set the
  step state and wake the orchestrator with that event), so they work when the model is idle.
- **Settings icon** in the header: scope and limits, editable while it runs. A wider scope or a
  higher limit takes effect at the next wake-up.

**Steering.** The owner writes in the chat ("skip step 5", "do 6 before 4", "add a step for the
mobile app"). A change of the plan comes back as a plan-approval card and applies only after the
owner's yes. Pause and Stop are in the header (see Pause, stop, restart).

**Inbox.** The orchestrator is the sender:

- Questions & approvals: the plan to approve, a plan change, a question it could not answer.
- Failed: "Auth rework: step 3 failed, steps 4 and 5 are held", with Retry, Skip and "What would
  fix the issue?" (as failed sessions have today).
- To review: a step with auto-merge off, as a normal PR row with the orchestration's name on it.

A child's question the orchestrator answered itself is not in the Inbox. The child's chat shows
the answer as "answered by orchestrator #N" with **Overrule**: the owner's own answer is then sent
to the child as its next message, and the orchestrator is told.

**Activity.** One row per orchestrator under Live, with steps done and what it waits for. Its
children are folded under it.

**Project page.** The Sessions tab shows the orchestrator's children in that project with a tag
and "Part of Auth rework (step 3 of 6)". A child session's page links back to its orchestrator
and step.

**Pushes.** Plan ready to approve, a question, stop on red, a step waits for review (auto-merge
off), finished. Not one per child turn.

## Build order

Each phase is useful alone and is its own plan.

1. **Core.** Kind `orchestrator`, the tables, Plan phase, `set_plan` / `update_step` /
   `start_step` / `get_session`, wake-ups for turn end, merge, deploy and failure, the server
   rules, the start sheet, the page with the step list and step menu, pause and stop, the Inbox
   and Activity rows. Child questions still go to the owner.
2. **Answering children.** Questions and plan approvals go to the orchestrator first;
   `answer_session`, `send_to_session`, Overrule, the one fix attempt in stop on red.
3. **Comfort.** Timer wake-ups, the cost limit, the settings icon for scope and limits while it
   runs, the Assistant's proposal card, folding children in Activity.

## Calls made without the owner (change any of them)

1. It never merges itself; merging stays with auto-merge or the owner.
2. Free read and tracker access inside the scope, nothing outside it.
3. Children's questions go to the orchestrator first (phase 2), with the answer shown and a
   setting to turn it off.
4. Stop on red after one fix attempt, only for the steps that depend on the failed one.
5. One step is one batch. A step is never several batches or part of one.
6. The plan lives in Dispatch's database, not in a repo file. Items in each project carry the
   work; the plan links to them.
7. Limits: 2 children at once, no steps beyond the approved plan without the owner.

## Left to the builder

- How the read-only checkouts of several repos are laid out on the worker.
- The exact event text of each wake-up, and how queued events are merged.
- Whether `orchestrations` is its own table or columns on `sessions` plus the steps table.
- The fake runner script for the tests.

## Tests (outline)

- Server with the fake worker: approve a plan, the first step starts, its merge wakes the
  orchestrator, the next step starts; a failed step holds only its dependants; a project outside
  the scope is refused; the child limit and the step limit hold; pause holds events and resume
  delivers them; a restart keeps plan and events.
- Phase 2: a child question reaches the orchestrator, its answer reaches the child and shows who
  answered; an escalated question reaches the owner once.
- e2e: start an orchestration, approve the plan, see the steps move.
