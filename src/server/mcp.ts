// The tracker as an MCP server for Claude on any machine (/mcp, OAuth bearer tokens). Tracker tools
// only: read and edit projects' items, comments, sources and images. Nothing here starts agents,
// merges or changes settings. Changes are signed "claude" and reach the app live like any other.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ITEM_STATUSES, type Item, type Project } from '../shared/types.ts';
import type { Principal } from './access.ts';
import type { Attachments } from './attachments.ts';
import type { Bus } from './bus.ts';
import type { OAuth } from './oauth.ts';
import { labelReleased } from './releases.ts';
import type { Store } from './store.ts';

const OPEN = ['triage', 'backlog', 'todo', 'in_progress', 'in_review'];
const AUTHOR = 'claude';

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const failure = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true });

export function trackerTools(store: Store, bus: Bus, attachments: Attachments | null, who: Principal, rules: (p: Project) => Promise<string> = async () => ''): McpServer {
  const server = new McpServer({ name: 'dispatch', version: '1.0.0' });
  const canWrite = who.scopes.has('tracker');
  const guard = <A,>(write: boolean, fn: (a: A) => unknown) => async (a: A) => {
    try {
      if (write && !canWrite) throw new Error('This connection may only read (no "tracker" scope).');
      return (await fn(a)) as ReturnType<typeof text>;
    } catch (e) {
      return failure(e);
    }
  };
  const project = (key: string): Project => {
    const p = store.projectByKey(key.toUpperCase());
    if (!p) throw new Error(`No project ${key}. list_projects shows the keys.`);
    return p;
  };
  const item = (key: string): Item => {
    const [pk, n] = key.toUpperCase().split(/-(?=\d+$)/);
    const it = n ? store.itemByNumber(project(pk).id, Number(n)) : undefined;
    if (!it) throw new Error(`No item ${key}`);
    return it;
  };
  const scaled = (p: Project, field: 'importance' | 'effort', v: number | string | null | undefined) => {
    if (v === undefined) return undefined;
    if (v === null || v === '' || v === '-') return field === 'effort' ? null : undefined;
    const scale = field === 'importance' ? p.importance_scale : p.effort_scale;
    const byLabel = scale.findIndex((l) => l.toLowerCase() === String(v).toLowerCase());
    if (byLabel >= 0) return field === 'importance' ? byLabel + 1 : byLabel;
    const n = Number(v);
    if (field === 'importance' && Number.isInteger(n) && n >= 1 && n <= 4) return n;
    if (field === 'effort' && Number.isInteger(n) && n >= 0 && n < scale.length) return n;
    throw new Error(`${field} "${v}" is not on the project's scale: ${scale.join(', ')}`);
  };
  const brief = (p: Project, i: Item) => ({
    key: i.key, title: i.title, type: i.type, status: i.status,
    importance: p.importance_scale[i.importance - 1], effort: i.effort === null ? null : p.effort_scale[i.effort],
    tags: i.labels, modules: i.modules,
  });
  const emit = (it: Item) => bus.emit({ t: 'item', item: it });
  const label = z.union([z.number(), z.string()]);

  server.registerTool('list_projects', { description: 'Projects in the tracker: key, name, scales, counts.' }, guard(false, () =>
    text(store.projects().map((p) => ({ key: p.key, name: p.name, description: p.description, importance_scale: p.importance_scale, effort_scale: p.effort_scale }))),
  ));

  server.registerTool('list_items', {
    description: 'Items of a project. Default: open ones (not hold, done or canceled). Filter by status, type, tag, module or words.',
    inputSchema: {
      project: z.string().describe('Project key, e.g. HC'),
      status: z.array(z.enum(ITEM_STATUSES)).optional(),
      all: z.boolean().optional().describe('Every status'),
      type: z.enum(['backlog', 'bug']).optional(),
      tag: z.string().optional(),
      module: z.string().optional(),
      query: z.string().optional().describe('Words that must all appear in key, title, description, tags or modules'),
    },
  }, guard(false, (a: { project: string; status?: string[]; all?: boolean; type?: string; tag?: string; module?: string; query?: string }) => {
    const p = project(a.project);
    let items = store.items(p.id, { type: a.type, status: a.all ? undefined : a.status ?? OPEN });
    const low = (xs: string[]) => xs.map((x) => x.toLowerCase());
    if (a.tag) items = items.filter((i) => low(i.labels).includes(a.tag!.toLowerCase()));
    if (a.module) items = items.filter((i) => low(i.modules).includes(a.module!.toLowerCase()));
    if (a.query) {
      const words = a.query.toLowerCase().split(/\s+/).filter(Boolean);
      items = items.filter((i) => words.every((w) => [i.key, i.title, i.body_md, ...i.labels, ...i.modules].join(' ').toLowerCase().includes(w)));
    }
    return text(items.map((i) => brief(p, i)));
  }));

  server.registerTool('get_item', {
    description: 'One item in full: description, comments, image list, source.',
    inputSchema: { key: z.string().describe('e.g. HC-42') },
  }, guard(false, (a: { key: string }) => {
    const it = item(a.key);
    const p = store.project(it.project_id)!;
    return text({
      ...brief(p, it), description: it.body_md,
      comments: store.comments(it.id).map((c) => ({ author: c.author, at: c.created_at, text: c.body_md })),
      images: store.itemImages(it.id).map((i) => ({ id: i.id, name: i.name, author: i.author, on_comment: i.comment_id })),
      source: it.source_id ? store.source(it.source_id) : null,
    });
  }));

  server.registerTool('view_image', {
    description: 'Look at an image on an item (ids from get_item).',
    inputSchema: { id: z.number().int() },
  }, async (a: { id: number }) => {
    try {
      const img = store.itemImage(a.id);
      const data = img && attachments ? await attachments.readItemImage(img.item_id, img.file) : null;
      if (!img || !data) throw new Error(`No image ${a.id}`);
      return { content: [{ type: 'text' as const, text: img.name }, { type: 'image' as const, data: data.toString('base64'), mimeType: img.mime }] };
    } catch (e) {
      return failure(e);
    }
  });

  server.registerTool('project_facets', {
    description: 'Tags and modules in use in a project, with counts. Reuse these before inventing new ones.',
    inputSchema: { project: z.string() },
  }, guard(false, (a: { project: string }) => text(store.facets(project(a.project).id))));

  server.registerTool('project_instructions', {
    description: "The project's own instructions for agents (CLAUDE.md, AGENTS.md of its repos). Read them before filing items: their rules on item type, ids, fields and naming win over this tool's defaults.",
    inputSchema: { project: z.string() },
  }, guard(false, async (a: { project: string }) => text((await rules(project(a.project))) || 'This project has no instructions of its own.')));

  server.registerTool('add_item', {
    description: "File a new backlog item or bug. Look for duplicates first (list_items with query). Read project_instructions first: the project's own rules (type, ids, fields) win over the defaults here.",
    inputSchema: {
      project: z.string(),
      title: z.string().min(1).max(200),
      type: z.enum(['backlog', 'bug']).default('backlog'),
      description: z.string().default('').describe('Markdown: context, what is wrong or wanted, how to know it is done'),
      importance: label.optional().describe('1-4 or a label of the project importance scale'),
      effort: label.nullable().optional().describe('A label of the project effort scale'),
      tags: z.array(z.string()).default([]),
      modules: z.array(z.string()).default([]),
      status: z.enum(ITEM_STATUSES).optional(),
      source_id: z.number().int().nullable().optional(),
    },
  }, guard(true, (a: { project: string; title: string; type: 'backlog' | 'bug'; description: string; importance?: number | string; effort?: number | string | null; tags: string[]; modules: string[]; status?: Item['status']; source_id?: number | null }) => {
    const p = project(a.project);
    const it = store.createItem(p.id, {
      type: a.type, title: a.title, body_md: a.description, status: a.status ?? (a.type === 'bug' ? 'triage' : 'backlog'),
      importance: scaled(p, 'importance', a.importance) ?? 2, effort: scaled(p, 'effort', a.effort) ?? null,
      source_id: a.source_id ?? null, labels: a.tags, modules: a.modules,
    });
    emit(it);
    return text({ created: it.key });
  }));

  server.registerTool('update_item', {
    description: 'Change an item. description replaces the whole text: read it first and keep what is still true. add_tags / remove_tags edit the list.',
    inputSchema: {
      key: z.string(),
      title: z.string().min(1).max(200).optional(),
      description: z.string().optional(),
      type: z.enum(['backlog', 'bug']).optional(),
      status: z.enum(ITEM_STATUSES).optional(),
      importance: label.optional(),
      effort: label.nullable().optional(),
      tags: z.array(z.string()).optional(),
      add_tags: z.array(z.string()).optional(),
      remove_tags: z.array(z.string()).optional(),
      modules: z.array(z.string()).optional(),
    },
  }, guard(true, (a: { key: string; title?: string; description?: string; type?: 'backlog' | 'bug'; status?: Item['status']; importance?: number | string; effort?: number | string | null; tags?: string[]; add_tags?: string[]; remove_tags?: string[]; modules?: string[] }) => {
    const it = item(a.key);
    const p = store.project(it.project_id)!;
    let labels = a.tags ?? it.labels;
    if (a.add_tags || a.remove_tags) {
      const drop = (a.remove_tags ?? []).map((t) => t.toLowerCase());
      labels = labels.filter((t) => !drop.includes(t.toLowerCase()));
      for (const t of a.add_tags ?? []) if (!labels.some((x) => x.toLowerCase() === t.toLowerCase())) labels.push(t);
    }
    const patch: Partial<Item> = {};
    if (a.title !== undefined) patch.title = a.title;
    if (a.description !== undefined) patch.body_md = a.description;
    if (a.type !== undefined) patch.type = a.type;
    if (a.status !== undefined) patch.status = a.status;
    const imp = scaled(p, 'importance', a.importance);
    if (typeof imp === 'number') patch.importance = imp;
    const eff = scaled(p, 'effort', a.effort);
    if (eff !== undefined) patch.effort = eff;
    if (a.tags || a.add_tags || a.remove_tags) patch.labels = labels;
    if (a.modules !== undefined) patch.modules = a.modules;
    if (!Object.keys(patch).length) throw new Error('Nothing to change');
    const up = store.updateItem(it.id, patch);
    emit(up);
    return text(brief(p, up));
  }));

  server.registerTool('add_comment', {
    description: 'Comment on an item: findings, decisions, what changed (with commit or branch).',
    inputSchema: { key: z.string(), text: z.string().min(1) },
  }, guard(true, (a: { key: string; text: string }) => {
    const it = item(a.key);
    store.addComment(it.id, AUTHOR, a.text);
    emit(store.item(it.id)!);
    return text(`Commented on ${it.key}`);
  }));

  server.registerTool('add_source', {
    description: 'Keep a retro or report as a source (full text). Items filed with its source_id link back to it.',
    inputSchema: {
      project: z.string(),
      title: z.string().min(1),
      kind: z.enum(['retro', 'skill_run', 'user_report', 'manual']).default('manual'),
      text: z.string().default(''),
      reporter: z.string().nullable().optional(),
      version_tag: z.string().nullable().optional(),
      skill_name: z.string().nullable().optional(),
    },
  }, guard(true, (a: { project: string; title: string; kind: 'retro' | 'skill_run' | 'user_report' | 'manual'; text: string; reporter?: string | null; version_tag?: string | null; skill_name?: string | null }) => {
    const s = store.createSource(project(a.project).id, { kind: a.kind, title: a.title, body_md: a.text, reporter: a.reporter ?? null, version_tag: a.version_tag ?? null, skill_name: a.skill_name ?? null });
    return text({ source_id: s.id });
  }));

  server.registerTool('get_source', {
    description: 'A source (retro, report) and the items split from it.',
    inputSchema: { id: z.number().int() },
  }, guard(false, (a: { id: number }) => {
    const s = store.source(a.id);
    if (!s) throw new Error(`No source ${a.id}`);
    const p = store.project(s.project_id)!;
    return text({ ...s, items: store.items(p.id, { source_id: s.id }).map((i) => brief(p, i)) });
  }));

  server.registerTool('release_items', {
    description: 'Label done items with a release (e.g. rel:v1.4.0) after the changelog is written. Without keys: every done item not yet in a release.',
    inputSchema: { project: z.string(), version: z.string().min(1), keys: z.array(z.string()).optional(), prefix: z.string().default('rel:') },
  }, guard(true, (a: { project: string; version: string; keys?: string[]; prefix: string }) => {
    const p = project(a.project);
    const targets = labelReleased(store, p.id, a.prefix, a.version, a.keys?.map(item), emit);
    return text({ released: targets.map((i) => i.key), label: `${a.prefix}${a.version}` });
  }));

  return server;
}

/** /mcp: Streamable HTTP, stateless (a fresh server per request), OAuth bearer tokens only. */
export function mcpRoutes(app: FastifyInstance, deps: { store: Store; bus: Bus; attachments: Attachments | null; oauth: OAuth; publicUrl: string; rules?: (p: Project) => Promise<string> }) {
  const handle = async (req: FastifyRequest, reply: FastifyReply) => {
    const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const who = bearer ? deps.oauth.verify(bearer) : null;
    if (!who) {
      const meta = `${deps.publicUrl.replace(/\/$/, '')}/.well-known/oauth-protected-resource/mcp`;
      return reply.status(401).header('www-authenticate', `Bearer resource_metadata="${meta}"`).send({ error: 'invalid_token' });
    }
    const server = trackerTools(deps.store, deps.bus, deps.attachments, who, deps.rules);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post('/mcp', handle);
  app.get('/mcp', async (_req, reply) => reply.status(405).header('allow', 'POST').send({ error: 'Use POST (stateless server)' }));
  app.delete('/mcp', async (_req, reply) => reply.status(405).header('allow', 'POST').send({ error: 'Stateless server: nothing to end' }));
}
