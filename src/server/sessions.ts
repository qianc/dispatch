// Session lifecycle: creating batches and planner chats, queueing, and applying worker events.
import type { StartSpec, WorkerToServer } from '../shared/protocol.ts';
import {
  ACTIVE_STATUSES,
  FINAL_STATUSES,
  proposedItemSchema,
  type InputAnswer,
  type Project,
  type ProposedItem,
  type Session,
  type SessionStatus,
} from '../shared/types.ts';
import { z } from 'zod';
import type { Bus } from './bus.ts';
import type { Notifier } from './notify.ts';
import type { Store } from './store.ts';
import type { WorkerHub } from './workerHub.ts';

export class SessionError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const slug = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'work';

export function branchName(projectKey: string, sessionId: number, title: string) {
  return `dispatch/${projectKey.toLowerCase()}-${sessionId}-${slug(title)}`;
}

const proposalSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('batch'),
    title: z.string().min(1),
    item_ids: z.array(z.number().int()).default([]),
    new_items: z.array(proposedItemSchema).default([]),
    prompt: z.string().default(''),
    force_plan: z.boolean().default(false),
  }),
  z.object({ type: z.literal('items'), source_id: z.number().int().nullable().default(null), items: z.array(proposedItemSchema).min(1) }),
]);

export class Sessions {
  private store: Store;
  private bus: Bus;
  private hub: WorkerHub;
  private notifier: Notifier;
  private maxConcurrent: number;

  constructor(store: Store, bus: Bus, hub: WorkerHub, notifier: Notifier, maxConcurrent: number) {
    this.store = store;
    this.bus = bus;
    this.hub = hub;
    this.notifier = notifier;
    this.maxConcurrent = maxConcurrent;
  }

  // ---------- creation ----------

  startBatch(project: Project, input: { title?: string; item_ids: number[]; new_items: ProposedItem[]; prompt: string; force_plan?: boolean; source_id?: number | null }): Session {
    const items = this.store.itemsByIds(input.item_ids).filter((i) => i.project_id === project.id);
    const created = this.store.createProposedItems(project.id, input.new_items, input.source_id ?? null);
    const all = [...items, ...created];
    if (!all.length && !input.prompt.trim()) throw new SessionError('Pick at least one item or write a prompt.');
    if (!this.store.repos(project.id).length) throw new SessionError('Add a repo to this project first.');
    const title = input.title?.trim() || (all.length === 1 ? `${all[0].key} ${all[0].title}` : all.length ? `${all.map((i) => i.key).join(', ')}` : input.prompt.slice(0, 80));
    let session = this.store.createSession({
      project_id: project.id,
      kind: 'work',
      title,
      status: 'queued',
      force_plan: input.force_plan ?? project.default_force_plan,
      branch: null,
      initial_prompt: input.prompt,
      source_id: input.source_id ?? null,
      item_ids: all.map((i) => i.id),
    });
    session = this.store.updateSession(session.id, { branch: branchName(project.key, session.id, all.length === 1 || !input.title?.trim() ? all[0]?.title ?? title : title) });
    for (const it of all) this.bus.emit({ t: 'item', item: this.store.updateItem(it.id, { status: 'in_progress', marked: false }) });
    this.emitSession(session);
    this.dispatch();
    return this.store.session(session.id)!;
  }

  startPlanner(project: Project, input: { prompt: string; source_id: number | null }): Session {
    const source = input.source_id ? this.store.source(input.source_id) : null;
    if (input.source_id && (!source || source.project_id !== project.id)) throw new SessionError('Unknown source', 404);
    const title = source ? `Split: ${source.title}` : input.prompt.trim() ? `Plan: ${input.prompt.trim().slice(0, 60)}` : 'Plan next batch';
    const prompt = input.prompt.trim() || (source
      ? 'Read the source document in your instructions and split it into backlog items and bugs. Call propose_items with the result.'
      : 'Look at the open backlog, bugs and the code, and propose the next batch of work. Call propose_batch with your suggestion.');
    const session = this.store.createSession({
      project_id: project.id, kind: 'planner', title, status: 'queued', force_plan: false, branch: null,
      initial_prompt: prompt, source_id: source?.id ?? null, item_ids: [],
    });
    this.emitSession(session);
    this.dispatch();
    return this.store.session(session.id)!;
  }

  // ---------- user actions ----------

  send(sessionId: number, text: string) {
    const s = this.mustGet(sessionId);
    if (s.status === 'queued') throw new SessionError('Session has not started yet.');
    if (s.status === 'waiting_input') throw new SessionError('Answer the open question first.');
    this.addEvent(sessionId, { kind: 'user', text });
    const reopen = FINAL_STATUSES.includes(s.status);
    if (!this.hub.send({ t: 'send', session_id: sessionId, text, spec: this.spec(s, text, s.sdk_session_id, null) })) {
      throw new SessionError('Worker is not connected.', 503);
    }
    this.setStatus(sessionId, 'running', { ended_at: reopen ? null : s.ended_at, waiting_reason: null });
  }

  answer(inputId: number, answer: InputAnswer) {
    const input = this.store.input(inputId);
    if (!input) throw new SessionError('Unknown input', 404);
    if (input.answered_at || input.expired) throw new SessionError('This question is already closed.', 409);
    if (input.payload.kind !== answer.kind) throw new SessionError('Answer kind does not match the question.');
    if (!this.hub.send({ t: 'answer', session_id: input.session_id, local_id: input.local_id, answer })) {
      throw new SessionError('Worker is not connected.', 503);
    }
    const saved = this.store.answerInput(inputId, answer);
    this.bus.emit({ t: 'input', input: saved });
    if (!this.store.openInputs().some((i) => i.session_id === input.session_id)) {
      this.setStatus(input.session_id, 'running', { waiting_reason: null });
    }
  }

  interrupt(sessionId: number) {
    this.mustGet(sessionId);
    this.hub.send({ t: 'interrupt', session_id: sessionId });
  }

  /** End a session. `completed` = you are done with it; `stopped` = abandoned. */
  finish(sessionId: number, status: 'completed' | 'stopped', cleanup = false) {
    const s = this.mustGet(sessionId);
    this.hub.send({ t: 'close', session_id: sessionId, cleanup, repos: this.store.repos(s.project_id) });
    for (const i of this.store.expireInputs(sessionId)) this.bus.emit({ t: 'input', input: i });
    if (status === 'stopped' && s.kind === 'work') {
      for (const it of this.store.itemsByIds(s.item_ids)) {
        if (it.status === 'in_progress') this.bus.emit({ t: 'item', item: this.store.updateItem(it.id, { status: 'todo' }) });
      }
    }
    this.setStatus(sessionId, status, { ended_at: new Date().toISOString(), waiting_reason: null });
    this.dispatch();
  }

  // ---------- worker events ----------

  onWorkerHello(live: number[]) {
    // Anything we believe is live but the worker does not know about was lost (worker restart): resume it.
    const lost = this.store.sessions({ statuses: ['running', 'waiting_input'] }).filter((s) => !live.includes(s.id));
    for (const s of lost) {
      for (const i of this.store.expireInputs(s.id)) this.bus.emit({ t: 'input', input: i });
      if (!s.sdk_session_id) {
        this.setStatus(s.id, 'queued');
        continue;
      }
      const note = 'The Dispatch worker restarted and this session was resumed. Any question you asked before was not answered; ask it again if you still need it, otherwise continue.';
      this.addEvent(s.id, { kind: 'system', text: 'Worker restarted — session resumed.' });
      this.hub.send({ t: 'start', spec: this.spec(s, note, s.sdk_session_id, note) });
      this.setStatus(s.id, 'running', { waiting_reason: null });
    }
    this.dispatch();
  }

  onWorkerMessage(msg: Exclude<WorkerToServer, { t: 'hello' } | { t: 'rpc' } | { t: 'cmd_result' }>) {
    const s = this.store.session(msg.session_id);
    if (!s) return;
    switch (msg.t) {
      case 'event': {
        this.addEvent(s.id, msg.body);
        if (msg.body.kind === 'assistant') this.emitSession(this.store.updateSession(s.id, { last_text: msg.body.text.slice(0, 300) }));
        if (msg.body.kind === 'result') {
          const u = s.usage ?? {};
          // cost is cumulative per Claude session; turns are per turn
          const usage = { ...u, cost_usd: msg.body.cost_usd ?? u.cost_usd, turns: (u.turns ?? 0) + (msg.body.turns ?? 0) };
          this.emitSession(this.store.updateSession(s.id, { usage }));
        }
        return;
      }
      case 'status': {
        if (FINAL_STATUSES.includes(s.status) && msg.status !== 'failed') return; // closed by the user meanwhile
        const patch: Partial<Session> = {};
        if (msg.sdk_session_id) patch.sdk_session_id = msg.sdk_session_id;
        if (msg.status === 'failed') {
          patch.ended_at = new Date().toISOString();
          if (msg.error) this.addEvent(s.id, { kind: 'error', text: msg.error });
        }
        if (msg.status === 'idle') patch.waiting_reason = 'Turn finished';
        if (msg.status === 'idle' || msg.status === 'failed') {
          for (const i of this.store.expireInputs(s.id)) this.bus.emit({ t: 'input', input: i });
        }
        const was = s.status;
        this.setStatus(s.id, msg.status, patch);
        if (msg.status === 'idle' && was !== 'idle') {
          const text = this.store.session(s.id)?.last_text ?? 'Claude finished its turn.';
          this.notify(s, `${s.project_key}: waiting for you`, text, `idle-${s.id}`);
        }
        if (msg.status === 'failed') this.notify(s, `${s.project_key}: session failed`, msg.error ?? s.title, `failed-${s.id}`);
        if (msg.status !== 'running') this.dispatch();
        return;
      }
      case 'input_request': {
        const input = this.store.createInput(s.id, msg.local_id, msg.payload);
        this.addEvent(s.id, { kind: 'input_request', input_id: input.id });
        this.bus.emit({ t: 'input', input });
        const reason = msg.payload.kind === 'plan_approval' ? 'Plan ready for approval' : msg.payload.questions[0]?.question ?? 'Question';
        this.setStatus(s.id, 'waiting_input', { waiting_reason: reason });
        this.notify(s, `${s.project_key}: ${msg.payload.kind === 'plan_approval' ? 'approve plan?' : 'question'}`, reason, `input-${input.id}`);
        return;
      }
    }
  }

  onWorkerDisconnect() {
    // Sessions stay in their state; onWorkerHello reconciles when the worker comes back.
  }

  /** The `dispatch` MCP tools the agent calls. */
  async rpc(sessionId: number, method: string, params: unknown): Promise<unknown> {
    const s = this.mustGet(sessionId);
    const p = (params ?? {}) as Record<string, unknown>;
    const project = this.store.project(s.project_id)!;
    const byKey = (key: unknown) => {
      const n = Number(String(key).split('-').pop());
      const it = this.store.itemByNumber(project.id, n);
      if (!it) throw new Error(`No item ${String(key)} in project ${project.key}`);
      return it;
    };
    switch (method) {
      case 'list_items': {
        const status = Array.isArray(p.status) ? (p.status as string[]) : ['triage', 'backlog', 'todo', 'in_progress', 'in_review'];
        return this.store.items(project.id, { type: p.type as string | undefined, status }).map((i) => ({
          key: i.key, id: i.id, type: i.type, title: i.title, status: i.status,
          importance: project.importance_scale[i.importance - 1], effort: i.effort === null ? null : project.effort_scale[i.effort],
        }));
      }
      case 'get_item': {
        const it = byKey(p.key);
        return { ...it, comments: this.store.comments(it.id), source: it.source_id ? this.store.source(it.source_id) : null };
      }
      case 'add_comment': {
        const it = byKey(p.key);
        return this.store.addComment(it.id, 'claude', String(p.body ?? ''), s.id);
      }
      case 'create_item': {
        const parsed = proposedItemSchema.parse(p);
        const item = this.store.createProposedItems(project.id, [parsed], this.agentSource(s).id)[0];
        this.bus.emit({ t: 'item', item });
        return { key: item.key, id: item.id };
      }
      case 'propose': {
        const proposal = proposalSchema.parse(p);
        if (proposal.type === 'items' && !proposal.source_id) proposal.source_id = s.source_id;
        this.addEvent(s.id, { kind: 'proposal', proposal });
        this.notify(s, `${s.project_key}: proposal ready`, proposal.type === 'batch' ? proposal.title : `${proposal.items.length} items`, `proposal-${s.id}`);
        return 'The proposal is shown to the user as a card. They will edit and start it from there. Stop here and wait for their reply.';
      }
      default:
        throw new Error(`Unknown method ${method}`);
    }
  }

  // ---------- internals ----------

  /** Start queued sessions while there are free slots. */
  dispatch() {
    if (!this.hub.connected) return;
    while (this.store.countActive() < this.maxConcurrent) {
      const next = this.store.nextQueued();
      if (!next) return;
      this.hub.send({ t: 'start', spec: this.spec(next, next.initial_prompt, next.sdk_session_id, null) });
      this.setStatus(next.id, 'running');
    }
  }

  spec(s: Session, prompt: string, resume: string | null, resumeNote: string | null): StartSpec {
    const project = this.store.project(s.project_id)!;
    return {
      session_id: s.id,
      kind: s.kind,
      project_key: project.key,
      project_name: project.name,
      importance_scale: project.importance_scale,
      effort_scale: project.effort_scale,
      title: s.title,
      branch: s.branch,
      repos: this.store.repos(project.id),
      items: this.store.itemsByIds(s.item_ids),
      source: s.source_id ? this.store.source(s.source_id) ?? null : null,
      prompt: prompt || 'Work on the items in your instructions.',
      force_plan: s.force_plan,
      resume,
      resume_note: resumeNote,
    };
  }

  private agentSource(s: Session) {
    const existing = this.store.sources(s.project_id).find((src) => src.kind === 'agent_session' && src.session_id === s.id);
    return existing ?? this.store.createSource(s.project_id, {
      kind: 'agent_session', title: `Found during session #${s.id}: ${s.title}`, body_md: '', reporter: 'claude',
      version_tag: null, skill_name: null, session_id: s.id,
    });
  }

  private mustGet(id: number) {
    const s = this.store.session(id);
    if (!s) throw new SessionError('Unknown session', 404);
    return s;
  }

  private setStatus(id: number, status: SessionStatus, patch: Partial<Session> = {}) {
    this.emitSession(this.store.updateSession(id, { ...patch, status }));
  }

  private addEvent(sessionId: number, body: Parameters<Store['addEvent']>[1]) {
    this.bus.emit({ t: 'session_event', event: this.store.addEvent(sessionId, body) });
  }

  private emitSession(s: Session) {
    this.bus.emit({ t: 'session', session: s });
  }

  private notify(s: Session, title: string, body: string, tag: string) {
    void this.notifier.send({ title, body: body.slice(0, 180), url: `/s/${s.id}`, tag, project_id: s.project_id });
  }

  isActive(s: Session) {
    return ACTIVE_STATUSES.includes(s.status);
  }
}
