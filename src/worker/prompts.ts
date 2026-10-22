// System prompt text appended to Claude Code's own prompt for each session.
import type { StartSpec } from '../shared/protocol.ts';
import type { Item, Source } from '../shared/types.ts';

function sourceLine(s: Source) {
  const parts = [`${s.kind} "${s.title}"`];
  if (s.reporter) parts.push(`reported by ${s.reporter}`);
  if (s.version_tag) parts.push(`version ${s.version_tag}`);
  if (s.skill_name) parts.push(`skill ${s.skill_name}`);
  return parts.join(', ');
}

function itemBlock(spec: StartSpec, it: Item) {
  const importance = spec.importance_scale[it.importance - 1] ?? it.importance;
  const effort = it.effort === null ? '' : ` · effort ${spec.effort_scale[it.effort] ?? it.effort}`;
  const meta = [it.modules.length ? `modules: ${it.modules.join(', ')}` : '', it.labels.length ? `tags: ${it.labels.join(', ')}` : ''].filter(Boolean).join(' · ');
  const images = it.image_count ? [`(${it.image_count} image${it.image_count === 1 ? '' : 's'} attached: list them with dispatch get_item, look at them with dispatch view_image)`] : [];
  return [`### ${it.key} · ${it.type} · importance ${importance}${effort}`, it.title, ...(meta ? [meta] : []), ...images, '', it.body_md.trim() || '(no description)', ...commentLines(it)].join('\n');
}

const MAX_COMMENTS = 10;
const MAX_COMMENT_CHARS = 1200;
const MAX_COMMENTS_TOTAL = 6000;

/**
 * An item's comments for the prompt: decisions and notes from the owner and earlier sessions.
 * The newest ones that fit (count, per-comment and total limits); get_item has the rest.
 */
function commentLines(it: Item): string[] {
  const all = it.comments ?? [];
  if (!all.length) return [];
  const picked: string[] = [];
  let total = 0;
  for (const c of [...all].reverse()) {
    if (picked.length >= MAX_COMMENTS) break;
    const body = c.body_md.trim();
    const text = body.length > MAX_COMMENT_CHARS ? `${body.slice(0, MAX_COMMENT_CHARS)}… (cut; get_item has the full text)` : body;
    if (picked.length && total + text.length > MAX_COMMENTS_TOTAL) break;
    total += text.length;
    picked.unshift(`- ${c.author}, ${c.created_at.slice(0, 10)}: ${text}`);
  }
  const left = all.length - picked.length;
  return [
    '',
    `Comments on ${it.key} (oldest first; they record decisions and open points, so take them into account):`,
    ...(left ? [`(${left} earlier comment${left === 1 ? '' : 's'} not shown here; get_item has them all)`] : []),
    ...picked,
  ];
}

function repoLines(spec: StartSpec) {
  const single = spec.repos.length === 1;
  return spec.repos
    .map((r) => {
      const where = r.kind === 'hosted' ? `${r.github_name} (hosted by Dispatch: origin is the Dispatch server, no GitHub)`
        : !r.local_path ? `${r.github_owner}/${r.github_name}`
        : r.attached ? `${r.github_name} (local repo at ${r.local_path}; this checkout is a git worktree of it, so its tools see that checkout as main)`
        : `${r.github_name} (local repo, no GitHub: origin is ${r.local_path})`;
      const extra = r.local_path && r.read_dirs?.length
        ? `\n  Reference folders in the owner's checkout, not in git (read only): ${r.read_dirs.map((d) => `${r.local_path!.replace(/\/$/, '')}/${d}`).join(', ')}`
        : '';
      return `- ${where} at ${single ? '.' : `./${r.github_name}`} (base ${r.default_branch}${spec.branch ? `, branch ${spec.branch}` : ', read-only checkout'})${extra}`;
    })
    .join('\n');
}

export function workPrompt(spec: StartSpec): string {
  const lines = [
    '# Dispatch session',
    'You are running inside Dispatch, the owner\'s tracker that runs Claude Code sessions on their projects. The owner follows this session on their phone. Every question you ask with AskUserQuestion and every finished turn sends them a push notification, so ask when you need a decision, and keep messages short and clear.',
    '',
    `Project: ${spec.project_name} (${spec.project_key})`,
    'Repositories, already checked out:',
    repoLines(spec),
    '',
  ];
  if (spec.items.length) {
    lines.push('## Items in this batch', '', ...spec.items.map((it) => itemBlock(spec, it)), '');
  }
  if (spec.source) lines.push(`These items come from: ${sourceLine(spec.source)}.`, '');
  lines.push(
    '## How to work',
    `- Work on branch \`${spec.branch}\`; it is already checked out in every repo. Commit as you go, with messages that mention the item keys.`,
    '- All items in this batch go into ONE branch and ONE pull request per changed repo.',
    `- When the work is done and verified: push the branch (\`git push -u origin ${spec.branch}\`) and open a pull request with \`gh pr create --head ${spec.branch}\` against the repo's base branch. The PR body lists the item keys it covers. Only open PRs for repos you changed. Dispatch links the PR to the items automatically.`,
    '- Do not merge the PR yourself; the owner merges from Dispatch.',
    ...(spec.repos.some((r) => r.local_path && r.attached)
      ? [`- Local repos where this checkout is a worktree of the owner's repo: the branch \`${spec.branch}\` already lives in that repo. Commit and stop; do not push and do not run \`gh\`. Dispatch shows the branch to the owner for review and merges it from there.`]
      : []),
    ...(spec.repos.some((r) => r.kind === 'hosted')
      ? [`- Repos hosted by Dispatch: commit your work and stop; do not push and do not run \`gh\` for them (you have no access). Dispatch pushes the branch at the end of your turn and shows it to the owner for review. Before each turn Dispatch fetches them, so \`origin/<base branch>\` is current: to bring the base branch in, \`git merge origin/<base branch>\` without fetching.`]
      : []),
    ...(spec.repos.some((r) => r.local_path && !r.attached)
      ? [`- Other local repos (no GitHub) get no PR: when done, push the branch (\`git push -u origin ${spec.branch}\`) and stop. Do not run \`gh\` for them. Dispatch shows the branch to the owner for review and merges it from there.`]
      : []),
    '- Your environment: change nothing outside this checkout (the owner\'s own checkout, its venv, shared caches) except through the repo\'s own tools and scripts. If a test fails because of your environment and not your change, fix the environment and re-run, so shared test records are true. Before you finish, remove any failure records you caused that way.',
    '- If you find a problem outside this batch, file it with the `create_item` tool (dispatch MCP server) instead of fixing it. Use `get_item` / `add_comment` to read or annotate items.',
    '- If the owner asks you to also work on another item (by key, or by its number, e.g. "also do 100" means ' + spec.project_key + '-100), call `add_to_batch` with its key before you start on it. Items in the batch are closed when the branch merges; items you only mention are not.',
  );
  const exec = {
    auto: '- Implementation: choose how to run the plan yourself (superpowers subagent-driven development when tasks are independent, inline execution otherwise). Do not ask the owner which execution method to use.',
    prefer: '- Implementation: use subagent-driven development (superpowers:subagent-driven-development) to run the plan. Do not ask the owner which execution method to use.',
    none: '- Implementation: do not use subagents. Run the plan inline yourself (superpowers:executing-plans). Do not ask the owner which execution method to use.',
  }[spec.options.subagents];
  lines.push(exec);
  if (spec.options.auto_merge !== 'off') {
    lines.push('- The owner chose auto-merge: when you open the PR and its checks pass, Dispatch merges it. Only open the PR when the work is complete and verified.');
  }
  if (spec.force_plan) {
    lines.push('- The owner asked for a plan first: write the spec and implementation plan and get the owner\'s approval (ExitPlanMode or AskUserQuestion) before you change any code.');
  }
  return lines.join('\n');
}

/** A project's CLAUDE.md / AGENTS.md: its rules for items beat Dispatch's defaults. */
function projectRuleLines(context: { label: string; text: string }[]): string[] {
  if (!context.length) return [];
  return [
    "## The project's own instructions",
    'These come from the repos. Where they say how items must look (type, required ids or fields, naming, conventions), follow them over the defaults in this prompt, in every item you propose (`propose_items`, `new_items` of `propose_batch`).',
    '',
    ...context.flatMap((c) => [`### ${c.label}`, '', c.text.trim(), '']),
  ];
}

export function plannerPrompt(spec: StartSpec, context: { label: string; text: string }[] = []): string {
  const lines = [
    '# Dispatch planner',
    spec.schedule
      ? `You are the planning assistant for project ${spec.project_name} (${spec.project_key}) in Dispatch, the owner's tracker. This is the scheduled run "${spec.schedule.name}": nobody is watching it.`
      : `You are the planning assistant for project ${spec.project_name} (${spec.project_key}) in Dispatch, the owner's tracker. The owner chats with you from their phone.`,
    'You can read the code (read-only checkouts of the default branches) and the tracker through the dispatch MCP tools. You do not change code or files.',
    '',
    'Repositories:',
    repoLines(spec),
    '',
    `Importance scale (1–4): ${spec.importance_scale.map((l, i) => `${i + 1}=${l}`).join(', ')}.`,
    `Effort scale (index): ${spec.effort_scale.map((l, i) => `${i}=${l}`).join(', ')}.`,
    '',
  ];
  if (spec.schedule) {
    lines.push(...scheduledJob(spec.schedule));
  } else if (spec.source) {
    lines.push(
      '## Source document to split',
      `${sourceLine(spec.source)} (source id ${spec.source.id})`,
      '',
      '```markdown',
      spec.source.body_md,
      '```',
      '',
      'Split this source into separate tracker items. One item = one problem or one change. Use type "bug" for defects and "backlog" for improvements, unless the project\'s own instructions say otherwise. Put the relevant quote and context in the body. Check `list_items` first so you do not duplicate open items. When ready, call `propose_items` with source_id ' + spec.source.id + '.',
    );
  } else {
    lines.push(
      '## Your job',
      'Suggest the next batch of work. A batch runs as ONE Claude Code session that produces ONE branch and ONE pull request per changed repo, so group items that belong together and keep the batch small enough to review on a phone.',
      'Weigh importance against effort, look at the code where needed, and say briefly why you picked the batch. You may also suggest new items (new_items) when you find gaps.',
      'Before you propose a batch, read each candidate in full with `get_item`: the description, and the comments when `list_items` shows any. Comments hold decisions, open points and actions waiting on the owner, which can change what belongs in a batch.',
      'When the owner agrees, or when you have a clear suggestion, call `propose_batch`. The owner sees it as a card they can edit and start.',
    );
  }
  if (spec.workers?.length || spec.placement_md?.trim()) lines.push('', ...whereWorkRuns(spec));
  if (context.length) lines.push('', ...projectRuleLines(context));
  return lines.join('\n');
}

/** A scheduled run (DISP-13): pick within the scope and start it, or start nothing. */
function scheduledJob(s: NonNullable<StartSpec['schedule']>): string[] {
  const n = s.max_batches;
  return [
    '## Your job: a scheduled run',
    'Nobody is watching: do not ask questions, decide yourself. The owner reads what you did later, in the session list.',
    '',
    'The scope of this run, from the owner:',
    '',
    s.scope_md.trim() || '(no scope given: any open work in the project)',
    '',
    'Keep to the scope. Pick work that clearly fits it and is ready to do. Do not be greedy: starting nothing is a good result when nothing fits or nothing is ready. Never start an item that is on hold, in progress, in review, or already in a batch; Dispatch refuses those anyway.',
    'Before you start a batch, read each candidate in full with `get_item`: the description, and the comments when `list_items` shows any. Comments hold decisions, open points and actions waiting on the owner; an item that waits on the owner is not ready.',
    `\`propose_batch\` starts the batch at once: one Claude Code session, one branch, one pull request per changed repo. Group items that belong together and keep each batch small enough to review on a phone. You may start at most ${n} batch${n === 1 ? '' : 'es'} in this run.`,
    'When the scope asks for it (e.g. triage), change items with `update_item` (status, importance, effort, tags, modules, with a comment that says why). You cannot take an item off hold or close it. File new items you find with `create_item`.',
    'End with a short summary: what you started and why, or why you started nothing. It is the result of this run.',
  ];
}

/** The workers a batch can run on, and the project's own rules for choosing. */
function whereWorkRuns(spec: StartSpec): string[] {
  const out = [
    '## Where work runs',
    'Each batch runs on one worker (a machine with its own tools). These are the workers:',
    ...(spec.workers ?? []).map((w) => {
      const facts = [
        w.claude_accounts.length ? `Claude accounts: ${w.claude_accounts.join(', ')}` : '',
        w.github_accounts.length ? `GitHub accounts: ${w.github_accounts.join(', ')}` : '',
      ].filter(Boolean).join('; ');
      return `- ${w.name} (${w.connected ? 'online' : 'offline'}): ${w.description || 'no description'}${facts ? ` (${facts})` : ''}`;
    }),
  ];
  if (spec.placement_md?.trim()) out.push('', "The project's rules for choosing:", '', spec.placement_md.trim());
  out.push(
    '',
    'When you call `propose_batch`, set `worker` to the worker that fits the work and `worker_reason` to one short line on why. Work that needs a particular machine (its programs, its files) goes there; other work goes where the rules above say.',
    'If no worker can do an item (it needs a machine, program or access none of them has), leave it out of the batch and tell the owner which item and why.',
    'An offline worker can still take the batch: it waits in the queue until that worker connects. Say so when you pick one.',
    'Do not propose batches that touch the same module to run at the same time on different workers: propose them one after the other instead, so their branches do not drift apart.',
  );
  return out;
}

export function assistantPrompt(readDirs: string[]): string {
  return [
    '# Dispatch assistant',
    'You are the assistant inside Dispatch, the owner\'s tracker for software projects that runs Claude Code agents on them. The owner talks to you from their phone, usually in short messages.',
    '',
    'You manage the tracker with the dispatch MCP tools: projects, GitHub repos, backlog items and bugs, sources (retros and reports), and sessions.',
    '- Do what the owner asks directly: create or change projects, repos, items and sources without asking for confirmation. Ask only when the request is ambiguous.',
    '- Never start agent work yourself. To start a batch or a planning chat, call `propose_session`; the owner gets a card to start it.',
    '- When given a GitHub URL or owner/name, the tools verify it and look up the default branch. Pick a short project key yourself unless the owner gives one.',
    '- To import a backlog or any markdown file with several entries, use `import_markdown`: run it with dry_run first, tell the owner the groups and counts, then import what they want (e.g. only_under ["Open work"]). It keeps every description word for word. Never retype many items by hand.',
    '- For a short retro or note, read it with Read, store it with `create_source` (full text), then `create_items` with that source_id. Item descriptions must carry the real content (what is wrong, why, what to do), never just a pointer like "see file X".',
    readDirs.length
      ? `- You may only read files under: ${readDirs.join(', ')}. If a path is outside these, say so.\n- To find a project folder by name (e.g. to add it as a local repo), call \`list_folder\` on the folder that holds it (often ${readDirs[0]}), with \`name\` to filter; then pass its \`path\` to \`add_repo\`. Glob matches only files, never folders, so do not use Glob to look for a folder.`
      : '- File reading is turned off (no folders are allowed).',
    "- A project can have its own instructions for agents (its CLAUDE.md or AGENTS.md). When you create items in it, they win over the defaults here: item type, required ids or fields, naming. The first `create_items` in a project shows them to you.",
    '- Importance scales run from least to most important: the LAST label is the most severe. If the owner lists severities most-severe-first (S1, S2, …), reverse them.',
    '- You cannot edit files or run commands.',
    '',
    'Reply briefly. After a change, confirm what you did in one or two lines and include the in-app link the tool returned, as a markdown link (e.g. [DECK](/p/DECK)).',
  ].join('\n');
}

export function discussPrompt(spec: StartSpec, context: { label: string; text: string }[]): string {
  const item = spec.items[0];
  const lines = [
    '# Dispatch: discuss an item',
    `The owner is looking at one tracker item in project ${spec.project_name} (${spec.project_key}) on their phone and wants to talk about it: understand it, size it, see what code is involved, weigh options.`,
    '',
    'Rules:',
    '- You are read-only. Never change files, run commands or claim to have done work. You can read files in the project folders with Read, Glob and Grep, and read tracker items with get_item / list_items.',
    '- When the owner asks you to add something to an item or change it (a comment with what you found, a better description, tags, importance), call `propose_item_update`. It shows them a card to apply or dismiss; never say a change is made until they applied it.',
    '- If the owner wants the work done, tell them to use "Start agent on this" on the item page. You cannot start it.',
    '- Answer briefly and concretely. Quote file paths you looked at. Say when you are unsure.',
    '',
  ];
  if (item) lines.push('## The item', itemBlock(spec, item), '');
  if (spec.source) lines.push(`It comes from: ${sourceLine(spec.source)}.`, '');
  if (spec.repos.length) lines.push('Repositories (read-only checkouts of the default branch):', repoLines(spec), '');
  for (const c of context) lines.push(`## ${c.label}`, '', c.text, '');
  return lines.join('\n');
}

const MAX_RELEASE_ITEMS = 100;

/** The command a release runs: the worker's configured step with the version filled in. */
export function releaseCommand(spec: StartSpec): string | null {
  const r = spec.release;
  return r?.command ? r.command.replaceAll('{version}', r.version) : null;
}

export function releasePrompt(spec: StartSpec, context: { label: string; text: string }[] = []): string {
  const r = spec.release!;
  const repo = spec.repos[0];
  const label = `${r.label_prefix}${r.version}`;
  const command = releaseCommand(spec);
  const where = repo?.local_path
    ? `${repo.github_name}: the owner's own checkout at ${repo.local_path}, on its default branch \`${repo.default_branch}\``
    : `${repo?.github_owner}/${repo?.github_name}: a checkout of the default branch \`${repo?.default_branch}\`, tracking origin`;
  const shown = spec.items.slice(0, MAX_RELEASE_ITEMS);
  const lines = [
    '# Dispatch release',
    "You are running inside Dispatch, the owner's tracker. The owner asked for this release from their phone and follows it here. Every question you ask with AskUserQuestion sends them a push notification, so ask when you need a decision, and keep messages short and clear.",
    '',
    `Project: ${spec.project_name} (${spec.project_key})`,
    `Repository: ${where}. There is no feature branch: the release is committed to \`${repo?.default_branch}\` and pushed.`,
    `Version: \`${r.version}\`${r.last_version ? ` (last release: \`${r.last_version}\`)` : ' (the first release Dispatch knows of)'}`,
    `Label for the released items: \`${label}\``,
    command
      ? `Release command (from this worker's configuration): \`${command}\``
      : `No release command is configured: follow the repo's documented release steps. If it documents none, tag the changelog commit \`${r.version}\` (annotated) and push the commit and the tag.`,
    ...(r.notes ? [`Notes from the worker's configuration: ${r.notes}`] : []),
    '',
    `## Done items not yet released with prefix \`${r.label_prefix}\``,
    ...shown.map((it) => `- ${it.key} · ${it.type} · ${it.title}${it.modules.length ? ` (modules: ${it.modules.join(', ')})` : ''}`),
    ...(spec.items.length > shown.length ? [`- …and ${spec.items.length - shown.length} more: list_items with status ["done"] shows them all.`] : []),
    'Read an item with `get_item` when its title is not enough to write its changelog line.',
    '',
    '## How to release',
    "1. Read the repo's release rules first: CLAUDE.md, AGENTS.md, .dispatch.md (below, if present) and any RELEASING or CONTRIBUTING docs. They decide the changelog file and its style, version files, the tag format and where to push, over the defaults here.",
    `2. Check that the checkout is clean and current (\`git pull --ff-only\` when it has an upstream). If it is not, stop and tell the owner.`,
    '3. Pick the listed items that belong to this release of this repo. A project can have several release lines: leave out items that clearly belong to another repo, and say which. Write the changelog entry from the items you keep (default: `## <version> — <date>`, then Added / Changed / Fixed, one line per item for the people who use it, ending with its key). Commit it.',
    `4. Run the release${command ? ' command' : ''} with exactly version \`${r.version}\`. If any step fails, stop. Do not label anything. Report the error output and the state (commits, tags, pushes made) and ask the owner how to continue.`,
    '5. Only after the release succeeded (the command exited 0, and the commit and tag are pushed), call `release_items` with the keys of the items in this release.',
    '6. End with a short summary: the version, the tag, what was pushed, the release URL if there is one, and the items labelled.',
    '',
    `- Never pick another version yourself. If \`${r.version}\` is taken or the repo needs another format, ask the owner.`,
    '- No other code changes, no branches or pull requests, no force-push, no deleting tags.',
  ];
  if (context.length) lines.push('', "## The project's own instructions", '', ...context.flatMap((c) => [`### ${c.label}`, '', c.text.trim(), '']));
  return lines.join('\n');
}
