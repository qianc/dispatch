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
  return [`### ${it.key} · ${it.type} · importance ${importance}${effort}`, it.title, ...(meta ? [meta] : []), '', it.body_md.trim() || '(no description)'].join('\n');
}

function repoLines(spec: StartSpec) {
  const single = spec.repos.length === 1;
  return spec.repos
    .map((r) => `- ${r.github_owner}/${r.github_name} at ${single ? '.' : `./${r.github_name}`} (base ${r.default_branch}${spec.branch ? `, branch ${spec.branch}` : ', read-only checkout'})`)
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
    '- If you find a problem outside this batch, file it with the `create_item` tool (dispatch MCP server) instead of fixing it. Use `get_item` / `add_comment` to read or annotate items.',
  );
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
