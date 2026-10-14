// Tools for the assistant chat: manage projects, repos, items and sources across the whole app.
// Creating and changing things happens at once; starting agent sessions goes through a proposal card.
import { z } from 'zod';
import { detectScales, type MdSection } from '../shared/markdownSections.ts';
import { DEFAULT_EFFORT_SCALE, DEFAULT_IMPORTANCE_SCALE, ITEM_STATUSES, SOURCE_KINDS, tagList, type Project, type Session } from '../shared/types.ts';
import type { Bus } from './bus.ts';
import type { GitHub } from './github.ts';
import type { Sessions } from './sessions.ts';
import type { Store } from './store.ts';

/** "https://github.com/o/r(.git)", "git@github.com:o/r.git", "github.com/o/r" or "o/r" → { owner, name } */
export function parseRepo(input: string): { owner: string; name: string } {
  const m = input.trim().match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`Not a GitHub repo: ${input}. Use owner/name or a github.com URL.`);
  return { owner: m[1], name: m[2] };
}

/** A free project key from a name: "Deck builder" → "DB", "Decks" → "DECKS"; adds digits if taken. */
export function suggestKey(name: string, taken: (k: string) => boolean): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  let base = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? 'P').slice(0, 5);
  if (!/^[A-Z]/.test(base)) base = `P${base}`;
  base = base.slice(0, 8).padEnd(2, 'X');
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}${i}`)) return `${base}${i}`;
}

export class AssistantTools {
  private store: Store;
  private bus: Bus;
  private github: GitHub;
  private sessions: Sessions;

  constructor(store: Store, bus: Bus, github: GitHub, sessions: Sessions) {
    this.store = store;
    this.bus = bus;
    this.github = github;
    this.sessions = sessions;
  }

  private project(key: unknown): Project {
    const p = this.store.projectByKey(String(key ?? ''));
    if (!p) throw new Error(`No project with key ${String(key)}. Use list_projects to see keys.`);
    return p;
  }

  /** Importance as 1–4 or one of the project's labels. */
  private importance(p: Project, v: unknown): number {
    if (v === undefined || v === null || v === '') return 2;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 4) return n;
    const i = p.importance_scale.findIndex((l) => l.toLowerCase() === String(v).toLowerCase());
    if (i < 0) throw new Error(`Importance "${String(v)}" is not one of ${p.importance_scale.join(', ')} (or 1–4)`);
    return i + 1;
  }

  /** Effort as one of the project's labels, or an index into the scale. */
  private effort(p: Project, v: unknown): number | null {
    if (v === undefined || v === null || v === '') return null;
    const i = p.effort_scale.findIndex((l) => l.toLowerCase() === String(v).toLowerCase());
    if (i >= 0) return i;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n < p.effort_scale.length) return n;
    throw new Error(`Effort "${String(v)}" is not one of ${p.effort_scale.join(', ')}`);
  }

  private item(key: unknown) {
    const [pk, n] = String(key ?? '').toUpperCase().split(/-(?=\d+$)/);
    const it = this.store.itemByNumber(this.project(pk).id, Number(n));
    if (!it) throw new Error(`No item ${String(key)}`);
    return it;
  }

  async inspectRepo(input: string) {
    const { owner, name } = parseRepo(input);
    if (!this.github.octo) return { owner, name, verified: false, note: 'No GitHub token: could not check the repo. Assume branch "main" unless the user says otherwise.' };
    try {
      const { data } = await this.github.octo.repos.get({ owner, repo: name });
      return { owner: data.owner.login, name: data.name, verified: true, default_branch: data.default_branch, description: data.description, private: data.private, url: data.html_url };
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) throw new Error(`GitHub repo ${owner}/${name} not found, or the token cannot see it.`);
      throw e;
    }
  }

  private projectSummary(p: Project) {
    const open = this.store.items(p.id, { status: ['triage', 'backlog', 'todo', 'in_progress', 'in_review'] });
    return {
      key: p.key, name: p.name, description: p.description, link: `/p/${p.key}`,
      repos: this.store.repos(p.id).map((r) => `${r.github_owner}/${r.github_name} (${r.default_branch})`),
      importance_scale: p.importance_scale, effort_scale: p.effort_scale, plan_first_default: p.default_force_plan,
      open_backlog: open.filter((i) => i.type === 'backlog').length, open_bugs: open.filter((i) => i.type === 'bug').length,
    };
  }

  async call(s: Session, method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'inspect_github_repo':
        return this.inspectRepo(String(p.repo ?? ''));

      case 'list_projects':
        return this.store.projects().map((x) => ({ ...this.projectSummary(x), ...this.store.facets(x.id) }));

      case 'create_project': {
        const input = z.object({
          name: z.string().min(1),
          key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/).optional(),
          description: z.string().default(''),
          importance_scale: z.array(z.string().min(1)).length(4).default(DEFAULT_IMPORTANCE_SCALE),
          effort_scale: z.array(z.string().min(1)).min(2).max(10).default(DEFAULT_EFFORT_SCALE),
          default_force_plan: z.boolean().default(false),
          repos: z.array(z.string()).default([]),
        }).parse(p);
        const key = input.key ?? suggestKey(input.name, (k) => !!this.store.projectByKey(k));
        if (this.store.projectByKey(key)) throw new Error(`Key ${key} is taken; pick another.`);
        const project = this.store.createProject({ ...input, key });
        const added = [];
        for (const r of input.repos) added.push(await this.addRepo(project, r, undefined, null));
        return { ...this.projectSummary(project), added_repos: added };
      }

      case 'update_project': {
        const project = this.project(p.key);
        const patch = z.object({
          name: z.string().min(1).optional(),
          description: z.string().optional(),
          importance_scale: z.array(z.string().min(1)).length(4).optional(),
          effort_scale: z.array(z.string().min(1)).min(2).max(10).optional(),
          default_force_plan: z.boolean().optional(),
        }).parse(p);
        return this.projectSummary(this.store.updateProject(project.id, patch));
      }

      case 'add_repo':
        return this.addRepo(this.project(p.project_key), String(p.repo ?? ''), p.default_branch ? String(p.default_branch) : undefined, p.check_command ? String(p.check_command) : null);

      case 'remove_repo': {
        const project = this.project(p.project_key);
        const { owner, name } = parseRepo(String(p.repo ?? ''));
        const repo = this.store.repos(project.id).find((r) => r.github_owner.toLowerCase() === owner.toLowerCase() && r.github_name.toLowerCase() === name.toLowerCase());
        if (!repo) throw new Error(`${owner}/${name} is not in ${project.key}`);
        this.store.deleteRepo(repo.id);
        return `Removed ${owner}/${name} from ${project.key}`;
      }

      case 'list_items': {
        const project = this.project(p.project_key);
        const status = Array.isArray(p.status) ? (p.status as string[]) : ['triage', 'backlog', 'todo', 'in_progress', 'in_review'];
        return this.store.items(project.id, { status, type: p.type ? String(p.type) : undefined }).map((i) => ({
          key: i.key, type: i.type, title: i.title, status: i.status,
          importance: project.importance_scale[i.importance - 1], effort: i.effort === null ? null : project.effort_scale[i.effort],
          tags: i.labels, modules: i.modules,
        }));
      }

      case 'create_items': {
        const project = this.project(p.project_key);
        const items = z.array(z.object({
          type: z.enum(['backlog', 'bug']).default('backlog'),
          title: z.string().min(1).max(200),
          body_md: z.string().default(''),
          importance: z.union([z.number(), z.string()]).optional(),
          effort: z.union([z.number(), z.string()]).nullable().optional(),
          tags: tagList.default([]),
          modules: tagList.default([]),
        })).min(1).parse(p.items);
        const sourceId = p.source_id ? Number(p.source_id) : null;
        if (sourceId && this.store.source(sourceId)?.project_id !== project.id) throw new Error(`Source ${sourceId} is not in ${project.key}`);
        const created = items.map((it) => {
          const item = this.store.createItem(project.id, {
            type: it.type, title: it.title, body_md: it.body_md, status: it.type === 'bug' ? 'triage' : 'backlog',
            importance: this.importance(project, it.importance), effort: this.effort(project, it.effort), source_id: sourceId,
            labels: it.tags, modules: it.modules,
          });
          this.bus.emit({ t: 'item', item });
          return { key: item.key, title: item.title, link: `/items/${item.id}` };
        });
        return created;
      }

      case 'update_item': {
        const it = this.item(p.key);
        const project = this.store.project(it.project_id)!;
        const patch: Parameters<Store['updateItem']>[1] = {};
        if (p.title) patch.title = String(p.title);
        if (p.body_md !== undefined) patch.body_md = String(p.body_md);
        if (p.status) {
          if (!(ITEM_STATUSES as readonly string[]).includes(String(p.status))) throw new Error(`Status must be one of ${ITEM_STATUSES.join(', ')}`);
          patch.status = p.status as never;
        }
        if (p.importance !== undefined) patch.importance = this.importance(project, p.importance);
        if (p.effort !== undefined) patch.effort = this.effort(project, p.effort);
        if (p.tags !== undefined) patch.labels = tagList.parse(p.tags);
        if (p.modules !== undefined) patch.modules = tagList.parse(p.modules);
        const updated = this.store.updateItem(it.id, patch);
        this.bus.emit({ t: 'item', item: updated });
        return { key: updated.key, status: updated.status };
      }

      case 'create_source': {
        const project = this.project(p.project_key);
        const input = z.object({
          kind: z.enum(SOURCE_KINDS).default('retro'),
          title: z.string().min(1),
          body_md: z.string().default(''),
          reporter: z.string().nullable().default(null),
          version_tag: z.string().nullable().default(null),
          skill_name: z.string().nullable().default(null),
        }).parse(p);
        const source = this.store.createSource(project.id, input);
        return { id: source.id, title: source.title, link: `/sources/${source.id}` };
      }

      case 'import_sections': {
        const project = this.project(p.project_key);
        const sections = p.sections as MdSection[];
        if (!Array.isArray(sections) || !sections.length) throw new Error('No sections to import');
        const src = p.source as { title: string; body_md: string; reporter?: string | null; version_tag?: string | null };
        // several imports from one file (e.g. one per group) share one source
        const source = this.store.sources(project.id).find((x) => x.title === src.title && x.body_md === src.body_md) ??
          this.store.createSource(project.id, {
            kind: 'manual', title: src.title, body_md: src.body_md, reporter: src.reporter ?? null, version_tag: src.version_tag ?? null, skill_name: null,
          });
        const type = p.type === 'bug' ? 'bug' : 'backlog';
        const status = (ITEM_STATUSES as readonly string[]).includes(String(p.status)) ? (p.status as never) : type === 'bug' ? 'triage' : 'backlog';
        let undetected = 0;
        const perImportance: Record<string, number> = {};
        const created = sections.map((sec) => {
          const { importance, effort } = detectScales(sec, project.importance_scale, project.effort_scale);
          if (importance === null) undetected++;
          const imp = importance ?? 2;
          perImportance[project.importance_scale[imp - 1]] = (perImportance[project.importance_scale[imp - 1]] ?? 0) + 1;
          const item = this.store.createItem(project.id, {
            type, title: sec.title.slice(0, 200), body_md: sec.body, status, importance: imp, effort, source_id: source.id, labels: [],
          });
          this.bus.emit({ t: 'item', item });
          return item.key;
        });
        return {
          created: created.length, first: created[0], last: created.at(-1), by_importance: perImportance,
          importance_not_found_defaulted_to: undetected ? `${project.importance_scale[1]} (${undetected} items)` : undefined,
          source: { id: source.id, link: `/sources/${source.id}` },
        };
      }

      case 'list_sessions': {
        const live = this.store.sessions({ statuses: ['queued', 'running', 'waiting_input', 'idle'] });
        return {
          live: live.map((x) => ({ id: x.id, project: x.project_key, kind: x.kind, title: x.title, status: x.status, waiting: x.waiting_reason, link: `/s/${x.id}` })),
          open_questions: this.store.openInputs().filter((i) => i.session_id !== s.id).length,
        };
      }

      case 'propose_session': {
        const project = this.project(p.project_key);
        if (p.type === 'planner') return this.sessions.propose(s, { type: 'planner', project_key: project.key, prompt: String(p.prompt ?? '') });
        const keys = Array.isArray(p.item_keys) ? (p.item_keys as unknown[]) : [];
        const ids = keys.map((k) => this.item(k)).map((it) => {
          if (it.project_id !== project.id) throw new Error(`${it.key} is not in ${project.key}`);
          return it.id;
        });
        if (!this.store.repos(project.id).length) throw new Error(`${project.key} has no repo yet; add one first.`);
        return this.sessions.propose(s, {
          type: 'batch', project_key: project.key, title: String(p.title ?? keys.join(', ') ?? 'Batch'),
          item_ids: ids, new_items: [], prompt: String(p.prompt ?? ''), force_plan: !!p.force_plan,
        });
      }

      default:
        throw new Error(`Unknown assistant tool ${method}`);
    }
  }

  private async addRepo(project: Project, input: string, branch: string | undefined, check: string | null) {
    const info = await this.inspectRepo(input);
    const default_branch = branch ?? ('default_branch' in info && info.default_branch ? info.default_branch : 'main');
    const exists = this.store.repos(project.id).find((r) => r.github_owner.toLowerCase() === info.owner.toLowerCase() && r.github_name.toLowerCase() === info.name.toLowerCase());
    if (exists) return `${info.owner}/${info.name} is already in ${project.key}`;
    const repo = this.store.addRepo(project.id, { github_owner: info.owner, github_name: info.name, default_branch, check_command: check });
    return { repo: `${repo.github_owner}/${repo.github_name}`, default_branch: repo.default_branch, verified_on_github: info.verified };
  }
}
