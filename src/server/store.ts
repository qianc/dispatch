// Data access. All SQL lives here; routes and services work with domain types.
import type { Db, Row } from './db.ts';
import { now } from './db.ts';
import { Workers } from './workers.ts';
import {
  itemKey,
  type InputAnswer,
  type Item,
  type ItemImage,
  type ItemStatus,
  type MergeEvent,
  type PendingInput,
  type RepoPlacement,
  type PendingInputPayload,
  type Project,
  type ProposedItem,
  DEFAULT_RUN_OPTIONS,
  type RunOptions,
  type PullRequest,
  type Repo,
  type Session,
  type SessionEvent,
  type SessionEventBody,
  type SessionSearch,
  type ReleaseInfo,
  type Schedule,
  type SessionKind,
  type SessionStatus,
  type Source,
  type SourceKind,
} from '../shared/types.ts';
import { searchTerms, snippetOf } from '../shared/search.ts';

const json = <T>(v: unknown, fallback: T): T => (typeof v === 'string' ? (JSON.parse(v) as T) : fallback);
const bool = (v: unknown) => v === 1 || v === 1n;
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toProject(r: Row): Project {
  return {
    id: Number(r.id),
    key: String(r.key),
    name: String(r.name),
    description: String(r.description),
    default_force_plan: bool(r.default_force_plan),
    importance_scale: json(r.importance_scale, []),
    effort_scale: json(r.effort_scale, []),
    github_account: (r.github_account as string | null) ?? null,
    claude_account: (r.claude_account as string | null) ?? null,
    claude_allowed: json<string[] | null>(r.claude_allowed, null),
    color: (r.color as string | null) ?? null,
    icon: (r.icon as string | null) ?? null,
    worker_id: numOrNull(r.worker_id),
    placement_md: String(r.placement_md ?? ''),
    disabled: bool(r.disabled),
    disabled_at: (r.disabled_at as string | null) ?? null,
    disabled_by: (r.disabled_by as string | null) ?? null,
    created_at: String(r.created_at),
  };
}

function toRepo(r: Row): Repo {
  return {
    id: Number(r.id),
    project_id: Number(r.project_id),
    github_owner: String(r.github_owner),
    github_name: String(r.github_name),
    default_branch: String(r.default_branch),
    check_command: (r.check_command as string | null) ?? null,
    local_path: (r.local_path as string | null) ?? null,
    worktree_from: (r.worktree_from as Repo['worktree_from']) ?? null,
    setup_command: (r.setup_command as string | null) ?? null,
    deploy_command: (r.deploy_command as string | null) ?? null,
    generate_command: (r.generate_command as string | null) ?? null,
    generated_paths: json<string[]>(r.generated_paths, []),
    read_dirs: json<string[]>(r.read_dirs, []),
    kind: (r.kind as Repo['kind']) ?? (r.local_path ? 'local' : 'github'),
    worker_id: numOrNull(r.worker_id),
    upstream_owner: (r.upstream_owner as string | null) ?? null,
    upstream_name: (r.upstream_name as string | null) ?? null,
    github_account: (r.project_github_account as string | null) ?? null,
    ...(r.kind === 'local' ? { placements: json<RepoPlacement[]>(r.placements_json, []).sort((a, b) => a.worker_id - b.worker_id) } : {}),
  };
}

function toSource(r: Row): Source {
  return {
    id: Number(r.id),
    project_id: Number(r.project_id),
    kind: r.kind as SourceKind,
    title: String(r.title),
    body_md: String(r.body_md),
    reporter: (r.reporter as string | null) ?? null,
    version_tag: (r.version_tag as string | null) ?? null,
    skill_name: (r.skill_name as string | null) ?? null,
    session_id: numOrNull(r.session_id),
    created_at: String(r.created_at),
  };
}

function toItem(r: Row): Item {
  return {
    id: Number(r.id),
    project_id: Number(r.project_id),
    number: Number(r.number),
    key: itemKey(String(r.project_key), Number(r.number)),
    type: r.type as Item['type'],
    title: String(r.title),
    body_md: String(r.body_md),
    status: r.status as ItemStatus,
    importance: Number(r.importance),
    effort: numOrNull(r.effort),
    source_id: numOrNull(r.source_id),
    labels: json(r.labels, []),
    modules: json(r.modules, []),
    marked: bool(r.marked),
    sort_order: Number(r.sort_order),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    done_at: r.done_at == null ? null : String(r.done_at),
  };
}

function toPr(r: Row): PullRequest {
  return {
    id: Number(r.id),
    session_id: Number(r.session_id),
    repo_id: Number(r.repo_id),
    repo_full_name: `${r.github_owner}/${r.github_name}`,
    number: Number(r.number),
    url: String(r.url),
    title: String(r.title),
    state: r.state as PullRequest['state'],
    mergeable: r.mergeable === null ? null : bool(r.mergeable),
    mergeable_state: (r.mergeable_state as string | null) ?? null,
    head_ref: String(r.head_ref),
    head_sha: (r.head_sha as string | null) ?? null,
    last_synced: (r.last_synced as string | null) ?? null,
    // no GitHub PR: a local or hosted repo's session branch, offered for review in Dispatch
    local: Number(r.number) < 0,
    // only while open and for the commit it was checked at
    blocked: r.state === 'open' && r.blocked && (r.blocked_sha ?? null) === (r.head_sha ?? null) ? String(r.blocked) : null,
    behind_at_merge: numOrNull(r.behind_at_merge),
    started_by: (r.started_by as string | null) ?? null,
    github_login: (r.github_login as string | null) ?? null,
  };
}

// repos carry their project's GitHub account, so every git/GitHub call knows which token to use
const REPO_SELECT = `SELECT r.*, p.github_account AS project_github_account,
  (SELECT json_group_array(json_object('worker_id', rp.worker_id, 'local_path', rp.local_path, 'root_sha', rp.root_sha, 'status', rp.status, 'detail', rp.detail, 'checked_at', rp.checked_at))
     FROM repo_placements rp WHERE rp.repo_id = r.id) AS placements_json
  FROM repos r JOIN projects p ON p.id = r.project_id`;
const ITEM_SELECT = 'SELECT i.*, p.key AS project_key FROM items i JOIN projects p ON p.id = i.project_id';
const SESSION_SELECT = `SELECT s.*, p.key AS project_key,
  (SELECT json_group_array(item_id) FROM session_items si WHERE si.session_id = s.id) AS item_ids
  FROM sessions s LEFT JOIN projects p ON p.id = s.project_id`;
const PR_SELECT = `SELECT pr.*, r.github_owner, r.github_name, r.local_path, s.started_by, s.github_login
  FROM pull_requests pr JOIN repos r ON r.id = pr.repo_id LEFT JOIN sessions s ON s.id = pr.session_id`;

/** A device that gets push notifications, and whose (DISP-65). */
export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  user: string;
}

export interface Comment {
  id: number;
  item_id: number;
  author: string;
  body_md: string;
  session_id: number | null;
  created_at: string;
}

export class Store {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ---------- projects ----------
  projects(): Project[] {
    return this.db.all('SELECT * FROM projects ORDER BY name').map(toProject);
  }
  project(id: number): Project | undefined {
    const r = this.db.get('SELECT * FROM projects WHERE id = ?', id);
    return r && toProject(r);
  }
  projectByKey(key: string): Project | undefined {
    const r = this.db.get('SELECT * FROM projects WHERE key = ?', key.toUpperCase());
    return r && toProject(r);
  }
  createProject(p: Omit<Project, 'id' | 'created_at' | 'disabled' | 'disabled_at' | 'disabled_by' | 'github_account' | 'claude_account' | 'claude_allowed' | 'color' | 'icon' | 'worker_id' | 'placement_md'> & Partial<Pick<Project, 'github_account' | 'claude_account' | 'claude_allowed' | 'color' | 'icon' | 'worker_id' | 'placement_md'>>): Project {
    const { lastId } = this.db.run(
      'INSERT INTO projects (key, name, description, default_force_plan, importance_scale, effort_scale) VALUES (?, ?, ?, ?, ?, ?)',
      p.key, p.name, p.description, p.default_force_plan ? 1 : 0, JSON.stringify(p.importance_scale), JSON.stringify(p.effort_scale),
    );
    return this.project(lastId)!;
  }
  updateProject(id: number, patch: Partial<Omit<Project, 'id' | 'key' | 'created_at' | 'disabled' | 'disabled_at' | 'disabled_by'>>): Project {
    const cur = this.project(id)!;
    const n = { ...cur, ...patch };
    this.db.run(
      'UPDATE projects SET name = ?, description = ?, default_force_plan = ?, importance_scale = ?, effort_scale = ?, github_account = ?, claude_account = ?, claude_allowed = ?, color = ?, icon = ?, worker_id = ?, placement_md = ? WHERE id = ?',
      n.name, n.description, n.default_force_plan ? 1 : 0, JSON.stringify(n.importance_scale), JSON.stringify(n.effort_scale),
      n.github_account, n.claude_account, n.claude_allowed ? JSON.stringify(n.claude_allowed) : null, n.color, n.icon, n.worker_id, n.placement_md, id,
    );
    return this.project(id)!;
  }
  /**
   * Disable a project (read-only, DISP-59) or enable it again. Disabling switches off its enabled
   * schedules and marks them; enabling switches the marked ones back on, with `resume` setting
   * what else changes on them (the slot that passed meanwhile does not run).
   */
  setDisabled(id: number, by: string | null, resume: (s: Schedule) => Partial<Schedule> = () => ({})): Project {
    this.db.tx(() => {
      if (by !== null) {
        this.db.run('UPDATE projects SET disabled = 1, disabled_at = ?, disabled_by = ? WHERE id = ?', now(), by, id);
        this.db.run('UPDATE schedules SET enabled = 0, paused_by_disable = 1, updated_at = ? WHERE project_id = ? AND enabled = 1', now(), id);
        return;
      }
      this.db.run('UPDATE projects SET disabled = 0, disabled_at = NULL, disabled_by = NULL WHERE id = ?', id);
      for (const s of this.schedules(id).filter((x) => x.paused_by_disable)) this.updateSchedule(s.id, { ...resume(s), enabled: true, paused_by_disable: false });
    });
    return this.project(id)!;
  }
  isMuted(projectId: number) {
    return !!this.db.get('SELECT 1 FROM project_mutes WHERE project_id = ?', projectId);
  }
  setMuted(projectId: number, muted: boolean) {
    if (muted) this.db.run('INSERT OR IGNORE INTO project_mutes (project_id) VALUES (?)', projectId);
    else this.db.run('DELETE FROM project_mutes WHERE project_id = ?', projectId);
  }

  // ---------- repos ----------
  repos(projectId: number): Repo[] {
    return this.db.all(`${REPO_SELECT} WHERE r.project_id = ? ORDER BY r.id`, projectId).map(toRepo);
  }
  repo(id: number): Repo | undefined {
    const r = this.db.get(`${REPO_SELECT} WHERE r.id = ?`, id);
    return r && toRepo(r);
  }
  /** A local repo belongs to a worker: `worker_id`, or the default worker when not given. */
  addRepo(projectId: number, r: Omit<Repo, 'id' | 'project_id' | 'local_path' | 'worktree_from' | 'setup_command' | 'kind' | 'worker_id' | 'upstream_owner' | 'upstream_name'> & Partial<Pick<Repo, 'local_path' | 'worktree_from' | 'setup_command' | 'worker_id' | 'kind' | 'upstream_owner' | 'upstream_name'>> & { root_sha?: string | null }): Repo {
    const kind = r.local_path ? 'local' : r.kind === 'hosted' ? 'hosted' : 'github';
    const workerId = kind === 'local' ? r.worker_id ?? this.defaultWorkerId() : null;
    const { lastId } = this.db.run(
      'INSERT INTO repos (project_id, github_owner, github_name, default_branch, check_command, local_path, worktree_from, setup_command, kind, worker_id, upstream_owner, upstream_name, deploy_command) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      projectId, r.github_owner, r.github_name, r.default_branch, r.check_command, r.local_path ?? null, r.worktree_from ?? null, r.setup_command ?? null, kind, workerId,
      r.upstream_owner ?? null, r.upstream_name ?? null, r.deploy_command ?? null,
    );
    if (kind === 'local') this.db.run('INSERT INTO repo_placements (repo_id, worker_id, local_path, root_sha) VALUES (?, ?, ?, ?)', lastId, workerId, r.local_path!, r.root_sha ?? null);
    return this.repo(lastId)!;
  }

  /** A local repo's copy on a worker, added or moved to another path there (DISP-45). */
  setPlacement(repoId: number, workerId: number, localPath: string, rootSha: string | null): Repo {
    this.db.run(`INSERT INTO repo_placements (repo_id, worker_id, local_path, root_sha, status, detail, checked_at) VALUES (?, ?, ?, ?, 'ok', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (repo_id, worker_id) DO UPDATE SET local_path = excluded.local_path, root_sha = excluded.root_sha, status = 'ok', detail = NULL, checked_at = excluded.checked_at`, repoId, workerId, localPath, rootSha);
    // the home copy is mirrored on the repo row
    this.db.run('UPDATE repos SET local_path = ? WHERE id = ? AND worker_id = ?', localPath, repoId, workerId);
    return this.repo(repoId)!;
  }

  /** What a worker found at a placement's path. A first check records the repo's root commit. */
  checkedPlacement(repoId: number, workerId: number, status: RepoPlacement['status'], detail: string | null, rootSha?: string | null) {
    this.db.run(`UPDATE repo_placements SET status = ?, detail = ?, root_sha = COALESCE(root_sha, ?), checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE repo_id = ? AND worker_id = ?`,
      status, detail, rootSha ?? null, repoId, workerId);
  }

  /** Remove a worker's copy. Removing the home copy makes another copy home; the last one stays. */
  removePlacement(repoId: number, workerId: number): Repo {
    const repo = this.repo(repoId)!;
    const rest = (repo.placements ?? []).filter((p) => p.worker_id !== workerId);
    if (!rest.length) throw new Error('A local repo needs a copy on at least one worker: remove the repo instead.');
    this.db.tx(() => {
      this.db.run('DELETE FROM repo_placements WHERE repo_id = ? AND worker_id = ?', repoId, workerId);
      if (repo.worker_id === workerId) this.db.run('UPDATE repos SET worker_id = ?, local_path = ? WHERE id = ?', rest[0].worker_id, rest[0].local_path, repoId);
    });
    return this.repo(repoId)!;
  }

  /** Local repos with a copy on this worker, with that copy. */
  placementsOn(workerId: number): { repo: Repo; placement: RepoPlacement }[] {
    return this.db.all<{ repo_id: number }>('SELECT repo_id FROM repo_placements WHERE worker_id = ? ORDER BY repo_id', workerId)
      .map((r) => this.repo(Number(r.repo_id))!)
      .map((repo) => ({ repo, placement: repo.placements!.find((p) => p.worker_id === workerId)! }));
  }
  updateRepo(id: number, patch: Partial<Omit<Repo, 'id' | 'project_id'>>): Repo {
    const n = { ...this.repo(id)!, ...patch };
    this.db.run('UPDATE repos SET github_owner = ?, github_name = ?, default_branch = ?, check_command = ?, worktree_from = ?, setup_command = ?, read_dirs = ?, upstream_owner = ?, upstream_name = ?, deploy_command = ?, generate_command = ?, generated_paths = ? WHERE id = ?',
      n.github_owner, n.github_name, n.default_branch, n.check_command, n.worktree_from, n.setup_command, n.read_dirs?.length ? JSON.stringify(n.read_dirs) : null,
      n.upstream_owner ?? null, n.upstream_name ?? null, n.deploy_command ?? null, n.generate_command ?? null, n.generated_paths?.length ? JSON.stringify(n.generated_paths) : null, id);
    return this.repo(id)!;
  }
  deleteRepo(id: number) {
    this.db.run('DELETE FROM repos WHERE id = ?', id);
  }

  // ---------- sources ----------
  sources(projectId: number): (Source & { item_count: number })[] {
    return this.db
      .all('SELECT s.*, (SELECT count(*) FROM items i WHERE i.source_id = s.id) AS item_count FROM sources s WHERE project_id = ? ORDER BY id DESC', projectId)
      .map((r) => ({ ...toSource(r), item_count: Number(r.item_count) }));
  }
  source(id: number): Source | undefined {
    const r = this.db.get('SELECT * FROM sources WHERE id = ?', id);
    return r && toSource(r);
  }
  createSource(projectId: number, s: { kind: SourceKind; title: string; body_md: string; reporter: string | null; version_tag: string | null; skill_name: string | null; session_id?: number | null }): Source {
    const { lastId } = this.db.run(
      'INSERT INTO sources (project_id, kind, title, body_md, reporter, version_tag, skill_name, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      projectId, s.kind, s.title, s.body_md, s.reporter, s.version_tag, s.skill_name, s.session_id ?? null,
    );
    return this.source(lastId)!;
  }
  updateSource(id: number, patch: Partial<Pick<Source, 'title' | 'body_md' | 'reporter' | 'version_tag' | 'skill_name' | 'kind'>>): Source {
    const n = { ...this.source(id)!, ...patch };
    this.db.run('UPDATE sources SET kind = ?, title = ?, body_md = ?, reporter = ?, version_tag = ?, skill_name = ? WHERE id = ?',
      n.kind, n.title, n.body_md, n.reporter, n.version_tag, n.skill_name, id);
    return this.source(id)!;
  }

  // ---------- items ----------
  items(projectId: number, filter: { type?: string; status?: string[]; source_id?: number } = {}): Item[] {
    const where = ['i.project_id = ?'];
    const params: (string | number)[] = [projectId];
    if (filter.type) { where.push('i.type = ?'); params.push(filter.type); }
    if (filter.status?.length) { where.push(`i.status IN (${filter.status.map(() => '?').join(',')})`); params.push(...filter.status); }
    if (filter.source_id) { where.push('i.source_id = ?'); params.push(filter.source_id); }
    return this.db
      .all(`${ITEM_SELECT} WHERE ${where.join(' AND ')} ORDER BY i.sort_order, i.importance DESC, i.number DESC`, ...params)
      .map(toItem);
  }
  item(id: number): Item | undefined {
    const r = this.db.get(`${ITEM_SELECT} WHERE i.id = ?`, id);
    return r && toItem(r);
  }
  itemByNumber(projectId: number, number: number): Item | undefined {
    const r = this.db.get(`${ITEM_SELECT} WHERE i.project_id = ? AND i.number = ?`, projectId, number);
    return r && toItem(r);
  }
  itemsByIds(ids: number[]): Item[] {
    if (!ids.length) return [];
    return this.db.all(`${ITEM_SELECT} WHERE i.id IN (${ids.map(() => '?').join(',')}) ORDER BY i.number`, ...ids).map(toItem);
  }
  createItem(projectId: number, it: { type: Item['type']; title: string; body_md: string; status: ItemStatus; importance: number; effort: number | null; source_id: number | null; labels: string[]; modules?: string[] }): Item {
    return this.db.tx(() => {
      const { n } = this.db.get<{ n: number }>('SELECT next_item_number AS n FROM projects WHERE id = ?', projectId)!;
      this.db.run('UPDATE projects SET next_item_number = next_item_number + 1 WHERE id = ?', projectId);
      const min = this.db.get<{ m: number | null }>('SELECT min(sort_order) AS m FROM items WHERE project_id = ?', projectId)?.m ?? 0;
      const { lastId } = this.db.run(
        'INSERT INTO items (project_id, number, type, title, body_md, status, importance, effort, source_id, labels, modules, sort_order, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        projectId, Number(n), it.type, it.title, it.body_md, it.status, it.importance, it.effort, it.source_id, JSON.stringify(it.labels), JSON.stringify(it.modules ?? []), Number(min) - 1, it.status === 'done' ? now() : null,
      );
      return this.item(lastId)!;
    });
  }
  createProposedItems(projectId: number, items: ProposedItem[], sourceId: number | null): Item[] {
    return items.map((p) =>
      this.createItem(projectId, { ...p, status: p.type === 'bug' ? 'triage' : 'backlog', source_id: sourceId, labels: p.labels ?? [], modules: p.modules ?? [] }),
    );
  }
  updateItem(id: number, patch: Partial<Omit<Item, 'id' | 'project_id' | 'number' | 'key' | 'created_at' | 'updated_at' | 'done_at'>>): Item {
    const old = this.item(id)!;
    const n = { ...old, ...patch };
    // stays when an item that is done is edited; a reopened item is done again on its new date
    const doneAt = n.status !== 'done' ? null : old.status === 'done' ? old.done_at : now();
    this.db.run(
      'UPDATE items SET type = ?, title = ?, body_md = ?, status = ?, importance = ?, effort = ?, source_id = ?, labels = ?, modules = ?, marked = ?, sort_order = ?, updated_at = ?, done_at = ? WHERE id = ?',
      n.type, n.title, n.body_md, n.status, n.importance, n.effort, n.source_id, JSON.stringify(n.labels), JSON.stringify(n.modules), n.marked ? 1 : 0, n.sort_order, now(), doneAt, id,
    );
    return this.item(id)!;
  }
  /** Tags and modules used in a project, most used first — suggestions for the item form. */
  facets(projectId: number): { tags: { name: string; count: number }[]; modules: { name: string; count: number }[] } {
    const count = (col: 'labels' | 'modules') =>
      this.db
        .all<{ name: string; count: number }>(
          `SELECT j.value AS name, count(*) AS count FROM items i, json_each(i.${col}) j WHERE i.project_id = ? GROUP BY lower(j.value) ORDER BY count DESC, name`,
          projectId,
        )
        .map((r) => ({ name: String(r.name), count: Number(r.count) }));
    return { tags: count('labels'), modules: count('modules') };
  }

  /** The repos each of a project's items reached through a merged pull request; other items have no entry. */
  mergedRepos(projectId: number): Map<number, number[]> {
    const rows = this.db.all<{ item_id: number; repo_id: number }>(
      `SELECT DISTINCT si.item_id, pr.repo_id FROM session_items si
       JOIN items i ON i.id = si.item_id JOIN pull_requests pr ON pr.session_id = si.session_id
       WHERE i.project_id = ? AND pr.state = 'merged'`,
      projectId,
    );
    const out = new Map<number, number[]>();
    for (const r of rows) out.set(Number(r.item_id), [...(out.get(Number(r.item_id)) ?? []), Number(r.repo_id)]);
    return out;
  }

  deleteItem(id: number) {
    this.db.run('DELETE FROM items WHERE id = ?', id);
  }
  comments(itemId: number): Comment[] {
    return this.db.all<Comment>('SELECT * FROM comments WHERE item_id = ? ORDER BY id', itemId);
  }
  addComment(itemId: number, author: string, body: string, sessionId: number | null = null): Comment {
    const { lastId } = this.db.run('INSERT INTO comments (item_id, author, body_md, session_id) VALUES (?, ?, ?, ?)', itemId, author, body, sessionId);
    return this.db.get<Comment>('SELECT * FROM comments WHERE id = ?', lastId)!;
  }

  /** Add items to a session's batch (no-op for ones already in it). */
  addSessionItems(sessionId: number, itemIds: number[]) {
    for (const id of itemIds) this.db.run('INSERT OR IGNORE INTO session_items (session_id, item_id) VALUES (?, ?)', sessionId, id);
  }

  // ---------- item images ----------
  private toImage(r: Row): ItemImage & { file: string } {
    const id = Number(r.id);
    return {
      id, item_id: Number(r.item_id), comment_id: r.comment_id === null ? null : Number(r.comment_id),
      name: String(r.name), mime: String(r.mime), size: Number(r.size), author: String(r.author), created_at: String(r.created_at),
      file: String(r.file), url: `/api/images/${id}/${encodeURIComponent(String(r.name))}`,
    };
  }
  itemImages(itemId: number) {
    return this.db.all<Row>('SELECT * FROM item_images WHERE item_id = ? ORDER BY id', itemId).map((r) => this.toImage(r));
  }
  itemImage(id: number) {
    const r = this.db.get<Row>('SELECT * FROM item_images WHERE id = ?', id);
    return r ? this.toImage(r) : undefined;
  }
  addItemImage(p: { item_id: number; comment_id: number | null; name: string; file: string; mime: string; size: number; author: string }) {
    const { lastId } = this.db.run(
      'INSERT INTO item_images (item_id, comment_id, name, file, mime, size, author) VALUES (?, ?, ?, ?, ?, ?, ?)',
      p.item_id, p.comment_id, p.name, p.file, p.mime, p.size, p.author,
    );
    return this.itemImage(Number(lastId))!;
  }
  deleteItemImage(id: number) {
    this.db.run('DELETE FROM item_images WHERE id = ?', id);
  }

  /** The default worker: the setting, if it names a live worker, else the legacy one (no hash). */
  defaultWorkerId(): number {
    return new Workers(this.db).defaultId();
  }

  // ---------- sessions ----------
  private toSession(r: Row): Session {
    return {
      id: Number(r.id),
      project_id: numOrNull(r.project_id),
      project_key: (r.project_key as string | null) ?? null,
      kind: r.kind as SessionKind,
      title: String(r.title),
      status: r.status as SessionStatus,
      force_plan: bool(r.force_plan),
      branch: (r.branch as string | null) ?? null,
      sdk_session_id: (r.sdk_session_id as string | null) ?? null,
      initial_prompt: String(r.initial_prompt),
      source_id: numOrNull(r.source_id),
      waiting_reason: (r.waiting_reason as string | null) ?? null,
      last_text: (r.last_text as string | null) ?? null,
      usage: json(r.usage, null),
      options: { ...DEFAULT_RUN_OPTIONS, ...json<Partial<RunOptions>>(r.options, {}) },
      claude_account: (r.claude_account as string | null) ?? null,
      worker_id: numOrNull(r.worker_id),
      paused: bool(r.paused),
      pending_prompt: (r.pending_prompt as string | null) ?? null,
      moved_from: numOrNull(r.moved_from),
      item_ids: json<number[]>(r.item_ids, []),
      release: json(r.release_info, null),
      schedule_id: numOrNull(r.schedule_id),
      login_needed: json(r.login_needed, null),
      started_by: (r.started_by as string | null) ?? null,
      github_login: (r.github_login as string | null) ?? null,
      closed_at: (r.closed_at as string | null) ?? null,
      closed_reason: (r.closed_reason as Session['closed_reason']) ?? null,
      retry_of: numOrNull(r.retry_of),
      about_session: numOrNull(r.about_session),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      ended_at: (r.ended_at as string | null) ?? null,
    };
  }
  /** Chats (assistant, discuss) are left out unless asked for by `kind`; `started_by`: only those that user started. */
  sessions(filter: { project_id?: number; statuses?: SessionStatus[]; kind?: SessionKind; started_by?: string | null; limit?: number } = {}): Session[] {
    const where: string[] = [];
    const params: (string | number | null)[] = [];
    if (filter.project_id) { where.push('s.project_id = ?'); params.push(filter.project_id); }
    // null: started by no user
    if (filter.started_by !== undefined) { where.push('s.started_by IS ?'); params.push(filter.started_by); }
    if (filter.kind) { where.push('s.kind = ?'); params.push(filter.kind); }
    else where.push("s.kind NOT IN ('assistant', 'discuss')");
    if (filter.statuses?.length) { where.push(`s.status IN (${filter.statuses.map(() => '?').join(',')})`); params.push(...filter.statuses); }
    const sql = `${SESSION_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.updated_at DESC LIMIT ?`;
    return this.db.all(sql, ...params, filter.limit ?? 200).map((r) => this.toSession(r));
  }
  /**
   * Activity's search over the full history (DISP-54), newest first. Every word of `q` must be in
   * the title, the first prompt, or a message (the owner's or Claude's) of the chat. All kinds,
   * chats too, unless `kind` is given. `from` / `to` (ISO times, `to` not included) bound when it
   * started. Each hit has a piece of the message that matches most words.
   */
  searchSessions(f: { q?: string; project_id?: number; kind?: SessionKind; from?: string; to?: string; limit?: number; offset?: number } = {}): SessionSearch {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const terms = searchTerms(f.q ?? '');
    const likes = terms.map((t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`);
    const text = "json_extract(e.body, '$.text')";
    const message = "json_extract(e.body, '$.kind') IN ('user', 'assistant')";
    for (const like of likes) {
      where.push(`(s.title LIKE ? ESCAPE '\\' OR s.initial_prompt LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM session_events e WHERE e.session_id = s.id AND ${message} AND ${text} LIKE ? ESCAPE '\\'))`);
      params.push(like, like, like);
    }
    if (f.project_id) { where.push('s.project_id = ?'); params.push(f.project_id); }
    if (f.kind) { where.push('s.kind = ?'); params.push(f.kind); }
    if (f.from) { where.push('s.created_at >= ?'); params.push(f.from); }
    if (f.to) { where.push('s.created_at < ?'); params.push(f.to); }
    const limit = Math.min(Math.max(f.limit ?? 30, 1), 100);
    const rows = this.db.all(
      `${SESSION_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.updated_at DESC, s.id DESC LIMIT ? OFFSET ?`,
      ...params, limit + 1, Math.max(f.offset ?? 0, 0),
    );
    const best = likes.length
      ? `SELECT ${text} AS text FROM session_events e WHERE e.session_id = ? AND ${message} AND (${likes.map(() => `${text} LIKE ? ESCAPE '\\'`).join(' OR ')})
          ORDER BY ${likes.map(() => `(${text} LIKE ? ESCAPE '\\')`).join(' + ')} DESC, e.seq DESC LIMIT 1`
      : '';
    return {
      sessions: rows.slice(0, limit).map((r) => {
        const s = this.toSession(r);
        const hit = best ? this.db.get<{ text: string }>(best, s.id, ...likes, ...likes) : undefined;
        const from = hit?.text ?? (terms.some((t) => s.initial_prompt.toLowerCase().includes(t)) ? s.initial_prompt : null);
        return { ...s, snippet: from ? snippetOf(from, terms) : null };
      }),
      has_more: rows.length > limit,
    };
  }
  session(id: number): Session | undefined {
    const r = this.db.get(`${SESSION_SELECT} WHERE s.id = ?`, id);
    return r && this.toSession(r);
  }
  sessionsForItem(itemId: number, kind?: SessionKind): Session[] {
    const k = kind ? 's.kind = ?' : "s.kind != 'discuss'";
    return this.db
      .all(`${SESSION_SELECT} WHERE ${k} AND s.id IN (SELECT session_id FROM session_items WHERE item_id = ?) ORDER BY s.id DESC`, ...(kind ? [kind] : []), itemId)
      .map((r) => this.toSession(r));
  }
  /** `started_by`: the user who started it (null: no user); `worker_id`: the worker it runs on. */
  createSession(s: { project_id: number | null; kind: SessionKind; title: string; status: SessionStatus; force_plan: boolean; branch: string | null; initial_prompt: string; source_id: number | null; item_ids: number[]; options?: RunOptions; claude_account?: string | null; worker_id: number; started_by: string | null; moved_from?: number | null; release?: ReleaseInfo | null; schedule_id?: number | null; retry_of?: number | null; about_session?: number | null }): Session {
    return this.db.tx(() => {
      const { lastId } = this.db.run(
        'INSERT INTO sessions (project_id, kind, title, status, force_plan, branch, initial_prompt, source_id, options, claude_account, worker_id, moved_from, release_info, schedule_id, started_by, retry_of, about_session) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        s.project_id, s.kind, s.title, s.status, s.force_plan ? 1 : 0, s.branch, s.initial_prompt, s.source_id, JSON.stringify(s.options ?? DEFAULT_RUN_OPTIONS), s.claude_account ?? null,
        s.worker_id, s.moved_from ?? null, s.release ? JSON.stringify(s.release) : null, s.schedule_id ?? null, s.started_by, s.retry_of ?? null, s.about_session ?? null,
      );
      for (const id of s.item_ids) this.db.run('INSERT INTO session_items (session_id, item_id) VALUES (?, ?)', lastId, id);
      return this.session(lastId)!;
    });
  }
  updateSession(id: number, patch: Partial<Pick<Session, 'status' | 'branch' | 'sdk_session_id' | 'waiting_reason' | 'last_text' | 'usage' | 'title' | 'ended_at' | 'options' | 'worker_id' | 'paused' | 'pending_prompt' | 'login_needed' | 'github_login' | 'closed_at' | 'closed_reason'>>): Session {
    const sets: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      params.push(k === 'usage' || k === 'options' || (k === 'login_needed' && v) ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | null));
    }
    this.db.run(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    return this.session(id)!;
  }
  /** Failed agent sessions the owner has not closed (DISP-81), newest first. */
  failedOpen(limit = 50): Session[] {
    return this.db
      .all(`${SESSION_SELECT} WHERE s.status = 'failed' AND s.closed_at IS NULL AND s.kind NOT IN ('assistant', 'discuss') ORDER BY s.updated_at DESC LIMIT ?`, limit)
      .map((r) => this.toSession(r));
  }
  /** The session that retries `id` (DISP-81), if any. */
  retryOf(id: number): Session | undefined {
    const r = this.db.get(`${SESSION_SELECT} WHERE s.retry_of = ? ORDER BY s.id DESC LIMIT 1`, id);
    return r && this.toSession(r);
  }
  /** Discussions of why session `id` failed (DISP-81), newest first. */
  discussionsAbout(id: number): Session[] {
    return this.db.all(`${SESSION_SELECT} WHERE s.about_session = ? ORDER BY s.id DESC`, id).map((r) => this.toSession(r));
  }
  /** The text of a session's last error in its chat. */
  lastError(sessionId: number): string | null {
    return this.db.get<{ text: string | null }>("SELECT json_extract(body, '$.text') AS text FROM session_events WHERE session_id = ? AND json_extract(body, '$.kind') = 'error' ORDER BY seq DESC LIMIT 1", sessionId)?.text ?? null;
  }
  /** Everything waiting to start, chats included (they wait for their worker too). */
  queued(): Session[] {
    return this.db.all(`${SESSION_SELECT} WHERE s.status = 'queued' ORDER BY s.id`).map((r) => this.toSession(r));
  }
  /** Earlier work sessions in this project that are not abandoned (a queued "after" batch waits on them). */
  earlierWork(s: Session): Session[] {
    return this.db
      .all(`${SESSION_SELECT} WHERE s.project_id = ? AND s.id < ? AND s.kind = 'work' AND s.status NOT IN ('stopped','failed') ORDER BY s.id`, s.project_id ?? -1, s.id)
      .map((r) => this.toSession(r));
  }

  // ---------- schedules ----------
  private toSchedule(r: Row): Schedule {
    return {
      id: Number(r.id),
      project_id: Number(r.project_id),
      name: String(r.name),
      at_time: String(r.at_time),
      days: json<number[]>(r.days, []),
      scope_md: String(r.scope_md),
      max_batches: Number(r.max_batches),
      options: { ...DEFAULT_RUN_OPTIONS, ...json<Partial<RunOptions>>(r.options, {}) },
      enabled: bool(r.enabled),
      paused_by_disable: bool(r.paused_by_disable),
      last_slot: (r.last_slot as string | null) ?? null,
      last_session_id: numOrNull(r.last_session_id),
      last_error: (r.last_error as string | null) ?? null,
      owner: (r.owner as string | null) ?? null,
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }
  /** One project's schedules, or every one (the scheduler). */
  schedules(projectId?: number): Schedule[] {
    return (projectId === undefined
      ? this.db.all('SELECT * FROM schedules ORDER BY id')
      : this.db.all('SELECT * FROM schedules WHERE project_id = ? ORDER BY at_time, id', projectId)).map((r) => this.toSchedule(r));
  }
  schedule(id: number): Schedule | undefined {
    const r = this.db.get('SELECT * FROM schedules WHERE id = ?', id);
    return r && this.toSchedule(r);
  }
  createSchedule(projectId: number, s: Pick<Schedule, 'name' | 'at_time' | 'days' | 'scope_md' | 'max_batches' | 'options' | 'enabled' | 'last_slot'> & { owner: string }): Schedule {
    const { lastId } = this.db.run(
      'INSERT INTO schedules (project_id, name, at_time, days, scope_md, max_batches, options, enabled, last_slot, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      projectId, s.name, s.at_time, JSON.stringify(s.days), s.scope_md, s.max_batches, JSON.stringify(s.options), s.enabled ? 1 : 0, s.last_slot, s.owner,
    );
    return this.schedule(lastId)!;
  }
  updateSchedule(id: number, patch: Partial<Omit<Schedule, 'id' | 'project_id' | 'owner' | 'created_at' | 'updated_at'>>): Schedule {
    const sets: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      params.push(k === 'days' || k === 'options' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number | null));
    }
    this.db.run(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    return this.schedule(id)!;
  }
  deleteSchedule(id: number) {
    this.db.run('DELETE FROM schedules WHERE id = ?', id);
  }

  // ---------- events ----------
  addEvent(sessionId: number, body: SessionEventBody): SessionEvent {
    return this.db.tx(() => {
      const seq = Number(this.db.get<{ n: number }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM session_events WHERE session_id = ?', sessionId)!.n);
      const { lastId } = this.db.run('INSERT INTO session_events (session_id, seq, body) VALUES (?, ?, ?)', sessionId, seq, JSON.stringify(body));
      return { id: lastId, session_id: sessionId, seq, body, created_at: now() };
    });
  }
  events(sessionId: number, afterSeq = 0): SessionEvent[] {
    return this.db
      .all('SELECT * FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq', sessionId, afterSeq)
      .map((r) => ({ id: Number(r.id), session_id: Number(r.session_id), seq: Number(r.seq), body: json(r.body, { kind: 'system', text: '' }), created_at: String(r.created_at) }));
  }

  /** The owner's message with this client id in the session, if it was stored (DISP-83). */
  hasUserMessage(sessionId: number, clientId: string): boolean {
    return !!this.db.get("SELECT 1 FROM session_events WHERE session_id = ? AND json_extract(body, '$.kind') = 'user' AND json_extract(body, '$.client_id') = ?", sessionId, clientId);
  }

  /** Claude's messages (replies, proposal cards) in a chat after the point the owner has read to. */
  unread(sessionId: number): { unread: number; last_seq: number } {
    const r = this.db.get<{ unread: number; last_seq: number }>(
      `SELECT count(CASE WHEN e.seq > s.read_seq AND json_extract(e.body, '$.kind') IN ('assistant', 'proposal') THEN 1 END) AS unread,
        coalesce(max(e.seq), 0) AS last_seq
        FROM sessions s LEFT JOIN session_events e ON e.session_id = s.id WHERE s.id = ?`,
      sessionId,
    );
    return { unread: Number(r?.unread ?? 0), last_seq: Number(r?.last_seq ?? 0) };
  }
  /** Mark a chat read up to `seq` (never backwards). */
  markRead(sessionId: number, seq: number) {
    this.db.run('UPDATE sessions SET read_seq = max(read_seq, ?) WHERE id = ?', seq, sessionId);
  }

  // ---------- pending inputs ----------
  private toInput(r: Row): PendingInput & { local_id: string } {
    return {
      id: Number(r.id),
      session_id: Number(r.session_id),
      local_id: String(r.local_id),
      payload: json<PendingInputPayload>(r.payload, { kind: 'question', questions: [] }),
      answer: json<InputAnswer | null>(r.answer, null),
      answered_at: (r.answered_at as string | null) ?? null,
      expired: bool(r.expired),
      created_at: String(r.created_at),
    };
  }
  createInput(sessionId: number, localId: string, payload: PendingInputPayload) {
    const { lastId } = this.db.run('INSERT INTO pending_inputs (session_id, local_id, payload) VALUES (?, ?, ?)', sessionId, localId, JSON.stringify(payload));
    return this.input(lastId)!;
  }
  input(id: number) {
    const r = this.db.get('SELECT * FROM pending_inputs WHERE id = ?', id);
    return r && this.toInput(r);
  }
  inputs(sessionId: number) {
    return this.db.all('SELECT * FROM pending_inputs WHERE session_id = ? ORDER BY id', sessionId).map((r) => this.toInput(r));
  }
  openInputs() {
    return this.db.all('SELECT * FROM pending_inputs WHERE answered_at IS NULL AND expired = 0 ORDER BY id DESC').map((r) => this.toInput(r));
  }
  answerInput(id: number, answer: InputAnswer) {
    this.db.run('UPDATE pending_inputs SET answer = ?, answered_at = ? WHERE id = ?', JSON.stringify(answer), now(), id);
    return this.input(id)!;
  }
  expireInputs(sessionId: number) {
    const open = this.db.all('SELECT * FROM pending_inputs WHERE session_id = ? AND answered_at IS NULL AND expired = 0', sessionId).map((r) => this.toInput(r));
    this.db.run('UPDATE pending_inputs SET expired = 1 WHERE session_id = ? AND answered_at IS NULL', sessionId);
    return open.map((i) => ({ ...i, expired: true }));
  }

  // ---------- pull requests ----------
  prs(filter: { session_id?: number; open_only?: boolean } = {}): PullRequest[] {
    const where: string[] = [];
    const params: number[] = [];
    if (filter.session_id) { where.push('pr.session_id = ?'); params.push(filter.session_id); }
    if (filter.open_only) where.push("pr.state = 'open'");
    return this.db.all(`${PR_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY pr.id DESC`, ...params).map(toPr);
  }
  pr(id: number): PullRequest | undefined {
    const r = this.db.get(`${PR_SELECT} WHERE pr.id = ?`, id);
    return r && toPr(r);
  }
  upsertPr(p: { session_id: number; repo_id: number; number: number; url: string; title: string; state: PullRequest['state']; mergeable: boolean | null; mergeable_state: string | null; head_ref: string; head_sha: string | null }): PullRequest {
    this.db.run(
      `INSERT INTO pull_requests (session_id, repo_id, number, url, title, state, mergeable, mergeable_state, head_ref, head_sha, last_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, number) DO UPDATE SET url = excluded.url, title = excluded.title, state = excluded.state,
         mergeable = excluded.mergeable, mergeable_state = excluded.mergeable_state, head_ref = excluded.head_ref,
         head_sha = excluded.head_sha, last_synced = excluded.last_synced`,
      p.session_id, p.repo_id, p.number, p.url, p.title, p.state, p.mergeable === null ? null : p.mergeable ? 1 : 0, p.mergeable_state, p.head_ref, p.head_sha, now(),
    );
    return toPr(this.db.get(`${PR_SELECT} WHERE pr.repo_id = ? AND pr.number = ?`, p.repo_id, p.number)!);
  }

  /** Remember why auto-merge stopped on this PR (at its current head commit). */
  setPrBehindAtMerge(id: number, behind: number | null) {
    this.db.run('UPDATE pull_requests SET behind_at_merge = ? WHERE id = ?', behind, id);
  }

  addMergeEvent(sessionId: number, kind: MergeEvent['kind'], prId: number | null = null, detail: string | null = null) {
    this.db.run('INSERT INTO merge_events (session_id, pr_id, kind, detail) VALUES (?, ?, ?, ?)', sessionId, prId, kind, detail);
  }

  mergeEvents(sessionId: number): MergeEvent[] {
    return this.db.all('SELECT * FROM merge_events WHERE session_id = ? ORDER BY id', sessionId).map((r) => ({
      id: Number(r.id), session_id: Number(r.session_id), pr_id: numOrNull(r.pr_id), kind: r.kind as MergeEvent['kind'],
      detail: (r.detail as string | null) ?? null, created_at: String(r.created_at),
    }));
  }

  addCheckRun(r: { repo_id: number; command: string; ok: boolean; duration_ms: number; units: number }) {
    this.db.run('INSERT INTO check_runs (repo_id, command, ok, duration_ms, units) VALUES (?, ?, ?, ?, ?)', r.repo_id, r.command, r.ok ? 1 : 0, Math.round(r.duration_ms), r.units);
  }

  /** Earlier passing runs of a repo's check command, newest first. */
  checkHistory(repoId: number, command: string, limit = 20): { duration_ms: number; units: number }[] {
    return this.db.all('SELECT duration_ms, units FROM check_runs WHERE repo_id = ? AND command = ? AND ok = 1 ORDER BY id DESC LIMIT ?', repoId, command, limit)
      .map((r) => ({ duration_ms: Number(r.duration_ms), units: Number(r.units) }));
  }

  setPrBlocked(id: number, why: string | null) {
    this.db.run('UPDATE pull_requests SET blocked = ?, blocked_sha = head_sha WHERE id = ?', why, id);
  }

  // ---------- push ----------
  /** Every device that gets notifications, or only `user`'s. */
  pushSubscriptions(user?: string): PushSubscription[] {
    return user === undefined
      ? this.db.all<PushSubscription>('SELECT endpoint, p256dh, auth, user FROM push_subscriptions')
      : this.db.all<PushSubscription>('SELECT endpoint, p256dh, auth, user FROM push_subscriptions WHERE user = ?', user);
  }
  /** A device subscribes for `user`; subscribing again on the same device (another person signed in there) moves it to them. */
  addPushSubscription(endpoint: string, p256dh: string, auth: string, ua: string | null, user: string) {
    this.db.run(
      'INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, user) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user = excluded.user',
      endpoint, p256dh, auth, ua, user,
    );
  }
  /** Removes the subscription; with `user`, only if it is theirs. Returns whether a row went. */
  removePushSubscription(endpoint: string, user?: string): boolean {
    const r = user === undefined
      ? this.db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint)
      : this.db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user = ?', endpoint, user);
    return r.changes > 0;
  }
}
