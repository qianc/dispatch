// Data access. All SQL lives here; routes and services work with domain types.
import type { Db, Row } from './db.ts';
import { now } from './db.ts';
import {
  itemKey,
  type InputAnswer,
  type Item,
  type ItemImage,
  type ItemStatus,
  type PendingInput,
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
  type SessionKind,
  type SessionStatus,
  type Source,
  type SourceKind,
} from '../shared/types.ts';

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
    read_dirs: json<string[]>(r.read_dirs, []),
    github_account: (r.project_github_account as string | null) ?? null,
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
    local: r.local_path !== null && r.local_path !== undefined,
    // only while open and for the commit it was checked at
    blocked: r.state === 'open' && r.blocked && (r.blocked_sha ?? null) === (r.head_sha ?? null) ? String(r.blocked) : null,
  };
}

// repos carry their project's GitHub account, so every git/GitHub call knows which token to use
const REPO_SELECT = 'SELECT r.*, p.github_account AS project_github_account FROM repos r JOIN projects p ON p.id = r.project_id';
const ITEM_SELECT = 'SELECT i.*, p.key AS project_key FROM items i JOIN projects p ON p.id = i.project_id';
const SESSION_SELECT = `SELECT s.*, p.key AS project_key,
  (SELECT json_group_array(item_id) FROM session_items si WHERE si.session_id = s.id) AS item_ids
  FROM sessions s LEFT JOIN projects p ON p.id = s.project_id`;
const PR_SELECT = 'SELECT pr.*, r.github_owner, r.github_name, r.local_path FROM pull_requests pr JOIN repos r ON r.id = pr.repo_id';

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
  createProject(p: Omit<Project, 'id' | 'created_at' | 'github_account' | 'claude_account' | 'claude_allowed' | 'color' | 'icon'> & Partial<Pick<Project, 'github_account' | 'claude_account' | 'claude_allowed' | 'color' | 'icon'>>): Project {
    const { lastId } = this.db.run(
      'INSERT INTO projects (key, name, description, default_force_plan, importance_scale, effort_scale) VALUES (?, ?, ?, ?, ?, ?)',
      p.key, p.name, p.description, p.default_force_plan ? 1 : 0, JSON.stringify(p.importance_scale), JSON.stringify(p.effort_scale),
    );
    return this.project(lastId)!;
  }
  updateProject(id: number, patch: Partial<Omit<Project, 'id' | 'key' | 'created_at'>>): Project {
    const cur = this.project(id)!;
    const n = { ...cur, ...patch };
    this.db.run(
      'UPDATE projects SET name = ?, description = ?, default_force_plan = ?, importance_scale = ?, effort_scale = ?, github_account = ?, claude_account = ?, claude_allowed = ?, color = ?, icon = ? WHERE id = ?',
      n.name, n.description, n.default_force_plan ? 1 : 0, JSON.stringify(n.importance_scale), JSON.stringify(n.effort_scale),
      n.github_account, n.claude_account, n.claude_allowed ? JSON.stringify(n.claude_allowed) : null, n.color, n.icon, id,
    );
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
  addRepo(projectId: number, r: Omit<Repo, 'id' | 'project_id' | 'local_path' | 'worktree_from' | 'setup_command'> & Partial<Pick<Repo, 'local_path' | 'worktree_from' | 'setup_command'>>): Repo {
    const { lastId } = this.db.run(
      'INSERT INTO repos (project_id, github_owner, github_name, default_branch, check_command, local_path, worktree_from, setup_command) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      projectId, r.github_owner, r.github_name, r.default_branch, r.check_command, r.local_path ?? null, r.worktree_from ?? null, r.setup_command ?? null,
    );
    return this.repo(lastId)!;
  }
  updateRepo(id: number, patch: Partial<Omit<Repo, 'id' | 'project_id'>>): Repo {
    const n = { ...this.repo(id)!, ...patch };
    this.db.run('UPDATE repos SET github_owner = ?, github_name = ?, default_branch = ?, check_command = ?, worktree_from = ?, setup_command = ?, read_dirs = ? WHERE id = ?',
      n.github_owner, n.github_name, n.default_branch, n.check_command, n.worktree_from, n.setup_command, n.read_dirs?.length ? JSON.stringify(n.read_dirs) : null, id);
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
        'INSERT INTO items (project_id, number, type, title, body_md, status, importance, effort, source_id, labels, modules, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        projectId, Number(n), it.type, it.title, it.body_md, it.status, it.importance, it.effort, it.source_id, JSON.stringify(it.labels), JSON.stringify(it.modules ?? []), Number(min) - 1,
      );
      return this.item(lastId)!;
    });
  }
  createProposedItems(projectId: number, items: ProposedItem[], sourceId: number | null): Item[] {
    return items.map((p) =>
      this.createItem(projectId, { ...p, status: p.type === 'bug' ? 'triage' : 'backlog', source_id: sourceId, labels: p.labels ?? [], modules: p.modules ?? [] }),
    );
  }
  updateItem(id: number, patch: Partial<Omit<Item, 'id' | 'project_id' | 'number' | 'key' | 'created_at' | 'updated_at'>>): Item {
    const n = { ...this.item(id)!, ...patch };
    this.db.run(
      'UPDATE items SET type = ?, title = ?, body_md = ?, status = ?, importance = ?, effort = ?, source_id = ?, labels = ?, modules = ?, marked = ?, sort_order = ?, updated_at = ? WHERE id = ?',
      n.type, n.title, n.body_md, n.status, n.importance, n.effort, n.source_id, JSON.stringify(n.labels), JSON.stringify(n.modules), n.marked ? 1 : 0, n.sort_order, now(), id,
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
      item_ids: json<number[]>(r.item_ids, []),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      ended_at: (r.ended_at as string | null) ?? null,
    };
  }
  /** Chats (assistant, discuss) are left out unless asked for by `kind`. */
  sessions(filter: { project_id?: number; statuses?: SessionStatus[]; kind?: SessionKind; limit?: number } = {}): Session[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.project_id) { where.push('s.project_id = ?'); params.push(filter.project_id); }
    if (filter.kind) { where.push('s.kind = ?'); params.push(filter.kind); }
    else where.push("s.kind NOT IN ('assistant', 'discuss')");
    if (filter.statuses?.length) { where.push(`s.status IN (${filter.statuses.map(() => '?').join(',')})`); params.push(...filter.statuses); }
    const sql = `${SESSION_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.updated_at DESC LIMIT ?`;
    return this.db.all(sql, ...params, filter.limit ?? 200).map((r) => this.toSession(r));
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
  createSession(s: { project_id: number | null; kind: SessionKind; title: string; status: SessionStatus; force_plan: boolean; branch: string | null; initial_prompt: string; source_id: number | null; item_ids: number[]; options?: RunOptions; claude_account?: string | null }): Session {
    return this.db.tx(() => {
      const { lastId } = this.db.run(
        'INSERT INTO sessions (project_id, kind, title, status, force_plan, branch, initial_prompt, source_id, options, claude_account) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        s.project_id, s.kind, s.title, s.status, s.force_plan ? 1 : 0, s.branch, s.initial_prompt, s.source_id, JSON.stringify(s.options ?? DEFAULT_RUN_OPTIONS), s.claude_account ?? null,
      );
      for (const id of s.item_ids) this.db.run('INSERT INTO session_items (session_id, item_id) VALUES (?, ?)', lastId, id);
      return this.session(lastId)!;
    });
  }
  updateSession(id: number, patch: Partial<Pick<Session, 'status' | 'branch' | 'sdk_session_id' | 'waiting_reason' | 'last_text' | 'usage' | 'title' | 'ended_at'>>): Session {
    const sets: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      params.push(k === 'usage' ? JSON.stringify(v) : (v as string | null));
    }
    this.db.run(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    return this.session(id)!;
  }
  /** Agent sessions holding a worker slot. The assistant is light and never takes a slot. */
  countActive(): number {
    return Number(this.db.get<{ n: number }>("SELECT count(*) AS n FROM sessions WHERE status IN ('running','waiting_input') AND kind NOT IN ('assistant', 'discuss')")!.n);
  }
  queued(): Session[] {
    return this.db.all(`${SESSION_SELECT} WHERE s.status = 'queued' AND s.kind NOT IN ('assistant', 'discuss') ORDER BY s.id`).map((r) => this.toSession(r));
  }
  /** Earlier work in this project that is still working (not just waiting for its next message). */
  busyBefore(s: Session): number {
    return Number(this.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM sessions WHERE project_id = ? AND id < ? AND kind = 'work' AND status IN ('queued','running','waiting_input')",
      s.project_id ?? -1, s.id,
    )!.n);
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
  setPrBlocked(id: number, why: string | null) {
    this.db.run('UPDATE pull_requests SET blocked = ?, blocked_sha = head_sha WHERE id = ?', why, id);
  }

  // ---------- push ----------
  pushSubscriptions() {
    return this.db.all<{ endpoint: string; p256dh: string; auth: string }>('SELECT endpoint, p256dh, auth FROM push_subscriptions');
  }
  addPushSubscription(endpoint: string, p256dh: string, auth: string, ua: string | null) {
    this.db.run(
      'INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth',
      endpoint, p256dh, auth, ua,
    );
  }
  removePushSubscription(endpoint: string) {
    this.db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint);
  }
}
