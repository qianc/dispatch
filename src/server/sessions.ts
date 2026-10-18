// Session lifecycle: creating batches and planner chats, queueing, and applying worker events.
import type { StartSpec, WorkerToServer } from '../shared/protocol.ts';
import {
  ACTIVE_STATUSES,
  CHAT_KINDS,
  FINAL_STATUSES,
  ITEM_STATUSES,
  itemPatch,
  proposedItemSchema,
  type InputAnswer,
  type ItemChanges,
  type Proposal,
  DEFAULT_RUN_OPTIONS,
  type Project,
  type ProposedItem,
  type RunOptions,
  type Session,
  type SessionStatus,
} from '../shared/types.ts';
import { z } from 'zod';
import type { Attachments } from './attachments.ts';
import type { Bus } from './bus.ts';
import type { Notifier } from './notify.ts';
import type { Store } from './store.ts';
import type { WorkerHub } from './workerHub.ts';

/** Two cards of the same kind are versions of one another: same title, or items in common. */
function overlaps(a: Proposal, b: Proposal): boolean {
  if (a.type === 'batch' && b.type === 'batch') {
    return a.title.trim().toLowerCase() === b.title.trim().toLowerCase() || a.item_ids.some((id) => b.item_ids.includes(id));
  }
  if (a.type === 'items' && b.type === 'items') {
    const titles = new Set(a.items.map((i) => i.title.trim().toLowerCase()));
    return b.items.some((i) => titles.has(i.title.trim().toLowerCase()));
  }
  return false;
}

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
    project_key: z.string().optional(),
    title: z.string().min(1),
    item_ids: z.array(z.number().int()).default([]),
    new_items: z.array(proposedItemSchema).default([]),
    prompt: z.string().default(''),
    force_plan: z.boolean().default(false),
  }),
  z.object({ type: z.literal('items'), source_id: z.number().int().nullable().default(null), items: z.array(proposedItemSchema).min(1) }),
  z.object({ type: z.literal('planner'), project_key: z.string(), prompt: z.string().default('') }),
  z.object({
    type: z.literal('item_update'),
    key: z.string(),
    title: z.string().min(1).max(200).optional(),
    body_md: z.string().optional(),
    item_type: z.enum(['backlog', 'bug']).optional(),
    status: z.enum(ITEM_STATUSES).optional(),
    importance: z.union([z.number(), z.string()]).optional(),
    effort: z.union([z.number(), z.string()]).nullable().optional(),
    tags: z.array(z.string()).optional(),
    modules: z.array(z.string()).optional(),
    comment: z.string().optional(),
    reason: z.string().default(''),
  }),
]);

export type AssistantRpc = (s: Session, method: string, params: Record<string, unknown>) => Promise<unknown>;

export class Sessions {
  private store: Store;
  private bus: Bus;
  private hub: WorkerHub;
  private notifier: Notifier;
  private maxConcurrent: number;
  /** Where tool-result images are stored (set by app.ts). */
  attachments: Attachments | null = null;
  /** Tools for assistant chats (set by app.ts; see assistant.ts). */
  assistantRpc: AssistantRpc | null = null;

  constructor(store: Store, bus: Bus, hub: WorkerHub, notifier: Notifier, maxConcurrent: number) {
    this.store = store;
    this.bus = bus;
    this.hub = hub;
    this.notifier = notifier;
    this.maxConcurrent = maxConcurrent;
  }

  // ---------- creation ----------

  /**
   * The Claude account a new session runs on: the requested one (batch override) or the project's
   * default, checked against the project's allowed list and, when the worker has said which accounts
   * it has, against those. null = the legacy default (one unnamed login).
   */
  claudeAccountFor(project: Project | null, requested: string | null | undefined, chat?: 'assistant'): string | null {
    const known = this.hub.claudeAccounts.map((a) => a.name);
    const name = chat === 'assistant'
      ? requested ?? this.store.db.setting('assistant_claude_account') ?? null
      : requested ?? project?.claude_account ?? null;
    const fallback = known.length && !known.includes('default') ? known[0] : null;
    const chosen = name ?? (project?.claude_allowed?.length ? project.claude_allowed[0] : fallback);
    if (!chosen) return null;
    if (known.length && !known.includes(chosen)) throw new SessionError(`Unknown Claude account "${chosen}". The worker has: ${known.join(', ')}.`);
    if (project?.claude_allowed && !project.claude_allowed.includes(chosen)) {
      throw new SessionError(`Project ${project.key} does not allow the Claude account "${chosen}" (allowed: ${project.claude_allowed.join(', ')}).`);
    }
    return chosen === 'default' ? null : chosen;
  }

  /** Remember that a proposal card was acted on, so no device offers it again. */
  assertProposalOpen(ref: { session_id: number; event_id: number } | undefined) {
    if (ref && this.store.events(ref.session_id).some((e) => e.body.kind === 'proposal_done' && e.body.event_id === ref.event_id)) {
      throw new SessionError('This proposal was already used.', 409);
    }
  }

  markProposalDone(ref: { session_id: number; event_id: number } | undefined, note: string) {
    if (!ref || !this.store.session(ref.session_id)) return;
    this.assertProposalOpen(ref);
    this.addEvent(ref.session_id, { kind: 'proposal_done', event_id: ref.event_id, note });
    // the cards it revised (from turns before it) cannot be started any more either
    const accepted = this.store.events(ref.session_id).find((e) => e.id === ref.event_id);
    if (accepted) this.closeOlderProposals(ref.session_id, accepted.seq, 'Not used: a later version was started');
    this.closePlannerAfterProposal(ref.session_id);
  }

  /**
   * In a planning chat, a proposal from a later turn replaces the open ones of the same kind
   * before it (you asked for a change). Open cards from turns before `seq` get a note instead of Start buttons; cards
   * proposed together in one turn stay open (they are meant side by side).
   */
  private closeOlderProposals(sessionId: number, seq: number, note: string) {
    const s = this.store.session(sessionId);
    if (!s || s.kind !== 'planner') return;
    const events = this.store.events(sessionId);
    const newer = events.find((e) => e.seq === seq);
    // only the same kind of card is a revision: a new batch replaces a batch, a new item list an
    // item list; filing an extra item leaves the batch on offer
    if (newer?.body.kind !== 'proposal') return;
    const card = newer.body.proposal;
    const turnStart = Math.max(0, ...events.filter((e) => e.body.kind === 'user' && e.seq < seq).map((e) => e.seq));
    const done = new Set(events.flatMap((e) => (e.body.kind === 'proposal_done' ? [e.body.event_id] : [])));
    for (const e of events) {
      if (e.body.kind !== 'proposal' || e.seq >= seq || done.has(e.id) || e.body.proposal.type !== card.type) continue;
      // from an earlier turn, or a version of the same card (same title or shared items) in this one;
      // cards with nothing in common in one turn are meant side by side
      if (e.seq < turnStart || overlaps(e.body.proposal, card)) this.addEvent(sessionId, { kind: 'proposal_done', event_id: e.id, note });
    }
  }

  /** Sessions that proposed something this turn: the push is sent when the turn ends. */
  private proposalNotice = new Map<number, string>();

  /** Planning chats whose proposal was accepted while Claude was still writing: complete them at turn end. */
  private closeWhenIdle = new Set<number>();

  /**
   * A planning chat has done its job once you accept its proposal: mark it complete. If Claude is
   * still writing, wait for the end of the turn. A message to it later reopens it, as usual.
   */
  private closePlannerAfterProposal(sessionId: number) {
    const s = this.store.session(sessionId);
    if (!s || s.kind !== 'planner' || FINAL_STATUSES.includes(s.status)) return;
    // another card is still on offer (e.g. the batch, after filing an extra item): the chat stays open
    const events = this.store.events(sessionId);
    const done = new Set(events.flatMap((e) => (e.body.kind === 'proposal_done' ? [e.body.event_id] : [])));
    if (events.some((e) => e.body.kind === 'proposal' && !done.has(e.id))) return;
    if (s.status === 'running' || s.status === 'queued') this.closeWhenIdle.add(s.id);
    else this.finish(s.id, 'completed');
  }

  startBatch(project: Project, input: { title?: string; item_ids: number[]; new_items: ProposedItem[]; prompt: string; force_plan?: boolean; source_id?: number | null; options?: RunOptions; proposal?: { session_id: number; event_id: number } }): Session {
    this.assertProposalOpen(input.proposal);
    const claudeAccount = this.claudeAccountFor(project, input.options?.claude_account);
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
      options: input.options ?? DEFAULT_RUN_OPTIONS,
      claude_account: claudeAccount,
    });
    session = this.store.updateSession(session.id, { branch: branchName(project.key, session.id, all.length === 1 || !input.title?.trim() ? all[0]?.title ?? title : title) });
    for (const it of all) this.bus.emit({ t: 'item', item: this.store.updateItem(it.id, { status: 'in_progress', marked: false }) });
    this.markProposalDone(input.proposal, `Started session #${session.id}`);
    this.emitSession(session);
    this.dispatch();
    return this.store.session(session.id)!;
  }

  /** A chat (assistant or discuss): continue the open thread, or start one on the first message. */
  private chatSend(open: Session | undefined, create: () => Session, text: string): Session {
    if (open) {
      this.send(open.id, text);
      return this.store.session(open.id)!;
    }
    if (!this.hub.connected) throw new SessionError('Worker is not connected.', 503);
    const s = create();
    this.addEvent(s.id, { kind: 'user', text });
    this.hub.send({ t: 'start', spec: this.spec(s, text, null, null) });
    this.setStatus(s.id, 'running');
    return this.store.session(s.id)!;
  }

  /** The assistant chat: one open thread at a time. */
  assistantSend(text: string): Session {
    return this.chatSend(this.currentAssistant(), () => this.store.createSession({
      project_id: null, kind: 'assistant', title: 'Assistant', status: 'queued', force_plan: false, branch: null,
      initial_prompt: text, source_id: null, item_ids: [], claude_account: this.claudeAccountFor(null, null, 'assistant'),
    }), text);
  }

  currentAssistant(): Session | undefined {
    return this.store.sessions({ kind: 'assistant', limit: 1 }).find((s) => !FINAL_STATUSES.includes(s.status));
  }

  /** "Discuss this" on an item: a read-only chat about it, one open thread per item. */
  discussSend(itemId: number, text: string): Session {
    const item = this.store.item(itemId);
    if (!item) throw new SessionError('Unknown item', 404);
    return this.chatSend(this.currentDiscuss(itemId), () => this.store.createSession({
      project_id: item.project_id, kind: 'discuss', title: `Discuss ${item.key}`, status: 'queued', force_plan: false, branch: null,
      initial_prompt: text, source_id: item.source_id, item_ids: [item.id], claude_account: this.claudeAccountFor(this.store.project(item.project_id)!, null),
    }), text);
  }

  currentDiscuss(itemId: number): Session | undefined {
    return this.store.sessionsForItem(itemId, 'discuss').find((s) => !FINAL_STATUSES.includes(s.status));
  }

  startPlanner(project: Project, input: { prompt: string; source_id: number | null; proposal?: { session_id: number; event_id: number } }): Session {
    this.assertProposalOpen(input.proposal);
    const source = input.source_id ? this.store.source(input.source_id) : null;
    if (input.source_id && (!source || source.project_id !== project.id)) throw new SessionError('Unknown source', 404);
    const title = source ? `Split: ${source.title}` : input.prompt.trim() ? `Plan: ${input.prompt.trim().slice(0, 60)}` : 'Plan next batch';
    const prompt = input.prompt.trim() || (source
      ? 'Read the source document in your instructions and split it into backlog items and bugs. Call propose_items with the result.'
      : 'Look at the open backlog, bugs and the code, and propose the next batch of work. Call propose_batch with your suggestion.');
    const session = this.store.createSession({
      project_id: project.id, kind: 'planner', title, status: 'queued', force_plan: false, branch: null,
      initial_prompt: prompt, source_id: source?.id ?? null, item_ids: [], claude_account: this.claudeAccountFor(project, null),
    });
    this.markProposalDone(input.proposal, `Started planning chat #${session.id}`);
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
  /** Called once a session is finished (app.ts wires it to the janitor, which tidies its folders). */
  onFinished: ((s: Session, status: 'completed' | 'stopped', removeAll: boolean) => void) | null = null;

  finish(sessionId: number, status: 'completed' | 'stopped', cleanup = false) {
    const s = this.mustGet(sessionId);
    // the janitor removes worktrees and merged branches after the runner has stopped
    this.hub.send({ t: 'close', session_id: sessionId, cleanup: false, repos: this.reposOf(s) });
    for (const i of this.store.expireInputs(sessionId)) this.bus.emit({ t: 'input', input: i });
    if (status === 'stopped' && s.kind === 'work') {
      for (const it of this.store.itemsByIds(s.item_ids)) {
        if (it.status === 'in_progress') this.bus.emit({ t: 'item', item: this.store.updateItem(it.id, { status: 'todo' }) });
      }
    }
    this.setStatus(sessionId, status, { ended_at: new Date().toISOString(), waiting_reason: null });
    this.onFinished?.(this.store.session(sessionId)!, status, cleanup);
    this.dispatch();
  }

  // ---------- worker events ----------

  onWorkerHello(live: number[]) {
    // Runners the worker still has but we consider finished (closed while it was disconnected): stop them.
    for (const id of live) {
      const s = this.store.session(id);
      if (!s || FINAL_STATUSES.includes(s.status) || s.status === 'queued') {
        this.hub.send({ t: 'close', session_id: id, cleanup: false, repos: s ? this.reposOf(s) : [] });
      }
    }
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
    if (FINAL_STATUSES.includes(s.status)) {
      // A runner that should not exist any more (closed while the worker was away): ignore it and stop it.
      if (msg.t !== 'status') this.hub.send({ t: 'close', session_id: s.id, cleanup: false, repos: this.reposOf(s) });
      return;
    }
    switch (msg.t) {
      case 'notice': {
        this.addEvent(s.id, { kind: 'error', text: `${msg.title}\n${msg.body}` });
        this.notify(s, `${s.project_key ?? 'Dispatch'}: ${msg.title}`, msg.body, `notice-${s.id}`);
        return;
      }
      case 'event': {
        if (msg.images?.length && msg.body.kind === 'tool_result' && this.attachments) {
          msg.body.images = this.attachments.save(s.id, msg.images);
        }
        this.addEvent(s.id, msg.body);
        if (msg.body.kind === 'assistant') this.emitSession(this.store.updateSession(s.id, { last_text: msg.body.text.slice(0, 300) }));
        if (msg.body.kind === 'result') {
          const u = s.usage ?? {};
          // cost is a running total per Claude session (kept across resume); turns are per turn
          const usage = { ...u, cost_usd: Math.max(u.cost_usd ?? 0, msg.body.cost_usd ?? 0), turns: (u.turns ?? 0) + (msg.body.turns ?? 0) };
          this.emitSession(this.store.updateSession(s.id, { usage }));
        }
        return;
      }
      case 'status': {
        const patch: Partial<Session> = {};
        if (msg.sdk_session_id) patch.sdk_session_id = msg.sdk_session_id;
        if (msg.status === 'failed') {
          patch.ended_at = new Date().toISOString();
          if (msg.error) this.addEvent(s.id, { kind: 'error', text: msg.error });
        }
        if (msg.status === 'idle') patch.waiting_reason = 'Turn finished';
        if (msg.status === 'running') patch.waiting_reason = null;
        if (msg.status === 'idle' || msg.status === 'failed') {
          for (const i of this.store.expireInputs(s.id)) this.bus.emit({ t: 'input', input: i });
        }
        const was = s.status;
        this.setStatus(s.id, msg.status, patch);
        const proposed = msg.status === 'running' ? undefined : this.proposalNotice.get(s.id);
        if (msg.status !== 'running') this.proposalNotice.delete(s.id);
        if (msg.status === 'idle' && this.closeWhenIdle.delete(s.id)) {
          this.finish(s.id, 'completed'); // its proposal was accepted during the turn
          return;
        }
        // with auto-merge on, the merge check speaks for this turn (merged / not merged / branch behind);
        // "waiting for you" goes out only if it said nothing
        const mergeSpeaks = msg.status === 'idle' && s.kind === 'work' && s.options.auto_merge !== 'off' && was !== 'idle';
        if (mergeSpeaks) this.settling.add(s.id); // queued "after" batches wait for this merge check
        const idleWork = msg.status === 'idle' && s.kind === 'work' ? this.onWorkIdle?.(this.store.session(s.id)!) : undefined;
        if (mergeSpeaks) {
          void (idleWork ?? Promise.resolve(false)).finally(() => {
            this.settling.delete(s.id);
            this.dispatch();
          });
        }
        if (msg.status === 'idle' && proposed !== undefined) {
          // one notice for the turn: the proposal, with Claude's explanation
          const text = this.store.session(s.id)?.last_text || proposed;
          this.notify(s, `${s.project_key ?? 'Assistant'}: proposal ready`, text, `proposal-${s.id}`);
        } else if (msg.status === 'idle' && was !== 'idle' && !CHAT_KINDS.includes(s.kind)) {
          const waiting = () => {
            const text = this.store.session(s.id)?.last_text ?? 'Claude finished its turn.';
            this.notify(s, `${s.project_key}: waiting for you`, text, `idle-${s.id}`);
          };
          if (mergeSpeaks && idleWork) void idleWork.then((told) => !told && waiting(), waiting);
          else waiting();
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
        this.notify(s, `${s.project_key ?? 'Assistant'}: ${msg.payload.kind === 'plan_approval' ? 'approve plan?' : 'question'}`, reason, `input-${input.id}`);
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
    if (s.kind === 'assistant') {
      if (!this.assistantRpc) throw new Error('Assistant tools are not available');
      return this.assistantRpc(s, method, p);
    }
    if (s.kind === 'discuss' && !['get_item', 'list_items', 'get_image', 'propose'].includes(method)) throw new Error('A discussion is read-only.');
    if (s.kind === 'discuss' && method === 'propose' && (p as { type?: string }).type !== 'item_update') throw new Error('A discussion can only suggest item changes.');
    const project = this.store.project(s.project_id!)!;
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
          // comments hold decisions and open points: read the item with get_item when it has any
          comments: this.store.comments(i.id).length,
        }));
      }
      case 'get_item': {
        const it = byKey(p.key);
        const images = this.store.itemImages(it.id).map((i) => ({ id: i.id, name: i.name, author: i.author, comment_id: i.comment_id }));
        return { ...it, comments: this.store.comments(it.id), source: it.source_id ? this.store.source(it.source_id) : null, images };
      }
      case 'get_image': {
        const img = this.store.itemImage(Number(p.id));
        if (!img || this.store.item(img.item_id)?.project_id !== project.id) throw new Error(`No image ${String(p.id)} in project ${project.key}`);
        const data = await this.attachments?.readItemImage(img.item_id, img.file);
        if (!data) throw new Error('The image file is missing');
        return { name: img.name, mime: img.mime, data: data.toString('base64') };
      }
      case 'add_comment': {
        const it = byKey(p.key);
        return this.store.addComment(it.id, 'claude', String(p.body ?? ''), s.id);
      }
      case 'add_to_batch': {
        if (s.kind !== 'work') throw new Error('Only a work session has a batch.');
        const keys = Array.isArray(p.keys) ? [...new Set((p.keys as unknown[]).map((k) => String(k).toUpperCase()))] : [];
        if (!keys.length) throw new Error('Give the item keys, e.g. ["HC-3"]');
        const items = keys.map(byKey);
        this.store.addSessionItems(s.id, items.map((i) => i.id));
        for (const it of items) {
          // closed items stay closed; open ones are now being worked on here
          if (['triage', 'backlog', 'todo', 'hold'].includes(it.status)) this.bus.emit({ t: 'item', item: this.store.updateItem(it.id, { status: 'in_progress' }) });
        }
        this.addEvent(s.id, { kind: 'system', text: `Added to this batch: ${items.map((i) => i.key).join(', ')}` });
        this.emitSession(this.store.session(s.id)!);
        return { batch: this.store.itemsByIds(this.store.session(s.id)!.item_ids).map((i) => ({ key: i.key, title: i.title, status: i.status })) };
      }
      case 'create_item': {
        const parsed = proposedItemSchema.parse(p);
        const item = this.store.createProposedItems(project.id, [parsed], this.agentSource(s).id)[0];
        this.bus.emit({ t: 'item', item });
        return { key: item.key, id: item.id };
      }
      case 'propose':
        return this.propose(s, p);
      default:
        throw new Error(`Unknown method ${method}`);
    }
  }

  /** Show a proposal card in the session's transcript. */
  propose(s: Session, raw: unknown): string {
    const parsed = proposalSchema.parse(raw);
    if (parsed.type === 'item_update') return this.proposeItemUpdate(s, parsed);
    const proposal = parsed;
    if (proposal.type === 'items' && !proposal.source_id) proposal.source_id = s.source_id;
    const seq = this.addEvent(s.id, { kind: 'proposal', proposal })?.seq;
    if (seq) this.closeOlderProposals(s.id, seq, 'Replaced by a newer proposal below');
    const what = proposal.type === 'items' ? `${proposal.items.length} items` : proposal.type === 'planner' ? `planning chat for ${proposal.project_key}` : proposal.title;
    // the push goes out when the turn ends, with the explanation (one notice, not two)
    this.proposalNotice.set(s.id, what);
    return 'The proposal will be shown to the owner as a card below your reply, once your turn ends. Now explain it briefly: what is in it and why. Then stop and wait for their reply.';
  }

  /** Discuss: show a suggested change to an item as a card; nothing changes until the owner applies it. */
  private proposeItemUpdate(s: Session, p: Extract<z.infer<typeof proposalSchema>, { type: 'item_update' }>): string {
    const project = this.store.project(s.project_id!)!;
    const it = this.store.itemByNumber(project.id, Number(p.key.split('-').pop()));
    if (!it) throw new Error(`No item ${p.key} in project ${project.key}`);
    const scaleIndex = (scale: string[], v: number | string, offset: number) => {
      const byLabel = scale.findIndex((l) => l.toLowerCase() === String(v).toLowerCase());
      if (byLabel >= 0) return byLabel + offset;
      const n = Number(v);
      if (Number.isInteger(n) && n - offset >= 0 && n - offset < scale.length) return n;
      throw new Error(`"${v}" is not on the project's scale: ${scale.join(', ')}`);
    };
    const changes: ItemChanges = {};
    if (p.title !== undefined && p.title !== it.title) changes.title = p.title;
    if (p.body_md !== undefined && p.body_md !== it.body_md) changes.body_md = p.body_md;
    if (p.item_type !== undefined && p.item_type !== it.type) changes.type = p.item_type;
    if (p.status !== undefined && p.status !== it.status) changes.status = p.status;
    if (p.importance !== undefined) {
      const v = scaleIndex(project.importance_scale, p.importance, 1);
      if (v !== it.importance) changes.importance = v;
    }
    if (p.effort !== undefined) {
      const v = p.effort === null || p.effort === '' ? null : scaleIndex(project.effort_scale, p.effort, 0);
      if (v !== it.effort) changes.effort = v;
    }
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (p.tags !== undefined && !same(p.tags, it.labels)) changes.labels = p.tags;
    if (p.modules !== undefined && !same(p.modules, it.modules)) changes.modules = p.modules;
    const comment = p.comment?.trim() || null;
    if (!Object.keys(changes).length && !comment) throw new Error('Nothing to change: every value is already as proposed.');
    const before: ItemChanges = {};
    for (const k of Object.keys(changes) as (keyof ItemChanges)[]) {
      const field = k === 'type' ? it.type : it[k as keyof typeof it];
      (before as Record<string, unknown>)[k] = field;
    }
    this.addEvent(s.id, { kind: 'proposal', proposal: { type: 'item_update', item_id: it.id, item_key: it.key, changes, before, comment, reason: p.reason } });
    return 'The change is shown to the owner as a card with Apply and Dismiss, below your reply. Nothing has changed yet. Say in one or two sentences what you propose and why, then stop.';
  }

  /** The owner applied a suggested item change from a Discuss chat. */
  applyItemUpdate(sessionId: number, eventId: number) {
    const ev = this.store.events(sessionId).find((e) => e.id === eventId);
    if (!ev || ev.body.kind !== 'proposal' || ev.body.proposal.type !== 'item_update') throw new SessionError('Unknown proposal', 404);
    const ref = { session_id: sessionId, event_id: eventId };
    this.assertProposalOpen(ref);
    const p = ev.body.proposal;
    const it = this.store.item(p.item_id);
    if (!it) throw new SessionError('The item was deleted.', 404);
    const patch = itemPatch.parse(p.changes);
    const updated = Object.keys(patch).length ? this.store.updateItem(it.id, patch) : it;
    if (p.comment) this.store.addComment(it.id, 'claude', p.comment, sessionId);
    this.bus.emit({ t: 'item', item: updated });
    const parts = [Object.keys(patch).length ? `${Object.keys(patch).length} change${Object.keys(patch).length === 1 ? '' : 's'}` : '', p.comment ? 'a comment' : ''].filter(Boolean);
    this.markProposalDone(ref, `Applied to ${it.key}: ${parts.join(' and ')}`);
    return updated;
  }

  // ---------- internals ----------

  private reposOf(s: Session) {
    return s.project_id ? this.store.repos(s.project_id) : [];
  }

  /**
   * Start queued sessions while slots are free (MAX_CONCURRENT_SESSIONS). `now` runs alongside
   * whatever is running; `after` also waits until earlier work in the same project has stopped
   * working (finished its turn, or ended).
   */
  /** Work sessions whose turn just ended and whose branches are being checked and auto-merged. */
  private settling = new Set<number>();

  /**
   * Why a queued "after" batch cannot start yet, or null. It waits until each earlier batch in its
   * project is settled: not working, and (with auto-merge) its branches merged, so it starts from
   * the main branch with that work in it. A batch whose auto-merge stopped holds the queue too.
   */
  waitingFor(next: Session): string | null {
    for (const e of this.store.earlierWork(next)) {
      const name = `#${e.id} ${e.title.length > 40 ? `${e.title.slice(0, 40)}…` : e.title}`;
      if (['queued', 'running', 'waiting_input'].includes(e.status)) return `Waiting for ${name} to finish`;
      if (e.options.auto_merge === 'off') continue;
      if (this.settling.has(e.id)) return `Waiting for ${name} to merge`;
      const open = this.store.prs({ session_id: e.id }).filter((p) => p.state === 'open');
      if (!open.length) continue;
      const stuck = open.find((p) => p.blocked || p.mergeable === false);
      return stuck ? `Waiting for ${name} to merge: ${stuck.blocked ?? 'it has merge conflicts'}` : `Waiting for ${name} to merge`;
    }
    return null;
  }

  dispatch() {
    if (!this.hub.connected) return;
    for (const next of this.store.queued()) {
      if (this.store.countActive() >= this.maxConcurrent) return;
      if (next.kind === 'work' && next.options.start === 'after') {
        const reason = this.waitingFor(next);
        if (reason) {
          if (next.waiting_reason !== reason) this.emitSession(this.store.updateSession(next.id, { waiting_reason: reason }));
          continue;
        }
      }
      this.hub.send({ t: 'start', spec: this.spec(next, next.initial_prompt, next.sdk_session_id, null) });
      this.setStatus(next.id, 'running', { waiting_reason: null });
    }
  }

  /** "Start anyway": a queued batch stops waiting for earlier ones. */
  startNow(sessionId: number) {
    const s = this.mustGet(sessionId);
    if (s.status !== 'queued') throw new SessionError('Only a queued session can be started.');
    this.store.updateSession(s.id, { options: { ...s.options, start: 'now' } });
    this.addEvent(s.id, { kind: 'system', text: 'Started without waiting for the earlier batches.' });
    this.dispatch();
    return this.store.session(s.id)!;
  }

  /**
   * Called when a work session finishes a turn (app.ts wires it to the GitHub sync). Resolves true
   * if the owner was already told something about this turn (auto-merge result).
   */
  onWorkIdle: ((s: Session) => Promise<boolean>) | null = null;

  spec(s: Session, prompt: string, resume: string | null, resumeNote: string | null): StartSpec {
    const project = s.project_id ? this.store.project(s.project_id) : undefined;
    return {
      session_id: s.id,
      kind: s.kind,
      project_key: project?.key ?? '',
      project_name: project?.name ?? '',
      importance_scale: project?.importance_scale ?? [],
      effort_scale: project?.effort_scale ?? [],
      title: s.title,
      branch: s.branch,
      repos: this.reposOf(s),
      items: this.store.itemsByIds(s.item_ids).map((i) => ({
        ...i,
        image_count: this.store.itemImages(i.id).length,
        comments: this.store.comments(i.id).map((c) => ({ author: c.author, body_md: c.body_md, created_at: c.created_at })),
      })),
      source: s.source_id ? this.store.source(s.source_id) ?? null : null,
      prompt: prompt || 'Work on the items in your instructions.',
      force_plan: s.force_plan,
      options: s.options,
      claude_account: s.claude_account,
      github_account: project?.github_account ?? null,
      resume,
      resume_note: resumeNote,
    };
  }

  private agentSource(s: Session) {
    const projectId = s.project_id!;
    const existing = this.store.sources(projectId).find((src) => src.kind === 'agent_session' && src.session_id === s.id);
    return existing ?? this.store.createSource(projectId, {
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
    const event = this.store.addEvent(sessionId, body);
    this.bus.emit({ t: 'session_event', event });
    return event;
  }

  private emitSession(s: Session) {
    this.bus.emit({ t: 'session', session: s });
  }

  private notify(s: Session, title: string, body: string, tag: string) {
    const url = s.kind === 'assistant' ? '/assistant' : s.kind === 'discuss' ? `/items/${s.item_ids[0]}/discuss` : `/s/${s.id}`;
    void this.notifier.send({ title, body: body.slice(0, 180), url, tag, project_id: s.project_id ?? undefined });
  }

  isActive(s: Session) {
    return ACTIVE_STATUSES.includes(s.status);
  }
}
