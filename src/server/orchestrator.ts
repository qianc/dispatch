// Orchestrations: a long-running session that holds a plan of steps over one or more projects and
// starts each step as a batch. Every rule is enforced here, whatever the orchestrator's prompt says:
// its scope, the owner's approval of the plan, the order of the steps and the number at once.
import type { StartSpec } from '../shared/protocol.ts';
import { autoMergePending, failureReason } from '../shared/attention.ts';
import { FINAL_STATUSES, planInput, proposedItemSchema, sessionStatusWords, type Attention, type DeployState, type LiveEvent, type Orchestration, type OrchestrationStep, type PendingInput, type Project, type Repo, type Session, type StepState } from '../shared/types.ts';
import type { z } from 'zod';
import type { orchestrationInput } from '../shared/types.ts';
import type { Bus } from './bus.ts';
import type { Notifier } from './notify.ts';
import { assertWritable } from './projectLock.ts';
import { SessionError, type Sessions } from './sessions.ts';
import type { Store } from './store.ts';

const ITEM_KEY = /^([A-Z][A-Z0-9]*)-(\d+)$/;

/** Steps whose dependants may start. */
const SETTLED = ['done', 'skipped'];

export class Orchestrator {
  private store: Store;
  private bus: Bus;
  private sessions: Sessions;
  private notifier: Notifier;
  /** orchestrator sessions that proposed a plan this turn: the push goes out when the turn ends */
  private planNotice = new Set<number>();

  /** ids of the PRs Dispatch merges at this moment (a deploy may follow such a merge) */
  private merging: () => ReadonlySet<number>;
  private off: () => void;

  constructor(deps: { store: Store; bus: Bus; sessions: Sessions; notifier: Notifier; merging?: () => ReadonlySet<number> }) {
    this.store = deps.store;
    this.bus = deps.bus;
    this.sessions = deps.sessions;
    this.notifier = deps.notifier;
    this.merging = deps.merging ?? (() => new Set());
    this.off = this.bus.on((e) => this.onBus(e));
    this.timer = setInterval(() => this.safely(() => this.checkDelegated()), 60_000);
    this.timer.unref();
  }

  stop() {
    this.off();
    clearInterval(this.timer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private timer: NodeJS.Timeout;

  /**
   * After a server start: catch up with what the batches did meanwhile, and deliver the events
   * that were still waiting.
   */
  resume() {
    for (const o of this.store.orchestrations()) {
      if (o.phase === 'done' || o.phase === 'stopped') continue;
      for (const step of o.steps) this.safely(() => this.sync(step.id));
      this.safely(() => this.flush(o.session_id));
    }
    // questions that waited for an orchestrator too long while the server was down
    this.safely(() => this.checkDelegated());
  }

  /** The bus calls listeners inside whoever emitted: an error here must not break them. */
  private safely(fn: () => void) {
    try {
      fn();
    } catch (e) {
      console.warn('orchestrator:', (e as Error).message);
    }
  }

  // ---------- reading ----------

  private must(sessionId: number): Orchestration {
    const o = this.store.orchestration(sessionId);
    if (!o) throw new SessionError('Unknown orchestration', 404);
    return o;
  }

  /** An orchestration with the one line that says what it waits for. */
  view(sessionId: number): Orchestration {
    return this.shown(this.must(sessionId));
  }

  list(): Orchestration[] {
    return this.store.orchestrations().map((o) => this.shown(o));
  }

  /** With what it waits for, and each step's batch. */
  private shown(o: Orchestration): Orchestration {
    const steps = o.steps.map((s) => {
      const c = s.child_session_id ? this.store.session(s.child_session_id) : undefined;
      return { ...s, child: c ? { id: c.id, status: c.status, title: c.title, waiting_reason: c.waiting_reason } : null };
    });
    return { ...o, steps, waiting: this.waitingOf(o) };
  }

  /** What an idle orchestrator needs from its owner, or null while it only waits for its steps. */
  attention(sessionId: number): Attention | null {
    const o = this.store.orchestration(sessionId);
    if (!o) return null;
    // while it plans, its turn end is a question to the owner or a plan to approve
    if (o.phase === 'plan') {
      return { kind: 'plan', text: o.steps.length && !o.plan_approved ? 'The plan is ready: read it and approve it.' : 'It waits for your reply before it can plan.' };
    }
    if (o.phase !== 'run') return null;
    const failed = o.steps.find((s) => s.state === 'failed');
    if (failed) return { kind: 'step_failed', step_id: failed.id, text: `Step ${failed.position} failed.${this.heldText(o, failed)}` };
    // no step at work: it stopped to ask or to tell the owner something, or a step waits for their review
    return this.waitsForSteps(o) ? null : { kind: 'plan', text: this.waitingOf(o) ?? 'It waits for your reply.' };
  }

  /** For a step's batch: which orchestration and step it is part of. */
  partOf(s: Session): { orchestrator_id: number; title: string; step_position: number | null; step_count: number } | null {
    const o = s.orchestrator_id ? this.store.orchestration(s.orchestrator_id) : undefined;
    if (!o) return null;
    return { orchestrator_id: o.session_id, title: o.title, step_position: this.store.stepOfChild(s.id)?.position ?? null, step_count: o.steps.length };
  }

  private waitingOf(o: Orchestration): string | null {
    if (o.phase === 'done' || o.phase === 'stopped') return null;
    if (o.phase === 'paused') return 'Paused';
    if (o.phase === 'plan') return o.steps.length && !o.plan_approved ? 'Plan ready to approve' : null;
    const failed = o.steps.find((s) => s.state === 'failed');
    if (failed) return `Step ${failed.position} failed`;
    const review = o.steps.find((s) => s.state === 'review');
    if (review) return `Step ${review.position} waits for your review`;
    const running = o.steps.find((s) => s.state === 'running');
    if (running) {
      const child = running.child_session_id ? this.store.session(running.child_session_id) : undefined;
      return `Waiting for #${running.child_session_id} (${running.note ?? (child ? sessionStatusWords(child.status) : 'working')}) in ${running.project_key}`;
    }
    return null;
  }

  private projectsOf(o: Orchestration): Project[] {
    return o.project_ids.flatMap((id) => this.store.project(id) ?? []);
  }

  /** What an orchestrator session spans: for its checkouts, its GitHub identity and its start spec. */
  spans(s: Session): { repos: Repo[]; first: Project | undefined; spec: NonNullable<StartSpec['orchestration']> } | null {
    const o = this.store.orchestration(s.id);
    if (!o) return null;
    const projects = this.projectsOf(o);
    return {
      repos: projects.flatMap((p) => this.store.repos(p.id)),
      first: projects[0],
      spec: {
        goal: o.goal,
        phase: o.phase,
        projects: projects.map((p) => ({
          key: p.key, name: p.name, importance_scale: p.importance_scale, effort_scale: p.effort_scale,
          repos: this.store.repos(p.id).map((r) => r.github_name),
        })),
        max_children: o.max_children,
        answer_children: o.answer_children,
        status_md: this.statusText(o),
      },
    };
  }

  /** The steps that can start now: pending, in an approved running plan, with every step before them settled. */
  readySteps(o: Orchestration): OrchestrationStep[] {
    if (o.phase !== 'run') return [];
    const state = new Map(o.steps.map((s) => [s.id, s.state]));
    return o.steps.filter((s) => s.state === 'pending' && s.depends_on.every((d) => SETTLED.includes(state.get(d) ?? 'skipped')));
  }

  /** The plan as the orchestrator reads it: each step with its state, and what can start. */
  statusText(o: Orchestration): string {
    if (!o.steps.length) return 'No plan yet.';
    const place = new Map(o.steps.map((s) => [s.id, s.position]));
    const lines = o.steps.map((s) => {
      const after = s.depends_on.flatMap((d) => place.get(d) ?? []);
      const facts = [`step_id ${s.id}`, s.child_session_id ? `session #${s.child_session_id}` : '', after.length ? `after ${after.join(', ')}` : ''].filter(Boolean);
      return `${s.position}. [${s.state}${s.note ? `: ${s.note}` : ''}] ${s.project_key} — ${s.title} (${facts.join(', ')})`;
    });
    const ready = this.readySteps(o);
    const running = o.steps.filter((s) => s.state === 'running').length;
    const can = o.phase !== 'run' ? `none (${o.phase === 'plan' ? 'the owner has not approved the plan' : `the orchestration is ${o.phase}`})`
      : !ready.length ? 'none'
      : running >= o.max_children ? 'none (limit reached)'
      : ready.map((s) => s.id).join(', ');
    return [`Plan now (phase ${o.phase}, at most ${o.max_children} at once):`, ...lines, `Ready to start: ${can}`].join('\n');
  }

  private emit(sessionId: number) {
    this.bus.emit({ t: 'orchestration', orchestration: this.view(sessionId) });
  }

  // ---------- starting ----------

  start(input: z.infer<typeof orchestrationInput>, startedBy: string | null): Orchestration {
    const keys = [...new Set(input.project_keys.map((k) => k.trim().toUpperCase()))];
    const projects = keys.map((k) => {
      const p = this.store.projectByKey(k);
      if (!p) throw new SessionError(`Unknown project ${k}`);
      assertWritable(this.store, p);
      return p;
    });
    const title = input.title?.trim() || input.goal.split('\n')[0].slice(0, 60);
    const prompt = `${input.goal}\n\nRead the trackers and the code of the projects in your instructions, ask me what is unclear, and then propose the plan with set_plan.`;
    const session = this.sessions.startOrchestrator({ title, prompt, first: projects[0] }, startedBy, (s) =>
      this.store.createOrchestration({ session_id: s.id, goal: input.goal, project_ids: projects.map((p) => p.id), max_children: input.max_children, options: input.options, answer_children: input.answer_children }));
    this.emit(session.id);
    return this.view(session.id);
  }

  // ---------- the orchestrator's tools ----------

  private scope(o: Orchestration, key: unknown): Project {
    const k = String(key ?? '').trim().toUpperCase();
    const p = this.store.projectByKey(k);
    if (!p || !o.project_ids.includes(p.id)) throw new Error(`Project ${k || '(none)'} is not in this orchestration's scope (${o.project_keys.join(', ')}).`);
    return p;
  }

  /** The project of an item key such as AA-12, which must be in scope. */
  private projectOfKey(o: Orchestration, key: unknown): Project {
    const m = String(key ?? '').trim().toUpperCase().match(ITEM_KEY);
    if (!m) throw new Error(`Give the item key with its project, e.g. ${o.project_keys[0]}-12.`);
    return this.scope(o, m[1]);
  }

  async rpc(s: Session, method: string, p: Record<string, unknown>): Promise<unknown> {
    const o = this.must(s.id);
    switch (method) {
      case 'list_projects':
        return this.projectsOf(o).map((pr) => ({
          key: pr.key, name: pr.name, description: pr.description, disabled: pr.disabled,
          repos: this.store.repos(pr.id).map((r) => r.github_name),
          importance_scale: pr.importance_scale, effort_scale: pr.effort_scale,
        }));
      case 'list_items':
        return this.sessions.listItems(this.scope(o, p.project_key), p);
      case 'get_item':
      case 'add_comment':
        return this.sessions.itemRpc(s, method, p, this.projectOfKey(o, p.key));
      case 'get_image': {
        const img = this.store.itemImage(Number(p.id));
        const project = img ? this.store.project(this.store.item(img.item_id)?.project_id ?? -1) : undefined;
        if (!project || !o.project_ids.includes(project.id)) throw new Error(`No image ${String(p.id)} in this orchestration's projects`);
        return this.sessions.itemRpc(s, method, p, project);
      }
      case 'create_item': {
        const project = this.scope(o, p.project_key);
        assertWritable(this.store, project);
        const item = this.store.createProposedItems(project.id, [proposedItemSchema.parse(p)], this.sessions.agentSource(s, project.id).id)[0];
        this.bus.emit({ t: 'item', item });
        return { key: item.key, id: item.id };
      }
      case 'update_item': {
        const project = this.projectOfKey(o, p.key);
        assertWritable(this.store, project);
        const it = this.itemOf(project, p.key);
        // otherwise it could reopen a closed item and then start it as a step
        if (p.status !== undefined && p.status !== it.status && ['done', 'canceled', 'in_review', 'in_progress'].includes(it.status)) {
          throw new Error(`${it.key} is ${it.status.replace('_', ' ')}: an orchestrator does not change the status of an item that is closed or being worked on.`);
        }
        return this.sessions.scheduledItemUpdate(s, project, it, p);
      }
      case 'set_plan':
        return this.setPlan(s, o, p);
      case 'start_step':
        return this.startStep(s, o, this.stepOf(o, p.step_id));
      case 'update_step':
        return this.updateStep(o, this.stepOf(o, p.step_id), p);
      case 'get_session':
        return this.childView(o, Number(p.session_id));
      case 'finish':
        return this.finish(s, o, String(p.result ?? '').trim());
      case 'answer_session':
        return this.answerSession(s, o, p);
      case 'hand_to_owner': {
        const input = this.ownInput(o, p.input_id);
        const reason = String(p.reason ?? '').trim();
        this.handOver(input.id, `The orchestrator passed this to you${reason ? `: ${reason}` : '.'}`);
        this.acted.add(s.id);
        return `Question ${input.id} is with the owner now. Session #${input.session_id} waits for them.`;
      }
      case 'send_to_session':
        return this.sendToSession(s, o, p);
      default:
        throw new Error(`Unknown method ${method}`);
    }
  }

  private itemOf(project: Project, key: unknown) {
    const k = String(key).trim().toUpperCase();
    const m = k.match(ITEM_KEY);
    if (!m) throw new Error(`Give the item key with its project, e.g. ${project.key}-12.`);
    if (m[1] !== project.key) throw new Error(`${k} is not in project ${project.key}.`);
    const it = this.store.itemByNumber(project.id, Number(m[2]));
    if (!it) throw new Error(`No item ${k}`);
    return it;
  }

  /**
   * The orchestrator proposes its plan, or a change of it. Nothing is stored unless the whole plan
   * holds. A plan the owner has not approved starts nothing: a change during the run stops new
   * starts until they approve again.
   */
  private setPlan(s: Session, o: Orchestration, raw: Record<string, unknown>): string {
    if (o.phase === 'done' || o.phase === 'stopped') throw new Error('This orchestration is closed.');
    if (o.phase === 'paused') throw new Error('The orchestration is paused: the owner resumes it first.');
    const plan = planInput.parse(raw);
    const old = new Map(o.steps.map((x) => [x.id, x]));
    const seen = new Set<number>();
    const steps = plan.steps.map((st, i) => {
      const n = i + 1;
      const project = this.scope(o, st.project_key);
      const items = st.item_keys.map((k) => this.itemOf(project, k));
      if (st.id !== undefined) {
        const before = old.get(st.id);
        if (!before) throw new Error(`No step ${st.id} in this plan.`);
        if (seen.has(st.id)) throw new Error(`Step ${st.id} is in the plan twice.`);
        seen.add(st.id);
        if (before.child_session_id && before.project_id !== project.id) throw new Error(`Step "${before.title}" already ran as session #${before.child_session_id}: it cannot move to another project.`);
      }
      for (const a of st.after) {
        if (a === n) throw new Error(`Step ${n} cannot come after itself.`);
        if (a > plan.steps.length) throw new Error(`Step ${n} comes after step ${a}, but the plan has no step ${a}.`);
      }
      return { id: st.id, title: st.title, project_id: project.id, prompt_md: st.prompt, item_ids: items.map((it) => it.id), after: [...new Set(st.after)] };
    });
    // no circle of steps that wait for each other
    const state = new Map<number, 'open' | 'done'>();
    const visit = (n: number) => {
      if (state.get(n) === 'done') return;
      if (state.get(n) === 'open') throw new Error(`Steps wait for each other in a circle (step ${n}): one of them must come first.`);
      state.set(n, 'open');
      for (const a of steps[n - 1].after) visit(a);
      state.set(n, 'done');
    };
    steps.forEach((_, i) => visit(i + 1));
    const dropped = o.steps.find((x) => x.child_session_id && !seen.has(x.id));
    if (dropped) throw new Error(`Step "${dropped.title}" already ran as session #${dropped.child_session_id}: keep it in the plan.`);
    this.store.replaceSteps(o.session_id, steps);
    this.store.updateOrchestration(o.session_id, { plan_md: plan.plan_md, plan_approved: false, phase: 'plan', plan_version: o.plan_version + 1 });
    this.acted.add(s.id);
    this.sessions.systemNote(s.id, `Plan proposed: ${steps.length} step${steps.length === 1 ? '' : 's'}`);
    this.planNotice.add(s.id);
    this.emit(o.session_id);
    return 'The plan is shown to the owner with an Approve button. Nothing starts before they approve. Explain the plan briefly, then stop and wait.';
  }

  private stepOf(o: Orchestration, id: unknown): OrchestrationStep {
    const step = o.steps.find((x) => x.id === Number(id));
    if (!step) throw new Error(`No step ${String(id)} in this plan.`);
    return step;
  }

  /**
   * Start a step as a batch, if the rules allow it now: an approved running plan, a pending step,
   * every step before it settled, a free place under the limit, a writable project, and items that
   * may start (never one on hold, closed, in review or in another open batch).
   */
  private startStep(s: Session, o: Orchestration, step: OrchestrationStep): string {
    if (o.phase === 'plan') throw new Error('The owner has not approved the plan yet.');
    if (o.phase !== 'run') throw new Error(`The orchestration is ${o.phase}.`);
    if (step.state !== 'pending') throw new Error(`Step ${step.position} is already ${step.state}.`);
    const blocker = step.depends_on.map((d) => o.steps.find((x) => x.id === d)).find((d) => d && !SETTLED.includes(d.state));
    if (blocker) throw new Error(`Step ${step.position} waits for step ${blocker.position} ("${blocker.title}"), which is ${blocker.state}.`);
    const running = o.steps.filter((x) => x.state === 'running').length;
    if (running >= o.max_children) throw new Error(`${running} step${running === 1 ? ' is' : 's are'} running, which is the limit. Wait for one to finish.`);
    const project = this.store.project(step.project_id)!;
    assertWritable(this.store, project);
    const items = this.store.itemsByIds(step.item_ids);
    const why = (st: string, held: boolean) => (st === 'hold' ? 'is on hold' : held ? 'is in another batch' : `is ${st.replace('_', ' ')}`);
    const out = items.flatMap((it) => {
      const closed = ['hold', 'done', 'canceled', 'in_review'].includes(it.status);
      const held = this.sessions.movedOn(it);
      return closed || held ? [`${it.key} ${why(it.status, held)}`] : [];
    });
    const ok = items.filter((it) => !out.some((line) => line.startsWith(`${it.key} `)));
    if (items.length && !ok.length) throw new Error(`Nothing left to start: ${out.join(', ')}.`);
    const child = this.sessions.startBatch(project, { title: step.title, item_ids: ok.map((it) => it.id), new_items: [], prompt: step.prompt_md, options: o.options }, s.started_by);
    this.store.setOrchestrator(child.id, o.session_id);
    this.acted.add(s.id);
    this.store.updateStep(step.id, { state: 'running', child_session_id: child.id, seen: null, note: null });
    this.sessions.systemNote(s.id, `Step ${step.position} started: session #${child.id}${out.length ? ` (left out: ${out.join(', ')})` : ''}`);
    this.emit(o.session_id);
    return `Started session #${child.id} for step ${step.position}.${out.length ? ` Left out: ${out.join(', ')}.` : ''} End your turn: Dispatch wakes you when it changes.`;
  }

  /** The orchestrator's own word on a step: skip one that has not started, or close one whose batch needs no merge. */
  private updateStep(o: Orchestration, step: OrchestrationStep, p: Record<string, unknown>) {
    const note = p.note === undefined ? step.note : String(p.note).trim() || null;
    if (p.state === 'skipped') {
      if (step.state !== 'pending') throw new Error(`Step ${step.position} is ${step.state}: only a pending step can be skipped.`);
    } else if (p.state === 'done') {
      if (step.state !== 'running' && step.state !== 'review') throw new Error(`Step ${step.position} is ${step.state}: only a step that ran can be done.`);
      const child = step.child_session_id ? this.store.session(step.child_session_id) : undefined;
      if (child && ['queued', 'running', 'waiting_input'].includes(child.status)) throw new Error(`Step ${step.position} is still working in session #${child.id}.`);
      if (child && this.store.prs({ session_id: child.id }).some((pr) => pr.state === 'open')) throw new Error(`Step ${step.position} has an open PR: it is done when that merges.`);
    } else {
      throw new Error('state must be "done" or "skipped".');
    }
    const updated = this.store.updateStep(step.id, { state: p.state, note });
    this.emit(o.session_id);
    return { step_id: updated.id, state: updated.state, note: updated.note };
  }

  /** One of this orchestration's batches, as its orchestrator may see it. */
  private childView(o: Orchestration, sessionId: number) {
    const child = this.store.session(sessionId);
    const step = child ? this.store.stepOfChild(child.id) : undefined;
    if (!child || child.orchestrator_id !== o.session_id) throw new Error(`Session #${sessionId} is not a step of this orchestration.`);
    return {
      id: child.id, title: child.title, status: child.status, waiting_reason: child.waiting_reason, last_text: child.last_text,
      prs: this.store.prs({ session_id: child.id }).map((pr) => ({ repo: pr.repo_full_name, number: pr.number, state: pr.state, blocked: pr.blocked, mergeable: pr.mergeable })),
      step_id: step?.id ?? null, step_state: step?.state ?? null,
    };
  }

  /** orchestrator sessions that proposed a plan or started a step this turn: that turn's end needs no "waiting for you" */
  private acted = new Set<number>();

  /** orchestrator sessions that called finish during a turn: closed when that turn ends */
  private finishWhenIdle = new Set<number>();

  /** The orchestrator is done: the result is its last word, and the session completes. */
  private finish(s: Session, o: Orchestration, result: string): string {
    if (o.phase !== 'run') throw new Error(`The orchestration is ${o.phase === 'plan' ? 'not approved yet' : o.phase}.`);
    const busy = o.steps.find((x) => x.state === 'running' || x.state === 'review');
    if (busy) throw new Error(`Step ${busy.position} is still ${busy.state === 'review' ? 'in review' : 'running'}: finish when every step is done, failed or skipped.`);
    this.store.updateOrchestration(o.session_id, { phase: 'done' });
    if (result) this.store.updateSession(s.id, { last_text: result.slice(0, 300) });
    if (this.store.session(s.id)!.status === 'idle') this.close(s.id);
    else this.finishWhenIdle.add(s.id);
    this.emit(o.session_id);
    return 'Finished. End your turn now.';
  }

  /** Complete a finished orchestration's session and tell the owner. */
  private close(sessionId: number) {
    this.finishWhenIdle.delete(sessionId);
    const s = this.store.session(sessionId)!;
    this.sessions.finish(sessionId, 'completed');
    void this.notifier.send({ title: `${s.title}: finished`, body: (s.last_text ?? 'All steps are settled.').slice(0, 180), url: `/s/${sessionId}`, tag: `orch-done-${sessionId}` }, s.started_by);
    this.emit(sessionId);
  }

  // ---------- the owner's actions ----------

  /** `planVersion`: the plan the owner read. A plan proposed after that is not the one they approve. */
  approve(sessionId: number, planVersion?: number): Orchestration {
    const o = this.must(sessionId);
    if (planVersion !== undefined && planVersion !== o.plan_version) throw new SessionError('The plan changed since you opened it. Read it again, then approve.', 409);
    if (o.phase === 'paused') throw new SessionError('Resume the orchestration first.', 409);
    if (o.phase !== 'plan') throw new SessionError(o.phase === 'run' ? 'The plan is already approved.' : 'This orchestration is closed.', 409);
    if (!o.steps.length) throw new SessionError('There is no plan to approve yet.', 409);
    this.store.updateOrchestration(sessionId, { plan_approved: true, phase: 'run' });
    this.sessions.systemNote(sessionId, 'Plan approved.');
    this.planNotice.delete(sessionId);
    this.emit(sessionId);
    this.wake(sessionId, 'The owner approved the plan.');
    return this.view(sessionId);
  }

  /** No new steps start and the orchestrator gets no events; running batches go on. */
  pause(sessionId: number): Orchestration {
    const o = this.must(sessionId);
    if (o.phase !== 'plan' && o.phase !== 'run') throw new SessionError(o.phase === 'paused' ? 'It is already paused.' : 'This orchestration is closed.', 409);
    this.store.updateOrchestration(sessionId, { phase: 'paused', paused_from: o.phase });
    this.handOverAll(sessionId, 'The orchestrator is paused: this is yours.');
    this.sessions.systemNote(sessionId, 'Paused by the owner.');
    this.emit(sessionId);
    return this.view(sessionId);
  }

  /** Back to where it was paused, with the events that waited. */
  resumeOne(sessionId: number): Orchestration {
    const o = this.must(sessionId);
    if (o.phase !== 'paused') throw new SessionError('This orchestration is not paused.', 409);
    this.store.updateOrchestration(sessionId, { phase: o.paused_from ?? 'plan', paused_from: null });
    this.sessions.systemNote(sessionId, 'Resumed by the owner.');
    this.emit(sessionId);
    this.flush(sessionId);
    return this.view(sessionId);
  }

  /** End it: nothing more starts. `stopChildren`: also stop the batches that still run. */
  stopAll(sessionId: number, stopChildren: boolean): Orchestration {
    const o = this.must(sessionId);
    if (o.phase === 'done' || o.phase === 'stopped') throw new SessionError('This orchestration is already closed.', 409);
    // closed first: what happens to its batches from here on is no longer a failed step
    this.store.updateOrchestration(sessionId, { phase: 'stopped', paused_from: null });
    this.handOverAll(sessionId, 'The orchestrator is stopped: this is yours.');
    if (stopChildren) {
      for (const step of o.steps) {
        const child = step.child_session_id ? this.store.session(step.child_session_id) : undefined;
        if (child && !FINAL_STATUSES.includes(child.status)) this.sessions.finish(child.id, 'stopped');
      }
    }
    this.sessions.systemNote(sessionId, stopChildren ? 'Stopped by the owner, with its running sessions.' : 'Stopped by the owner.');
    if (!FINAL_STATUSES.includes(this.store.session(sessionId)!.status)) this.sessions.finish(sessionId, 'stopped');
    this.emit(sessionId);
    return this.view(sessionId);
  }

  private openStep(stepId: number): { o: Orchestration; step: OrchestrationStep } {
    const step = this.store.step(stepId);
    if (!step) throw new SessionError('Unknown step', 404);
    const o = this.must(step.orchestration_id);
    if (o.phase === 'done' || o.phase === 'stopped') throw new SessionError('This orchestration is closed.', 409);
    return { o, step };
  }

  private childWorks(step: OrchestrationStep) {
    const child = step.child_session_id ? this.store.session(step.child_session_id) : undefined;
    return child && ['queued', 'running', 'waiting_input'].includes(child.status) ? child : null;
  }

  /** Go on without a step: the steps after it may start. */
  skipStep(stepId: number): Orchestration {
    const { o, step } = this.openStep(stepId);
    if (!['pending', 'failed', 'review'].includes(step.state)) throw new SessionError(step.state === 'running' ? `Step ${step.position} is running: stop its session first.` : `Step ${step.position} is already ${step.state}.`, 409);
    const busy = this.childWorks(step);
    if (busy) throw new SessionError(`Session #${busy.id} of step ${step.position} still works: stop it first.`, 409);
    this.store.updateStep(step.id, { state: 'skipped', note: 'skipped by the owner' });
    this.sessions.systemNote(o.session_id, `Step ${step.position} skipped by the owner.`);
    this.emit(o.session_id);
    const after = this.must(o.session_id);
    this.wake(o.session_id, `The owner skipped step ${step.position} ("${step.title}"). Go on without it.`, ...this.allFinished(after));
    return this.view(o.session_id);
  }

  /** Run a failed step again as a new batch: it is pending again, and the orchestrator starts it. */
  retryStep(stepId: number): Orchestration {
    const { o, step } = this.openStep(stepId);
    if (step.state !== 'failed') throw new SessionError(`Step ${step.position} is ${step.state}: only a failed step can be retried.`, 409);
    const busy = this.childWorks(step);
    if (busy) throw new SessionError(`Session #${busy.id} of step ${step.position} runs again: wait for it, or stop it first.`, 409);
    // a new batch could not start on items that are merged or in review, and the old change would belong to no step
    if (Object.values(step.deploys).includes('failed')) throw new SessionError(`The change of step ${step.position} is merged; only its deploy failed. Deploy it by hand, then skip the step to go on.`, 409);
    if (step.child_session_id && this.store.prs({ session_id: step.child_session_id }).some((pr) => pr.state !== 'closed')) {
      throw new SessionError(`Session #${step.child_session_id} of step ${step.position} has a pull request: retry that session from its page, or skip the step.`, 409);
    }
    this.store.updateStep(step.id, { state: 'pending', child_session_id: null, seen: null, deploys: {}, note: step.child_session_id ? `retry of session #${step.child_session_id}` : null });
    this.sessions.systemNote(o.session_id, `Step ${step.position}: retry asked by the owner.`);
    this.emit(o.session_id);
    this.wake(o.session_id, `The owner asks to retry step ${step.position} ("${step.title}"): start it again when it is ready.`);
    return this.view(o.session_id);
  }

  /** The event that tells the orchestrator to wrap up, when every step is done or skipped. */
  private allFinished(o: Orchestration): string[] {
    return o.phase === 'run' && o.steps.length && o.steps.every((s) => SETTLED.includes(s.state))
      ? ['All steps are finished. Write the result for the owner and call finish.'] : [];
  }

  private heldText(o: Orchestration, failed: OrchestrationStep): string {
    const held = this.heldBy(o, failed).map((s) => s.position);
    if (!held.length) return '';
    return ` Step${held.length === 1 ? '' : 's'} ${held.length > 1 ? `${held.slice(0, -1).join(', ')} and ${held.at(-1)}` : held[0]} ${held.length === 1 ? 'is' : 'are'} held.`;
  }

  // ---------- wake-ups ----------

  /** Something the orchestrator must know: kept until its session can take it. */
  wake(sessionId: number, ...texts: string[]) {
    for (const text of texts) this.store.addOrchEvent(sessionId, text);
    this.flush(sessionId);
  }

  /**
   * Give the orchestrator its waiting events as one message, with the plan as it stands. Only an
   * idle session takes them: one that works gets them when its turn ends, a paused or closed
   * orchestration keeps them. They are marked delivered before the send, so a crash in between
   * never delivers them twice.
   */
  flush(sessionId: number) {
    const o = this.store.orchestration(sessionId);
    if (!o || (o.phase !== 'plan' && o.phase !== 'run')) return;
    if (this.store.session(sessionId)?.status !== 'idle') return;
    const pending = this.store.pendingOrchEvents(sessionId);
    if (!pending.length) return;
    const ids = pending.map((e) => e.id);
    this.store.markOrchEventsDelivered(ids);
    const text = ['(From Dispatch, not the owner.)', 'Events:', ...pending.map((e) => `- ${e.text}`), '', this.statusText(o)].join('\n');
    try {
      this.sessions.sendFromDispatch(sessionId, text);
    } catch (e) {
      this.store.markOrchEventsDelivered(ids, false);
      console.warn(`orchestration ${sessionId}: events not delivered:`, (e as Error).message);
    }
  }

  /** The orchestrator session's turn ended: tell the owner what needs them, close it if it finished, else give it its events. */
  onIdle(s: Session) {
    const planned = this.planNotice.delete(s.id);
    const acted = this.acted.delete(s.id);
    if (planned) {
      void this.notifier.send({ title: `${s.title}: plan ready to approve`, body: (s.last_text ?? 'Open it to read and approve the plan.').slice(0, 180), url: `/s/${s.id}`, tag: `orch-plan-${s.id}` }, s.started_by);
    }
    if (this.finishWhenIdle.has(s.id)) return this.close(s.id);
    this.emit(s.id);
    // a question it was told about and left open in the turn that just ended is the owner's
    const waiting = this.store.pendingOrchEvents(s.id);
    for (const input of this.store.delegatedInputs(s.id)) {
      if (!waiting.some((e) => e.text.includes(`(input_id ${input.id})`))) this.handOver(input.id, 'The orchestrator did not answer this: it is yours.');
    }
    // a stopped merge it was told about and did not write to its batch about: the owner is told
    if (!waiting.length) {
      for (const stepId of [...this.fixOffered]) {
        const step = this.store.step(stepId);
        if (step && step.orchestration_id !== s.id) continue;
        this.fixOffered.delete(stepId);
        if (step?.state === 'review' && step.messages_sent === 0 && step.child_session_id) this.needsOwner(s, step, step.note ?? 'its merge stopped');
      }
    }
    // a turn that started nothing and leaves nothing running ended with words for the owner (a
    // question, or what went wrong): they are told, unless its next events start it again at once
    const o = this.store.orchestration(s.id);
    const open = !!o && (o.phase === 'plan' || o.phase === 'run');
    if (open && !planned && !acted && !this.waitsForSteps(o) && !this.store.pendingOrchEvents(s.id).length) {
      void this.notifier.send({ title: `${s.title}: waiting for you`, body: (s.last_text ?? 'Open it to reply.').slice(0, 180), url: `/s/${s.id}`, tag: `orch-turn-${s.id}` }, s.started_by);
    }
    this.flush(s.id);
  }

  /** The push for a step that only the owner can move on. */
  private needsOwner(orchestrator: Pick<Session, 'id' | 'title' | 'started_by'>, step: OrchestrationStep, note: string) {
    void this.notifier.send({
      title: `${orchestrator.title}: step ${step.position} needs you`, body: `${note.charAt(0).toUpperCase()}${note.slice(1)}.`.slice(0, 180),
      url: `/s/${step.child_session_id}`, tag: `orch-review-${step.id}`,
    }, orchestrator.started_by);
  }

  /** Its plan runs, a step is at work and none has failed: it needs nothing from the owner now. */
  private waitsForSteps(o: Orchestration): boolean {
    return o.phase === 'run' && o.steps.some((s) => s.state === 'running') && !o.steps.some((s) => s.state === 'failed');
  }

  // ---------- its batches' questions ----------

  /** How long a batch's question may wait for the orchestrator before it goes to the owner. */
  delegateTimeoutMs = 600_000;

  /**
   * A step's batch asks a question or wants its plan approved. While the plan runs and the owner
   * left this on, the orchestrator gets it first. True: it has it, and the owner is not told now.
   */
  delegate(s: Session, input: PendingInput): boolean {
    if (!s.orchestrator_id || (input.payload.kind !== 'question' && input.payload.kind !== 'plan_approval')) return false;
    const o = this.store.orchestration(s.orchestrator_id);
    const own = this.store.session(s.orchestrator_id);
    const step = this.store.stepOfChild(s.id);
    if (!o || !own || !step || o.phase !== 'run' || !o.answer_children || FINAL_STATUSES.includes(own.status)) return false;
    const name = `Step ${step.position} "${step.title}" (${step.project_key}, session #${s.id})`;
    const p = input.payload;
    const text = p.kind === 'plan_approval'
      ? [`${name} wants its plan approved (input_id ${input.id}):`, p.plan.slice(0, 3000), 'Approve it with answer_session (approve: true) if it does what the step asks, or send it back (approve: false, feedback). If only the owner can judge it, hand it to them with hand_to_owner.']
      : [
        `${name} asks you (input_id ${input.id}):`,
        ...p.questions.map((q) => `Q: ${q.question}${q.options?.length ? ` Options: ${q.options.map((op) => `${op.label}${op.description ? ` (${op.description})` : ''}`).join(' | ')}` : ''}`),
        'Answer it with answer_session if the plan, the items or what the owner told you settle it. If not, hand it to the owner with hand_to_owner.',
      ];
    this.store.setInputDelegated(input.id, o.session_id);
    this.wake(o.session_id, text.join('\n'));
    return true;
  }

  /** An open question that this orchestration has. */
  private ownInput(o: Orchestration, id: unknown) {
    const input = this.store.input(Number(id));
    const ours = input && this.store.session(input.session_id)?.orchestrator_id === o.session_id;
    // one of its batches' questions that someone answered meanwhile: say so; anything else is not its business
    if (input && ours && (input.answered_at || input.expired)) throw new Error(`Question ${input.id} is already ${input.expired ? 'closed' : 'answered'}.`);
    if (!input || input.delegated_to !== o.session_id) throw new Error(`Question ${String(id)} is not yours to answer.`);
    return input;
  }

  /** The orchestrator answers a question or a plan approval of one of its batches. */
  private answerSession(s: Session, o: Orchestration, p: Record<string, unknown>): string {
    const input = this.ownInput(o, p.input_id);
    const payload = input.payload;
    if (payload.kind === 'plan_approval') {
      if (typeof p.approve !== 'boolean') throw new Error('A plan needs approve: true or false.');
      const feedback = String(p.feedback ?? '').trim();
      this.sessions.answer(input.id, { kind: 'plan_approval', approve: p.approve, ...(feedback ? { feedback } : {}) });
    } else if (payload.kind === 'question') {
      const given = (p.answers && typeof p.answers === 'object' ? p.answers : {}) as Record<string, unknown>;
      const one = payload.questions.length === 1 && typeof p.answer === 'string' ? p.answer : undefined;
      const answers: Record<string, string> = {};
      for (const q of payload.questions) {
        const a = String(given[q.question] ?? one ?? '').trim();
        if (!a) throw new Error(`No answer for "${q.question}".`);
        answers[q.question] = a;
      }
      this.sessions.answer(input.id, { kind: 'question', answers });
    } else {
      throw new Error(`Question ${input.id} is not yours to answer.`);
    }
    this.bus.emit({ t: 'input', input: this.store.setInputAnsweredBy(input.id, 'orchestrator') });
    this.sessions.systemNote(input.session_id, `Answered by the orchestrator "${s.title}".`);
    this.acted.add(s.id);
    return `Answered. Session #${input.session_id} goes on.`;
  }

  /** How many messages the orchestrator may send to one step's batch. */
  static readonly MAX_MESSAGES = 3;

  /** The orchestrator writes to one of its batches whose turn ended: what is missing, or how to fix a stopped merge. */
  private sendToSession(s: Session, o: Orchestration, p: Record<string, unknown>): string {
    if (o.phase !== 'run') throw new Error(`The orchestration is ${o.phase === 'plan' ? 'not approved yet' : o.phase}.`);
    const child = this.store.session(Number(p.session_id));
    const step = child ? this.store.stepOfChild(child.id) : undefined;
    if (!child || !step || child.orchestrator_id !== o.session_id) throw new Error(`Session #${String(p.session_id)} is not a step of this orchestration.`);
    if (step.state !== 'running' && step.state !== 'review') throw new Error(`Step ${step.position} is ${step.state}: its batch needs no message.`);
    if (child.status === 'waiting_input') throw new Error(`Session #${child.id} waits for an answer: answer its question instead.`);
    if (child.status !== 'idle') throw new Error(FINAL_STATUSES.includes(child.status) ? `Session #${child.id} is closed.` : `Session #${child.id} works now: wait for its turn to end.`);
    const text = String(p.text ?? '').trim();
    if (!text) throw new Error('Write what the batch should do.');
    if (step.messages_sent >= Orchestrator.MAX_MESSAGES) throw new Error(`You already sent ${Orchestrator.MAX_MESSAGES} messages to this step's batch: tell the owner instead.`);
    this.sessions.sendFromDispatch(child.id, `(From the orchestrator of "${s.title}", not the owner:) ${text}`);
    this.store.updateStep(step.id, { messages_sent: step.messages_sent + 1 });
    this.acted.add(s.id);
    this.emit(o.session_id);
    return `Sent to session #${child.id} (message ${step.messages_sent + 1} of ${Orchestrator.MAX_MESSAGES} for this step). End your turn: Dispatch wakes you when it changes.`;
  }

  /**
   * The owner puts his own answer in place of the orchestrator's: the batch gets it as his message,
   * and the orchestrator is told. Nothing changes when the batch cannot take a message now.
   */
  overrule(inputId: number, ownText: string): PendingInput {
    const input = this.store.input(inputId);
    if (!input) throw new SessionError('Unknown question', 404);
    if (input.answered_by === 'overruled') throw new SessionError('You already overruled this answer.', 409);
    if (input.answered_by !== 'orchestrator') throw new SessionError('Only an answer of the orchestrator can be overruled.', 409);
    const text = ownText.trim();
    if (!text) throw new SessionError('Write your own answer.');
    const child = this.store.session(input.session_id);
    if (!child) throw new SessionError('Unknown session', 404);
    if (FINAL_STATUSES.includes(child.status)) throw new SessionError('This session is closed: write to it to reopen it.', 409);
    const about = input.payload.kind === 'question' ? `"${input.payload.questions[0]?.question ?? 'your question'}"` : 'your plan';
    this.sessions.send(child.id, `I overrule the orchestrator's answer to ${about}: ${text}`);
    const saved = this.store.setInputAnsweredBy(input.id, 'overruled');
    this.bus.emit({ t: 'input', input: saved });
    const step = this.store.stepOfChild(child.id);
    if (child.orchestrator_id && step) this.wake(child.orchestrator_id, `The owner overruled your answer to step ${step.position} (input_id ${input.id}). Follow what they said: "${text}"`);
    return saved;
  }

  /** steps whose stopped merge the orchestrator was offered to fix: if it does not try, the owner is told */
  private fixOffered = new Set<number>();

  /** How long a batch has to open its pull request after a turn, before "no pull request" is news. */
  settleMs = 30_000;
  private timers = new Set<NodeJS.Timeout>();

  /** Run `fn` later (tests replace this, or set settleMs to 0 to run it at once). */
  later = (ms: number, fn: () => void) => {
    if (ms <= 0) return fn();
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.safely(fn);
    }, ms);
    timer.unref();
    this.timers.add(timer);
  };

  /** A batch's turn ended and it still has no pull request: the orchestrator decides what that means. */
  private noPullRequest(stepId: number, seen: string) {
    const step = this.store.step(stepId);
    const child = step?.child_session_id ? this.store.session(step.child_session_id) : undefined;
    if (!step || !child || step.seen !== seen) return;
    const last = (child.last_text ?? '').replace(/\s+/g, ' ').slice(0, 300);
    this.wake(step.orchestration_id, [
      `Step ${step.position} "${step.title}" (${step.project_key}, session #${child.id}) ended its turn with no pull request.${last ? ` Its last message: "${last}"` : ''}`,
      'If its work needs no merge, close the step (update_step, state done). If it stopped early, tell it what is missing (send_to_session). If it waits for the owner, do nothing: they are told.',
    ].join('\n'));
  }

  /** A question the orchestrator had goes to the owner: said in the batch's chat, and they are told. */
  handOver(inputId: number, why: string) {
    const input = this.store.input(inputId);
    if (!input?.delegated_to || input.answered_at || input.expired) return;
    this.store.setInputDelegated(inputId, null);
    this.sessions.systemNote(input.session_id, why);
    this.sessions.inputBackToOwner(inputId);
  }

  private handOverAll(orchestrationId: number, why: string) {
    for (const input of this.store.delegatedInputs(orchestrationId)) this.handOver(input.id, why);
  }

  /** Questions that waited for their orchestrator too long (it works, or its worker is away) go to the owner. */
  checkDelegated() {
    for (const input of this.store.delegatedInputs()) {
      if (Date.now() - Date.parse(input.created_at) >= this.delegateTimeoutMs) this.handOver(input.id, 'No answer from the orchestrator in time: this is yours.');
    }
  }

  // ---------- following the batches ----------

  private onBus(e: LiveEvent) {
    if (e.t === 'session' && e.session.kind === 'orchestrator') return this.safely(() => this.ownSession(e.session));
    const child = e.t === 'session' && e.session.orchestrator_id ? e.session.id : e.t === 'pr' ? e.pr.session_id : null;
    if (child === null) return;
    const step = this.store.stepOfChild(child);
    if (step) this.safely(() => this.sync(step.id));
  }

  /**
   * The orchestrator's own session, closed by hand on its page: the orchestration is stopped. A
   * closed orchestration stays closed: a later message to its session is a chat, it starts nothing.
   */
  private ownSession(s: Session) {
    // it cannot answer any more: what its batches asked it is the owner's
    if (s.status === 'failed' || s.status === 'completed' || s.status === 'stopped') this.handOverAll(s.id, 'The orchestrator stopped: this is yours.');
    const o = this.store.orchestration(s.id);
    if (!o || o.phase === 'done' || o.phase === 'stopped') return;
    if (s.status === 'completed' || s.status === 'stopped') {
      this.store.updateOrchestration(s.id, { phase: 'stopped', paused_from: null });
      this.emit(s.id);
    }
  }

  /** A deploy after one of a step's merges started or ended. */
  onDeploy(child: Session, repo: Repo, state: DeployState) {
    const step = this.store.stepOfChild(child.id);
    if (!step) return;
    this.store.updateStep(step.id, { deploys: { ...step.deploys, [repo.id]: state } });
    this.safely(() => this.sync(step.id));
  }

  /** The pending steps that cannot start because `failed` is before them, directly or through others. */
  private heldBy(o: Orchestration, failed: OrchestrationStep): OrchestrationStep[] {
    const held = new Set<number>([failed.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const s of o.steps) {
        if (!held.has(s.id) && s.state === 'pending' && s.depends_on.some((d) => held.has(d))) {
          held.add(s.id);
          grew = true;
        }
      }
    }
    return o.steps.filter((s) => s.id !== failed.id && held.has(s.id));
  }

  /**
   * Bring a step in line with its batch: failed, in review, done (merged, and deployed where a
   * deploy runs), or still running. A change is stored, shown, and told once: to the orchestrator
   * when it must act on it, and to the owner when it needs them.
   */
  private sync(stepId: number): void {
    const step = this.store.step(stepId);
    if (!step?.child_session_id || !['running', 'review', 'failed'].includes(step.state)) return;
    const child = this.store.session(step.child_session_id);
    if (!child) return;
    const orchId = step.orchestration_id;
    const phase = this.store.orchestration(orchId)?.phase;
    if (phase === 'done' || phase === 'stopped') return;
    if (child.status === 'stopped') {
      // moved to another worker: the session that took over is the step's batch now
      const next = this.store.movedTo(child.id);
      if (next) {
        this.store.setOrchestrator(next.id, orchId);
        this.store.updateStep(step.id, { child_session_id: next.id, seen: null });
        this.emit(orchId);
        return this.sync(step.id);
      }
    }
    if (child.status === 'failed' && child.closed_reason === 'retried') {
      // retried from its own page: the session that retries it is the step's batch now
      const next = this.store.retryOf(child.id);
      if (next) {
        this.store.setOrchestrator(next.id, orchId);
        this.store.updateStep(step.id, { child_session_id: next.id, seen: null });
        this.emit(orchId);
        return this.sync(step.id);
      }
    }
    const prs = this.store.prs({ session_id: child.id });
    const open = prs.filter((p) => p.state === 'open');
    const merged = prs.some((p) => p.state === 'merged');
    const deploys = Object.values(step.deploys);
    const merging = this.merging();
    const deployComing = prs.some((p) => p.state === 'merged' && merging.has(p.id) && !!this.store.repo(p.repo_id)?.deploy_command);
    let state: StepState = 'running';
    let note: string | null = null;
    let stoppedMerge = false;
    if (child.status === 'failed') [state, note] = ['failed', failureReason(child, this.store.lastError(child.id))];
    else if (child.status === 'stopped') [state, note] = ['failed', 'stopped'];
    else if (deploys.includes('failed')) [state, note] = ['failed', 'deploy failed'];
    else if (prs.length && !open.length && merged) [state, note] = deploys.includes('running') || deployComing ? ['running', 'deploying'] : ['done', null];
    else if (child.status === 'completed') [state, note] = open.length ? ['review', 'its session is closed, but its pull request is still open'] : ['done', 'closed by the owner'];
    else if (child.status === 'idle') {
      const stuck = open.find((p) => p.blocked || p.mergeable === false);
      stoppedMerge = !!stuck;
      if (stuck) [state, note] = ['review', stuck.blocked ?? 'it has merge conflicts'];
      else if (open.length && open.every((p) => autoMergePending(child.options.auto_merge, p))) note = 'checking, then auto-merge';
      else if (open.length) [state, note] = ['review', "waits for the owner's review"];
      else if (prs.length && !merged) [state, note] = ['review', 'its pull request was closed without a merge'];
      else note = 'turn ended, no PR yet';
    }
    const seen = `${child.status}|${state}|${note ?? ''}`;
    if (seen === step.seen) return;
    this.store.updateStep(step.id, { state, note, seen });
    const o = this.store.orchestration(orchId)!;
    const title = this.store.session(orchId)?.title ?? 'Orchestration';
    const who = this.store.session(orchId)?.started_by ?? null;
    const name = `Step ${step.position} "${step.title}" (${step.project_key}, session #${child.id})`;
    const events: string[] = [];
    if (state === 'failed' && step.state !== 'failed') {
      const held = this.heldBy(o, step).map((s) => s.position);
      const heldText = this.heldText(o, step);
      events.push(`${name}: failed: ${note}${held.length ? ` Do not start the steps that wait for it (${held.join(', ')}).` : ''}`);
      void this.notifier.send({ title: `${title}: step ${step.position} failed`, body: `${note}${/[.!?]$/.test(note ?? '') ? '' : '.'}${heldText}`.slice(0, 180), url: `/s/${orchId}`, tag: `orch-failed-${step.id}` }, who);
    } else if (state === 'done' && step.state !== 'done') {
      events.push(`${name}: ${merged ? 'merged' : `done (${note})`}.`);
    } else if (state === 'review' && (step.state !== 'review' || note !== step.note)) {
      // a stopped merge: the orchestrator may write to its batch once before the owner is asked
      const tryFirst = stoppedMerge && o.answer_children && step.messages_sent === 0;
      const more = tryFirst ? ' You may tell its session once how to fix it (send_to_session). If you cannot, say so to the owner.'
        : stoppedMerge && o.answer_children ? ' Your message did not clear it: the owner is told.' : '';
      events.push(`${name}: ${note}.${more}`);
      if (tryFirst) this.fixOffered.add(step.id);
      else if (note === "waits for the owner's review") {
        void this.notifier.send({ title: `${title}: step ${step.position} waits for your review`, body: step.title, url: `/s/${child.id}`, tag: `orch-review-${step.id}` }, who);
      } else {
        this.needsOwner({ id: orchId, title, started_by: who }, step, note ?? 'it needs you');
      }
    }
    if (state === 'done') events.push(...this.allFinished(o));
    this.emit(orchId);
    if (events.length) this.wake(orchId, ...events);
    // no pull request after its turn: news only if it stays so (the batch often opens one a moment later)
    if (note === 'turn ended, no PR yet' && o.phase === 'run') this.later(this.settleMs, () => this.noPullRequest(step.id, seen));
  }
}
