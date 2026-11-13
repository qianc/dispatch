// Orchestrations: a long-running session that holds a plan of steps over one or more projects and
// starts each step as a batch. Every rule is enforced here, whatever the orchestrator's prompt says:
// its scope, the owner's approval of the plan, the order of the steps and the number at once.
import type { StartSpec } from '../shared/protocol.ts';
import { planInput, proposedItemSchema, type Orchestration, type OrchestrationStep, type Project, type Repo, type Session } from '../shared/types.ts';
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

  constructor(deps: { store: Store; bus: Bus; sessions: Sessions; notifier: Notifier }) {
    this.store = deps.store;
    this.bus = deps.bus;
    this.sessions = deps.sessions;
    this.notifier = deps.notifier;
  }

  stop() {
    // nothing to release yet
  }

  // ---------- reading ----------

  private must(sessionId: number): Orchestration {
    const o = this.store.orchestration(sessionId);
    if (!o) throw new SessionError('Unknown orchestration', 404);
    return o;
  }

  /** An orchestration with the one line that says what it waits for. */
  view(sessionId: number): Orchestration {
    const o = this.must(sessionId);
    return { ...o, waiting: this.waitingOf(o) };
  }

  list(): Orchestration[] {
    return this.store.orchestrations().map((o) => ({ ...o, waiting: this.waitingOf(o) }));
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
      return `Waiting for #${running.child_session_id} (${running.note ?? child?.status ?? 'running'}) in ${running.project_key}`;
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
      this.store.createOrchestration({ session_id: s.id, goal: input.goal, project_ids: projects.map((p) => p.id), max_children: input.max_children, options: input.options }));
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
        return this.sessions.scheduledItemUpdate(s, project, this.itemOf(project, p.key), p);
      }
      case 'set_plan':
        return this.setPlan(s, o, p);
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
    this.store.updateOrchestration(o.session_id, { plan_md: plan.plan_md, plan_approved: false, phase: 'plan' });
    this.sessions.systemNote(s.id, `Plan proposed: ${steps.length} step${steps.length === 1 ? '' : 's'}`);
    this.planNotice.add(s.id);
    this.emit(o.session_id);
    return 'The plan is shown to the owner with an Approve button. Nothing starts before they approve. Explain the plan briefly, then stop and wait.';
  }

  // ---------- the owner's actions ----------

  approve(sessionId: number): Orchestration {
    const o = this.must(sessionId);
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

  // ---------- wake-ups ----------

  /** Something the orchestrator must know: kept until its session can take it. */
  wake(sessionId: number, text: string) {
    this.store.addOrchEvent(sessionId, text);
  }
}
