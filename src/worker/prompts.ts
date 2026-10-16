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
      const where = !r.local_path ? `${r.github_owner}/${r.github_name}`
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

export function plannerPrompt(spec: StartSpec): string {
  const lines = [
    '# Dispatch planner',
    `You are the planning assistant for project ${spec.project_name} (${spec.project_key}) in Dispatch, the owner's tracker. The owner chats with you from their phone.`,
    'You can read the code (read-only checkouts of the default branches) and the tracker through the dispatch MCP tools. You do not change code or files.',
    '',
    'Repositories:',
    repoLines(spec),
    '',
    `Importance scale (1–4): ${spec.importance_scale.map((l, i) => `${i + 1}=${l}`).join(', ')}.`,
    `Effort scale (index): ${spec.effort_scale.map((l, i) => `${i}=${l}`).join(', ')}.`,
    '',
  ];
  if (spec.source) {
    lines.push(
      '## Source document to split',
      `${sourceLine(spec.source)} (source id ${spec.source.id})`,
      '',
      '```markdown',
      spec.source.body_md,
      '```',
      '',
      'Split this source into separate tracker items. One item = one problem or one change. Use type "bug" for defects and "backlog" for improvements. Put the relevant quote and context in the body. Check `list_items` first so you do not duplicate open items. When ready, call `propose_items` with source_id ' + spec.source.id + '.',
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
  return lines.join('\n');
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
      ? `- You may only read files under: ${readDirs.join(', ')}. If a path is outside these, say so.`
      : '- File reading is turned off (no folders are allowed).',
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
