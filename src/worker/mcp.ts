// The in-process `dispatch` MCP server: tracker tools for the agent, backed by server RPC.
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'node:fs';
import { readFile as readBytes, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { MAX_IMAGE_BYTES, sniffImage } from '../shared/chatImages.ts';
import { groupCounts, parseSections } from '../shared/markdownSections.ts';
import type { RpcMethod } from '../shared/protocol.ts';
import { crossProjectSummary, type CrossProjectRequest, type SessionKind } from '../shared/types.ts';

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

const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const MAX_MB = MAX_IMAGE_BYTES / (1024 * 1024);

/**
 * An image file in the session's checkout, read for attach_image (DISP-74). Only a file inside
 * the checkout (also after following symlinks), a PNG, JPEG, GIF or WebP by its content, and no
 * larger than a pasted image. Each refusal says which rule failed and what to do.
 */
export async function checkoutImage(cwd: string, path: string): Promise<{ path: string; data: Buffer; mime: string }> {
  const root = await realpath(cwd);
  const asked = resolve(root, path);
  const rel = relative(root, asked);
  if (!path.trim() || !inside(root, asked) || isAbsolute(rel)) throw new Error(`${path} is outside the session checkout. Save the image inside the checkout and give its path from the checkout root, e.g. screenshots/shot.png.`);
  let real: string;
  try {
    real = await realpath(asked);
  } catch {
    throw new Error(`File not found: ${rel} is not in the session checkout. Check the path; give it from the checkout root, e.g. screenshots/shot.png.`);
  }
  if (!inside(root, real)) throw new Error(`${rel} is a symlink to a file outside the session checkout. Copy the image into the checkout and attach the copy.`);
  const st = await stat(real);
  if (!st.isFile()) throw new Error(`File not found: ${rel} is not a file. Give the path of the image file.`);
  if (st.size > MAX_IMAGE_BYTES) throw new Error(`${rel} is too large: ${(st.size / (1024 * 1024)).toFixed(1)} MB, and the limit is ${MAX_MB} MB. Save a smaller image (lower resolution, or JPEG/WebP) and attach that.`);
  const data = await readBytes(real);
  const mime = sniffImage(data);
  if (!mime) throw new Error(`${rel} is not an image: only PNG, JPEG, GIF and WebP files can be attached. Save it in one of these formats and attach that.`);
  return { path: rel.split(sep).join('/'), data, mime };
}

/**
 * Images go onto an item: one the agent created or changes. Either one the owner pasted into this
 * chat (DISP-34), or an image file the session made in its checkout (DISP-74), which the worker
 * reads and checks here and sends to the server.
 */
export const attachImage = (rpc: Rpc, cwd?: string) =>
  tool('attach_image', `Attach an image to an item, e.g. a screenshot for a bug you filed or an item you changed. The image is either one the owner pasted into this chat: give \`image\`, the file in its "[pasted image <file>]" marker; or an image file in your session checkout, e.g. a screenshot, rendered slide or chart you saved: give \`path\`, relative to the checkout root (PNG, JPEG, GIF or WebP, at most ${MAX_MB} MB, inside the checkout). Give one of the two. Attach only when the owner asks, or when the image documents the item.`, {
    key: z.string().describe('Item key, e.g. HC-42'),
    image: z.string().optional().describe('A pasted image: the file from its marker, e.g. 3f2c…-….png'),
    path: z.string().optional().describe('An image file in the session checkout, relative to its root, e.g. .superpowers/screenshots/hc-42.png'),
    name: z.string().optional().describe('File name to show on the item, e.g. "login-error.png"'),
    comment_id: z.number().int().optional().describe('Put it on this comment of the item (id from add_comment or get_item)'),
  }, async (p) => {
    if (!p.path) return call(rpc, 'attach_image')(p);
    try {
      if (p.image) throw new Error('Give either image (a pasted image) or path (a file in the checkout), not both.');
      if (!cwd) throw new Error('This session has no checkout to attach a file from. Attach a pasted image with image instead.');
      const img = await checkoutImage(cwd, p.path);
      const { path: _p, ...rest } = p;
      return ok(await rpc('attach_image', { ...rest, path: img.path, data: img.data.toString('base64') }));
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

const assistantTools = (rpc: Rpc, readFile: (path: string) => Promise<string>, list: ListFolder, cwd?: string): SdkMcpToolDefinition<any>[] => {
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
    tool('get_item', 'Read one item (any project) with its description, comments and image list.', { key: z.string().describe('e.g. HC-42') }, call(rpc, 'get_item')),
    viewImage(rpc),
    tool('add_comment', 'Add a comment (markdown) to an item in any project.', { key: z.string().describe('e.g. HC-42'), body: z.string() }, call(rpc, 'add_comment')),
    attachImage(rpc, cwd),
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

/** Ask the owner to approve one cross-project request: the input's local id when approved, null when not. */
export type AskCrossProject = (req: CrossProjectRequest & { reason?: string }) => Promise<{ approved: boolean; local_id: string } | null>;

/**
 * Planner and discussion chats reach other projects (DISP-55). Every call waits for the owner's
 * approval of exactly this request; the server checks that approval again before it runs.
 * A denial comes back as the tool result, and nothing from the other project is read or written.
 */
export function crossProjectTools(rpc: Rpc, ownKey: string, ask: AskCrossProject): SdkMcpToolDefinition<any>[] {
  const run = async (req: CrossProjectRequest, reason?: string) => {
    try {
      req.project_key = req.project_key.trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9]*$/.test(req.project_key)) throw new Error(`"${req.project_key}" is not a project key`);
      if (req.project_key === ownKey.toUpperCase()) throw new Error(`${ownKey} is this chat's own project: use list_items and get_item, which need no approval.`);
      const answer = await ask({ ...req, ...(reason?.trim() ? { reason: reason.trim() } : {}) });
      if (!answer) return ok(`The request was cancelled: ${crossProjectSummary(req)}. Nothing was read or written.`);
      if (!answer.approved) return ok(`The owner denied this request: ${crossProjectSummary(req)}. Nothing from project ${req.project_key} was read or written. Do not ask again for the same thing unless the owner asks you to.`);
      return ok(await rpc('cross_project', { ...req, approval: answer.local_id }));
    } catch (e) {
      return fail(e);
    }
  };
  const itemKey = z.string().describe('Item key in the other project, e.g. HC-42');
  const reason = z.string().describe('One line for the owner: why you need this');
  const projectOf = (key: string) => key.trim().toUpperCase().split('-')[0];
  return [
    tool('search_other_project', `Search the items of ANOTHER project (not ${ownKey}) for words in their key, title, description or tags. The owner must approve the query first; nothing runs until they do. Returns matching items with a short excerpt.`, {
      project_key: z.string().describe('Key of the other project, e.g. HC'),
      query: z.string().min(1).describe('Words to look for; "a quoted phrase" is one word'),
      reason,
    }, async (p) => run({ action: 'search', project_key: p.project_key, query: p.query.trim() }, p.reason)),
    tool('read_other_item', `Read one item of ANOTHER project (not ${ownKey}) with its description and comments. The owner must approve it first.`, {
      key: itemKey,
      reason,
    }, async (p) => run({ action: 'read', project_key: projectOf(p.key), key: p.key.trim().toUpperCase() }, p.reason)),
    tool('comment_on_other_item', `Add a comment to an item of ANOTHER project (not ${ownKey}), e.g. to link it to an item here ("Related: ${ownKey}-12 …"). The owner sees the exact text and must approve it; it is written only then.`, {
      key: itemKey,
      body: z.string().min(1).describe('The comment (markdown), exactly as it will be added'),
      reason,
    }, async (p) => run({ action: 'comment', project_key: projectOf(p.key), key: p.key.trim().toUpperCase(), body: p.body }, p.reason)),
  ];
}

const noFiles = async () => {
  throw new Error('File reading is not available here');
};

/**
 * `scheduled`: a scheduled planner run (DISP-13), which starts batches and changes items itself.
 * `cross`: planner (not scheduled: nobody is there to approve) and discussion chats get the
 * cross-project tools (DISP-55). `cwd`: the session checkout, where attach_image may take files from (DISP-74).
 */
export function dispatchMcp(kind: SessionKind, rpc: Rpc, readFile: (path: string) => Promise<string> = noFiles, list: ListFolder = noFiles, scheduled = false, cross?: { ownKey: string; ask: AskCrossProject }, cwd?: string) {
  const crossTools = cross && !scheduled && (kind === 'planner' || kind === 'discuss') ? crossProjectTools(rpc, cross.ownKey, cross.ask) : [];
  if (kind === 'assistant') return createSdkMcpServer({ name: 'dispatch', version: '1.0.0', tools: assistantTools(rpc, readFile, list, cwd) });
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
        ...crossTools,
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
  if (kind !== 'release') tools.push(attachImage(rpc, cwd));
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
  } else if (scheduled) {
    tools.push(
      tool('propose_batch', 'Start a batch now (this is a scheduled run: nobody approves it). A batch = one session, one branch, one PR. The answer says whether it started.', {
        title: z.string().describe('Short name for the batch'),
        item_ids: z.array(z.number().int()).describe('Numeric ids (from list_items) of existing items in the batch'),
        new_items: z.array(z.object(itemShape)).default([]).describe('New items to create as part of the batch'),
        prompt: z.string().describe('Extra instructions for the session that will do the work'),
        force_plan: z.boolean().default(false).describe('True if the work needs a written plan, approved by the owner, before code'),
        worker: z.string().optional().describe('Name of the worker to run it on (see "Where work runs" in your instructions)'),
        worker_reason: z.string().optional().describe('One line: why that worker'),
      }, async (p) => call(rpc, 'propose')({ type: 'batch', ...p })),
      tool('update_item', 'Change an item now, e.g. to triage it: give only the fields that change, and a comment that says why. You cannot take an item off hold or close it.', {
        key: z.string().describe('Item key, e.g. HC-42'),
        item_type: z.enum(['backlog', 'bug']).optional(),
        status: z.enum(['triage', 'backlog', 'todo', 'hold', 'canceled']).optional(),
        importance: z.union([z.number(), z.string()]).optional().describe('1-4 or a label of the project importance scale'),
        effort: z.union([z.number(), z.string()]).nullable().optional().describe('A label of the project effort scale, or null'),
        tags: z.array(z.string()).optional().describe('The full new tag list; reuse existing tags'),
        modules: z.array(z.string()).optional().describe('The full new module list'),
        comment: z.string().optional().describe('A comment to add (markdown): why you changed it'),
      }, call(rpc, 'update_item')),
      tool('create_item', 'File a new backlog item or bug you found. It is not started unless you put it in a batch.', itemShape, call(rpc, 'create_item')),
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
  tools.push(...crossTools);
  return createSdkMcpServer({ name: 'dispatch', version: '1.0.0', tools });
}
