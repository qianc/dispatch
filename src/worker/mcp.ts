// The in-process `dispatch` MCP server: tracker tools for the agent, backed by server RPC.
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { groupCounts, parseSections } from '../shared/markdownSections.ts';
import type { RpcMethod } from '../shared/protocol.ts';
import type { SessionKind } from '../shared/types.ts';

export type Rpc = (method: RpcMethod, params: unknown) => Promise<unknown>;

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true });
const call = (rpc: Rpc, method: RpcMethod) => async (params: unknown) => {
  try {
    return ok(await rpc(method, params));
  } catch (e) {
    return fail(e);
  }
};

const itemShape = {
  type: z.enum(['backlog', 'bug']).describe('bug = defect, backlog = improvement or feature'),
  title: z.string().describe('Short title, max 200 chars'),
  body_md: z.string().describe('Markdown description with context'),
  importance: z.number().int().min(1).max(4).describe('1–4, see the project importance scale'),
  effort: z.number().int().min(0).nullable().describe('Index into the project effort scale, or null if unknown'),
};

const assistantTools = (rpc: Rpc, readFile: (path: string) => Promise<string>): SdkMcpToolDefinition<any>[] => {
  const label = z.union([z.number(), z.string()]);
  const newItem = z.object({
    type: z.enum(['backlog', 'bug']).default('backlog'),
    title: z.string(),
    body_md: z.string().default(''),
    importance: label.optional().describe('1–4 or a label from the project importance scale'),
    effort: label.nullable().optional().describe('A label from the project effort scale, e.g. "M"'),
    tags: z.array(z.string()).optional().describe('Reuse the project\'s existing tags where they fit (see list_projects)'),
    modules: z.array(z.string()).optional().describe('Areas of the code/product, e.g. "charts"; reuse existing ones'),
  });
  return [
    tool('inspect_github_repo', 'Check a GitHub repo exists and get its default branch and description.', {
      repo: z.string().describe('owner/name or a github.com URL'),
    }, call(rpc, 'inspect_github_repo')),
    tool('list_projects', 'List all projects with key, repos, scales and open counts.', {}, call(rpc, 'list_projects')),
    tool('create_project', 'Create a project. Key is generated from the name if omitted. Repos are verified on GitHub and added with their real default branch.', {
      name: z.string(),
      key: z.string().optional().describe('2–10 capitals/digits, starts with a letter'),
      description: z.string().optional(),
      importance_scale: z.array(z.string()).length(4).optional().describe('Exactly 4 labels, LEAST important first, most severe/urgent last (e.g. ["Low","Medium","High","Critical"])'),
      effort_scale: z.array(z.string()).optional(),
      default_force_plan: z.boolean().optional(),
      repos: z.array(z.string()).optional().describe('owner/name or github.com URLs'),
    }, call(rpc, 'create_project')),
    tool('update_project', 'Change a project name, description, scales or plan-first default.', {
      key: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      importance_scale: z.array(z.string()).length(4).optional().describe('Exactly 4 labels, LEAST important first, most severe/urgent last (e.g. ["Low","Medium","High","Critical"])'),
      effort_scale: z.array(z.string()).optional(),
      default_force_plan: z.boolean().optional(),
    }, call(rpc, 'update_project')),
    tool('add_repo', 'Add a GitHub repo to a project (verified on GitHub; default branch looked up).', {
      project_key: z.string(),
      repo: z.string().describe('owner/name or a github.com URL'),
      default_branch: z.string().optional(),
      check_command: z.string().optional().describe('Command that must pass before a local merge, e.g. "npm test"'),
    }, call(rpc, 'add_repo')),
    tool('remove_repo', 'Remove a repo from a project.', { project_key: z.string(), repo: z.string() }, call(rpc, 'remove_repo')),
    tool('list_items', 'List open items in a project.', {
      project_key: z.string(),
      status: z.array(z.string()).optional(),
      type: z.enum(['backlog', 'bug']).optional(),
    }, call(rpc, 'list_items')),
    tool('create_items', 'Create backlog items or bugs in a project, optionally linked to a source.', {
      project_key: z.string(),
      items: z.array(newItem).min(1),
      source_id: z.number().int().optional().describe('From create_source, to link items to a retro/report'),
    }, call(rpc, 'create_items')),
    tool('update_item', 'Change an item: status, importance, effort, title or description.', {
      key: z.string().describe('e.g. HC-42'),
      status: z.string().optional(),
      importance: label.optional(),
      effort: label.nullable().optional(),
      title: z.string().optional(),
      body_md: z.string().optional(),
      tags: z.array(z.string()).optional().describe('Replaces the item\'s tags'),
      modules: z.array(z.string()).optional().describe('Replaces the item\'s modules'),
    }, call(rpc, 'update_item')),
    tool('create_source', 'Store a retro, skill-run report or user report (full text kept) so items can link to it.', {
      project_key: z.string(),
      kind: z.enum(['retro', 'skill_run', 'user_report', 'manual']).default('retro'),
      title: z.string(),
      body_md: z.string(),
      reporter: z.string().nullable().optional(),
      version_tag: z.string().nullable().optional(),
      skill_name: z.string().nullable().optional(),
    }, call(rpc, 'create_source')),
    tool('import_markdown', 'Import a markdown backlog/retro file: each heading at the item level becomes one item with its section text kept word for word, linked to a source holding the whole file. Importance and effort are read from the project scale labels in the text. Run with dry_run first to see the groups, then import the groups the owner wants. Never retype items by hand.', {
      project_key: z.string(),
      path: z.string().describe('File path, e.g. ~/projects/x/backlog.md'),
      dry_run: z.boolean().default(false).describe('Only report heading level and item counts per group'),
      only_under: z.array(z.string()).optional().describe('Import only sections under headings containing one of these texts, e.g. ["Open work"]'),
      heading_level: z.number().int().min(1).max(6).optional().describe('Heading level of the items (default: detected)'),
      type: z.enum(['backlog', 'bug']).default('backlog'),
      status: z.string().optional().describe('Status for the items, e.g. canceled for a "won\'t fix" group'),
      source_title: z.string().optional(),
      reporter: z.string().optional(),
      version_tag: z.string().optional(),
    }, async (p) => {
      try {
        const text = await readFile(p.path);
        const { level, sections } = parseSections(text, p.heading_level);
        const filters = (p.only_under ?? []).map((f: string) => f.toLowerCase());
        const picked = filters.length ? sections.filter((s) => s.ancestors.some((a) => filters.some((f: string) => a.toLowerCase().includes(f)))) : sections;
        if (p.dry_run) return ok({ heading_level: level, total: sections.length, selected: picked.length, groups: groupCounts(sections), sample_titles: picked.slice(0, 5).map((s) => s.title) });
        if (!picked.length) return fail(new Error('No sections matched'));
        return ok(await rpc('import_sections', {
          project_key: p.project_key, type: p.type, status: p.status, sections: picked,
          source: { title: p.source_title ?? p.path, body_md: text, reporter: p.reporter ?? null, version_tag: p.version_tag ?? null },
        }));
      } catch (e) {
        return fail(e);
      }
    }),
    tool('list_sessions', 'Show running and waiting agent sessions across projects.', {}, call(rpc, 'list_sessions')),
    tool('propose_session', 'Propose starting an agent session. The owner sees a card and starts it. type batch = work on items (one branch, one PR); planner = a planning chat for the project.', {
      type: z.enum(['batch', 'planner']),
      project_key: z.string(),
      item_keys: z.array(z.string()).optional().describe('For batch: item keys like HC-3'),
      title: z.string().optional(),
      prompt: z.string().optional().describe('Extra instructions for the session'),
      force_plan: z.boolean().optional(),
    }, call(rpc, 'propose_session')),
  ];
};

const noFiles = async () => {
  throw new Error('File reading is not available here');
};

export function dispatchMcp(kind: SessionKind, rpc: Rpc, readFile: (path: string) => Promise<string> = noFiles) {
  if (kind === 'assistant') return createSdkMcpServer({ name: 'dispatch', version: '1.0.0', tools: assistantTools(rpc, readFile) });
  if (kind === 'discuss') {
    return createSdkMcpServer({
      name: 'dispatch',
      version: '1.0.0',
      tools: [
        tool('get_item', 'Read one item with its description, comments and source.', { key: z.string().describe('e.g. HC-42') }, call(rpc, 'get_item')),
        tool('list_items', 'List open items in this project.', { status: z.array(z.string()).optional(), type: z.enum(['backlog', 'bug']).optional() }, call(rpc, 'list_items')),
      ],
    });
  }
  const tools: SdkMcpToolDefinition<any>[] = [
    tool('list_items', 'List open tracker items in this project (key, title, type, status, importance, effort).', {
      status: z.array(z.string()).optional().describe('Filter by status; default: all open statuses'),
      type: z.enum(['backlog', 'bug']).optional(),
    }, call(rpc, 'list_items')),
    tool('get_item', 'Read one item with its description, comments and source (retro/report).', {
      key: z.string().describe('Item key, e.g. HC-42'),
    }, call(rpc, 'get_item')),
    tool('add_comment', 'Add a comment to an item.', {
      key: z.string(),
      body: z.string(),
    }, call(rpc, 'add_comment')),
  ];
  if (kind === 'work') {
    tools.push(tool('create_item', 'File a new backlog item or bug you found that is outside this batch. It is linked to this session.', itemShape, call(rpc, 'create_item')));
  } else {
    tools.push(
      tool('propose_batch', 'Show the owner a proposed batch as a card they can edit and start. A batch = one session, one branch, one PR.', {
        title: z.string().describe('Short name for the batch'),
        item_ids: z.array(z.number().int()).describe('Numeric ids (from list_items) of existing items in the batch'),
        new_items: z.array(z.object(itemShape)).default([]).describe('New items to create as part of the batch'),
        prompt: z.string().describe('Extra instructions for the session that will do the work'),
        force_plan: z.boolean().default(false).describe('True if the work needs a written plan before code'),
      }, async (p) => call(rpc, 'propose')({ type: 'batch', ...p })),
      tool('propose_items', 'Show the owner a list of new items (e.g. split from a retro) as a card they can edit and create.', {
        source_id: z.number().int().nullable().describe('Source the items come from, if any'),
        items: z.array(z.object(itemShape)).min(1),
      }, async (p) => call(rpc, 'propose')({ type: 'items', ...p })),
    );
  }
  return createSdkMcpServer({ name: 'dispatch', version: '1.0.0', tools });
}
