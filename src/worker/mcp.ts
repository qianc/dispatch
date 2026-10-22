// The in-process `dispatch` MCP server: tracker tools for the agent, backed by server RPC.
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
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

/** An item image as an image block, so Claude sees it (the server sends it base64). */
const viewImage = (rpc: Rpc) =>
  tool('view_image', 'Look at an image attached to an item (ids from get_item → images).', { id: z.number().int() }, async ({ id }) => {
    try {
      const img = (await rpc('get_image', { id })) as { name: string; mime: string; data: string };
      return { content: [{ type: 'text' as const, text: img.name }, { type: 'image' as const, data: img.data, mimeType: img.mime }] };
    } catch (e) {
      return fail(e);
    }
  });

const itemShape = {
  type: z.enum(['backlog', 'bug']).describe('bug = defect, backlog = improvement or feature'),
  title: z.string().describe('Short title, max 200 chars'),
  body_md: z.string().describe('Markdown description with context'),
  importance: z.number().int().min(1).max(4).describe('1–4, see the project importance scale'),
  effort: z.number().int().min(0).nullable().describe('Index into the project effort scale, or null if unknown'),
};

export interface FolderEntry { name: string; path: string; type: 'folder' | 'file'; git_repo?: true }

const MAX_ENTRIES = 500;

/**
 * One level of a folder: its folders (marked when they are git repos) and files, by name.
 * Glob only matches files, so the assistant needs this to find a project folder by name.
 */
export async function listFolder(dir: string, name?: string): Promise<{ path: string; entries: FolderEntry[]; more?: number }> {
  const want = name?.toLowerCase();
  const all = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => !e.name.startsWith('.') && (!want || e.name.toLowerCase().includes(want)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const entries = await Promise.all(all.slice(0, MAX_ENTRIES).map(async (e): Promise<FolderEntry> => {
    const path = join(dir, e.name);
    // follow symlinks: a linked project folder is still a folder
    const folder = e.isDirectory() || (e.isSymbolicLink() && (await stat(path).then((st) => st.isDirectory(), () => false)));
    if (!folder) return { name: e.name, path, type: 'file' };
    return existsSync(join(path, '.git')) ? { name: e.name, path, type: 'folder', git_repo: true } : { name: e.name, path, type: 'folder' };
  }));
  return all.length > MAX_ENTRIES ? { path: dir, entries, more: all.length - MAX_ENTRIES } : { path: dir, entries };
}

type ListFolder = (path: string, name?: string) => ReturnType<typeof listFolder>;

const assistantTools = (rpc: Rpc, readFile: (path: string) => Promise<string>, list: ListFolder): SdkMcpToolDefinition<any>[] => {
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
    tool('list_folder', 'List the folders and files directly in a folder (one level, not recursive), e.g. ~/projects. Folders that are git repos are marked git_repo. Use it to find a project folder by name: Glob matches only files, never folders.', {
      path: z.string().describe('Folder path, e.g. ~/projects'),
      name: z.string().optional().describe('Only entries whose name contains this text (any case), e.g. "dispatch"'),
    }, async (p) => {
      try {
        return ok(await list(p.path, p.name));
      } catch (e) {
        return fail(e);
      }
    }),
    tool('add_repo', 'Add a repo to a project: a GitHub repo (verified, default branch looked up), or a local git folder on this machine (absolute or ~/ path, e.g. the path list_folder gives; must be inside LOCAL_REPO_DIRS). Agents push their branches into a local repo and the owner reviews and merges them in Dispatch.', {
      project_key: z.string(),
      repo: z.string().describe('owner/name, a github.com URL, or a local path like ~/projects/x'),
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
      status: z.string().optional().describe('Status for the items, e.g. canceled for a "won\'t fix" group, hold for parked work'),
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

export function dispatchMcp(kind: SessionKind, rpc: Rpc, readFile: (path: string) => Promise<string> = noFiles, list: ListFolder = noFiles) {
  if (kind === 'assistant') return createSdkMcpServer({ name: 'dispatch', version: '1.0.0', tools: assistantTools(rpc, readFile, list) });
  if (kind === 'discuss') {
    return createSdkMcpServer({
      name: 'dispatch',
      version: '1.0.0',
      tools: [
        tool('get_item', 'Read one item with its description, comments, source and image list.', { key: z.string().describe('e.g. HC-42') }, call(rpc, 'get_item')),
        viewImage(rpc),
        tool('list_items', 'List open items in this project.', { status: z.array(z.string()).optional(), type: z.enum(['backlog', 'bug']).optional() }, call(rpc, 'list_items')),
        tool(
          'propose_item_update',
          'Suggest a change to an item: its fields and/or a new comment. The owner sees a card with the old and new values and applies it or not; nothing changes until they do. Use it when the owner asks to add or change something on an item. Give only the fields that change. body_md replaces the whole description: start from the current text (get_item) and keep what is still true.',
          {
            key: z.string().describe('Item key, e.g. HC-42'),
            title: z.string().optional(),
            body_md: z.string().optional().describe('The full new description (markdown)'),
            item_type: z.enum(['backlog', 'bug']).optional(),
            status: z.enum(['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'hold', 'done', 'canceled']).optional(),
            importance: z.union([z.number(), z.string()]).optional().describe('1-4 or a label of the project importance scale'),
            effort: z.union([z.number(), z.string()]).nullable().optional().describe('A label of the project effort scale, or null'),
            tags: z.array(z.string()).optional().describe('The full new tag list; reuse existing tags'),
            modules: z.array(z.string()).optional().describe('The full new module list'),
            comment: z.string().optional().describe('A comment to add (markdown), e.g. a design note from this discussion'),
            reason: z.string().optional().describe('One line on why, shown on the card'),
          },
          async (p) => call(rpc, 'propose')({ type: 'item_update', ...p }),
        ),
      ],
    });
  }
  const tools: SdkMcpToolDefinition<any>[] = [
    tool('list_items', 'List open tracker items in this project (key, title, type, status, importance, effort).', {
      status: z.array(z.string()).optional().describe('Filter by status; default: all open statuses (not hold, done or canceled)'),
      type: z.enum(['backlog', 'bug']).optional(),
    }, call(rpc, 'list_items')),
    tool('get_item', 'Read one item with its description, comments, source (retro/report) and image list.', {
      key: z.string().describe('Item key, e.g. HC-42'),
    }, call(rpc, 'get_item')),
    viewImage(rpc),
    tool('add_comment', 'Add a comment to an item.', {
      key: z.string(),
      body: z.string(),
    }, call(rpc, 'add_comment')),
  ];
  if (kind === 'release') {
    tools.push(
      tool('release_items', 'Label these items as released, with the version of this release. Call it only after the release succeeded (the release command exited 0, and the commit and tag are pushed); never after a failure.', {
        keys: z.array(z.string()).min(1).describe('Keys of the done items in this release, e.g. ["HC-3"]'),
      }, call(rpc, 'release_items')),
    );
  } else if (kind === 'work') {
    tools.push(
      tool('add_to_batch', 'Add existing items to this batch when the owner asks you to also work on them (e.g. "also look at 100"). Dispatch then tracks them with this session and closes them when the branch merges.', {
        keys: z.array(z.string()).min(1).describe('Item keys, e.g. ["HC-3"]'),
      }, call(rpc, 'add_to_batch')),
      tool('create_item', 'File a new backlog item or bug you found that is outside this batch. It is linked to this session.', itemShape, call(rpc, 'create_item')),
    );
  } else {
    tools.push(
      tool('propose_batch', 'Show the owner a proposed batch as a card they can edit and start. A batch = one session, one branch, one PR.', {
        title: z.string().describe('Short name for the batch'),
        item_ids: z.array(z.number().int()).describe('Numeric ids (from list_items) of existing items in the batch'),
        new_items: z.array(z.object(itemShape)).default([]).describe('New items to create as part of the batch'),
        prompt: z.string().describe('Extra instructions for the session that will do the work'),
        force_plan: z.boolean().default(false).describe('True if the work needs a written plan before code'),
        worker: z.string().optional().describe('Name of the worker to run it on (see "Where work runs" in your instructions)'),
        worker_reason: z.string().optional().describe('One line: why that worker'),
      }, async (p) => call(rpc, 'propose')({ type: 'batch', ...p })),
      tool('propose_items', 'Show the owner a list of new items (e.g. split from a retro) as a card they can edit and create.', {
        source_id: z.number().int().nullable().describe('Source the items come from, if any'),
        items: z.array(z.object(itemShape)).min(1),
      }, async (p) => call(rpc, 'propose')({ type: 'items', ...p })),
    );
  }
  return createSdkMcpServer({ name: 'dispatch', version: '1.0.0', tools });
}
