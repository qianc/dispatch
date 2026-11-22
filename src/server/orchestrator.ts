// Orchestrations: a long-running session that holds a plan of steps over one or more projects and
// starts each step as a batch. Every rule is enforced here, whatever the orchestrator's prompt says:
// its scope, the owner's approval of the plan, the order of the steps and the number at once.
import type { StartSpec } from '../shared/protocol.ts';
import { autoMergePending, failureReason, finishGaps, finishedAttention } from '../shared/attention.ts';
import { FINAL_STATUSES, minorChangeInput, orchestratorDefaults, orchestratorModel, planInput, proposedItemSchema, sessionStatusWords, type OrchestratorDefaults, type Attention, type DeployState, type Item, type LiveEvent, type NotifyOwner, type Orchestration, type OrchestrationPatch, type OrchestrationStep, type PendingInput, type PlanProposal, type Project, type StepOffer, type Repo, type RunOptions, type Session, type StepState } from '../shared/types.ts';
import type { z } from 'zod';
import type { orchestrationInput } from '../shared/types.ts';
import { cleanTitle, firstWordsTitle } from '../shared/orchestrationTitle.ts';
import type { Bus } from './bus.ts';
import type { ChildNoticeKind, Notice, Notifier } from './notify.ts';
import { CHANGE_WORDS, TOUCH_WORDS, describeChange, heldByProposal, minorProblem, type NextStep } from './planChange.ts';
import { assertWritable } from './projectLock.ts';
import { SessionError, type Sessions } from './sessions.ts';
import type { Store } from './store.ts';

const ITEM_KEY = /^([A-Z][A-Z0-9]*)-(\d+)$/;

const usd = (n: number) => `$${n.toFixed(2)}`;
/** Money is compared as it is shown: to the cent. */
const cents = (n: number) => Math.round(n * 100);

/** Text a batch wrote, as lines the orchestrator can tell from Dispatch's own: each one indented behind a bar. */
const fenced = (text: string) => text.split('\n').map((line) => `    | ${line}`);

/** Steps whose dependants may start. */
const SETTLED = ['done', 'skipped'];

/** How long a deploy may run with no result before it counts as failed (DISP-166). */
const DEPLOY_TIMEOUT_MS = 30 * 60_000;
const NO_DEPLOY_RESULT = 'no deploy result in 30 min';
/** A step that failed on its deploy (its change is merged), not on its batch. */
const deployFailed = (step: OrchestrationStep) => step.state === 'failed' && (step.note === 'deploy failed' || step.note === NO_DEPLOY_RESULT);
/** What an orchestrator may make of an item when its step is done: closed, or the owner's to look at (DISP-98). */
const AFTER_STEP = ['done', 'in_review', 'hold'];

/** The merge setting of an orchestration's batches, in words for the chat (DISP-109). */
const MERGE_SETTING: Record<RunOptions['auto_merge'], string> = {
  off: "its change waits for the owner's review",
  github: 'it is merged by itself on GitHub when its checks pass',
  local: 'it is merged by itself with a local merge when its checks pass',
};

export class Orchestrator {
  private store: Store;
  private bus: Bus;
  private sessions: Sessions;
  private notifier: Notifier;

  /** ids of the PRs Dispatch merges at this moment (a deploy may follow such a merge) */
  private merging: () => ReadonlySet<number>;
  private off: () => void;

  /**
   * Asks a small model for a short title of a goal (app.ts: on the orchestrator's worker). Not set:
   * the title stays the first words of the goal (DISP-110).
   */
  private makeTitle: ((s: Session, goal: string, projects: string[]) => Promise<string>) | undefined;

  constructor(deps: { store: Store; bus: Bus; sessions: Sessions; notifier: Notifier; merging?: () => ReadonlySet<number>; makeTitle?: (s: Session, goal: string, projects: string[]) => Promise<string> }) {
    this.makeTitle = deps.makeTitle;
    this.store = deps.store;
    this.bus = deps.bus;
    this.sessions = deps.sessions;
    this.notifier = deps.notifier;
    this.merging = deps.merging ?? (() => new Set());
    this.off = this.bus.on((e) => this.onBus(e));
    this.timer = setInterval(() => this.safely(() => this.tick()), 60_000);
    this.timer.unref();
  }

  stop() {
    this.off();
    clearInterval(this.timer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private timer: NodeJS.Timeout;

  /** The time (tests replace it). */
  now: () => Date = () => new Date();

  private dueEvents(sessionId: number) {
    return this.store.pendingOrchEvents(sessionId, this.now().toISOString());
  }

  /**
   * Every minute: questions and offers that waited for an orchestrator too long, deploys with no
   * result in time, messages that still wait for a batch, and timers that came due.
   */
  tick() {
    this.checkDelegated();
    this.checkOffers();
    this.checkDeploys();
    this.checkQueued();
    for (const id of this.store.dueOrchestrations(this.now().toISOString())) this.safely(() => this.flush(id));
  }

  /**
   * After a server start: catch up with what the batches did meanwhile, and deliver the events
   * that were still waiting.
   */
  resume() {
    for (const o of this.store.orchestrations()) {
      if (o.phase === 'done' || o.phase === 'stopped') continue;
      for (const step of o.steps) {
        this.safely(() => {
          this.sync(step.id);
          // a batch whose turn ended with no pull request before the restart: its wake was a timer,
          // armed again here unless sync just did (DISP-165)
          const now = this.store.step(step.id);
          if (now && now.seen === step.seen) this.noPullRequestLater(now, true);
        });
      }
      this.safely(() => this.flush(o.session_id));
    }
    // messages for batches whose turn ended, or that closed, while the server was down
    this.safely(() => this.checkQueued());
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
    const wakes = (o.phase === 'plan' || o.phase === 'run') && !this.ownFailed(o);
    return { ...o, steps, waiting: this.waitingOf(o), cost_usd: this.store.orchestrationCost(o.session_id), next_wake: wakes ? this.timersOf(o)[0]?.due_at ?? null : null };
  }

  /** Its own session failed: its timers wait until the owner writes to it and it goes on. */
  private ownFailed(o: Pick<Orchestration, 'session_id'>): boolean {
    return this.store.session(o.session_id)?.status === 'failed';
  }

  /** What an idle orchestrator needs from its owner, or null while it only waits for its steps. */
  attention(sessionId: number): Attention | null {
    const o = this.store.orchestration(sessionId);
    if (!o) return null;
    // while it plans, its turn end is a question to the owner or a plan to approve
    if (o.phase === 'plan') {
      if (o.steps.length && !o.plan_approved) return { kind: 'plan', text: 'The plan is ready: read it and approve it.' };
      return { kind: 'plan', text: 'It waits for your reply before it can plan.' };
    }
    // it called finish: the owner reads the summary and marks it complete, or writes to it to re-plan (DISP-121)
    if (o.phase === 'done') return finishedAttention(o);
    if (o.phase !== 'run') return null;
    const failed = o.steps.find((s) => s.state === 'failed');
    if (failed) return { kind: 'step_failed', step_id: failed.id, text: `Step ${failed.position} failed.${this.heldText(o, failed)}` };
    if (o.proposal) return { kind: 'plan', text: this.proposalText(o, o.proposal) };
    // no step at work: it stopped to ask or to tell the owner something, or a step waits for their review
    return this.waitsQuietly(o) ? null : { kind: 'plan', text: this.waitingOf(o) ?? 'It waits for your reply.' };
  }

  /** For a step's batch: which orchestration and step it is part of. */
  partOf(s: Session): { orchestrator_id: number; title: string; step_position: number | null; step_count: number } | null {
    const o = s.orchestrator_id ? this.store.orchestration(s.orchestrator_id) : undefined;
    if (!o) return null;
    return { orchestrator_id: o.session_id, title: o.title, step_position: this.store.stepOfChild(s.id)?.position ?? null, step_count: o.steps.length };
  }

  private waitingOf(o: Orchestration): string | null {
    if (o.phase === 'done' || o.phase === 'stopped') return null;
    if (o.phase === 'paused') return o.paused_reason ?? 'Paused';
    if (this.ownFailed(o)) return 'Its session failed: write to it to go on';
    const timer = () => (this.timersOf(o).length ? 'Waits for its own timer' : null);
    if (o.phase === 'plan') return o.steps.length && !o.plan_approved ? 'Plan ready to approve' : timer();
    const failed = o.steps.find((s) => s.state === 'failed');
    if (failed) return `Step ${failed.position} failed`;
    if (o.proposal) return 'A change of the plan waits for your approval';
    const review = o.steps.find((s) => s.state === 'review');
    if (review) return `Step ${review.position} waits for your review`;
    const running = o.steps.find((s) => s.state === 'running');
    if (running) {
      const child = running.child_session_id ? this.store.session(running.child_session_id) : undefined;
      return `Waiting for #${running.child_session_id} (${running.note ?? (child ? sessionStatusWords(child.status) : 'working')}) in ${running.project_key}`;
    }
    return timer();
  }

  /** Its own timers that have not come due. */
  private timersOf(o: Pick<Orchestration, 'session_id'>) {
    return this.store.waitingTimers(o.session_id, this.now().toISOString());
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
          agents_edit_items: p.agents_edit_items,
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
    // a change that waits for the owner holds the steps it changes, and only those (DISP-119)
    const held = new Set(o.proposal?.held ?? []);
    return o.steps.filter((s) => s.state === 'pending' && !held.has(s.id) && s.depends_on.every((d) => SETTLED.includes(state.get(d) ?? 'skipped')));
  }

  /** The plan as the orchestrator reads it: each step with its state, and what can start. */
  statusText(o: Orchestration): string {
    if (!o.steps.length) return 'No plan yet.';
    const place = new Map(o.steps.map((s) => [s.id, s.position]));
    const lines = o.steps.map((s) => {
      const after = s.depends_on.flatMap((d) => place.get(d) ?? []);
      const facts = [`step_id ${s.id}`, s.optional ? 'optional' : '', o.proposal?.held.includes(s.id) ? 'held by your change that waits for the owner' : '', s.child_session_id ? `session #${s.child_session_id}` : '', after.length ? `after ${after.join(', ')}` : ''].filter(Boolean);
      return `${s.position}. [${s.state}${s.note ? `: ${s.note}` : ''}] ${s.project_key} — ${s.title} (${facts.join(', ')})`;
    });
    const ready = this.readySteps(o);
    const running = o.steps.filter((s) => s.state === 'running').length;
    const can = o.phase !== 'run' ? `none (${o.phase === 'plan' ? 'the owner has not approved the plan' : `the orchestration is ${o.phase}`})`
      : !ready.length ? 'none'
      : running >= o.max_children ? 'none (limit reached)'
      : ready.map((s) => s.id).join(', ');
    const waits = o.proposal ? [`A change of the plan waits for the owner's approval: ${o.proposal.summary}. The steps it holds do not start; the others go on.`] : [];
    return [`Plan now (phase ${o.phase}, at most ${o.max_children} at once):`, ...lines, ...waits, `Ready to start: ${can}`].join('\n');
  }

  private emit(sessionId: number) {
    this.bus.emit({ t: 'orchestration', orchestration: this.view(sessionId) });
  }

  // ---------- a person's default for new orchestrators ----------

  /** The model and effort `user`'s new orchestrators start with ('default': the server's default model). */
  defaults(user: string | null): OrchestratorDefaults {
    try {
      // a model saved before it stopped being a choice (Haiku) is 'default'; the effort stays
      const saved = JSON.parse(this.store.db.setting(`orchestrator_default:${user ?? ''}`) ?? '{}');
      return orchestratorDefaults.parse({ ...saved, model: orchestratorModel(saved.model) });
    } catch {
      return { model: 'default', effort: 'default' };
    }
  }

  setDefaults(user: string | null, patch: Partial<OrchestratorDefaults>): OrchestratorDefaults {
    const next = { ...this.defaults(user), ...patch };
    this.store.db.setSetting(`orchestrator_default:${user ?? ''}`, JSON.stringify(next));
    return next;
  }

  // ---------- starting ----------

  start(input: Omit<z.infer<typeof orchestrationInput>, 'notify_owner'> & { notify_owner?: NotifyOwner }, startedBy: string | null): Orchestration {
    const keys = [...new Set(input.project_keys.map((k) => k.trim().toUpperCase()))];
    const projects = keys.map((k) => {
      const p = this.store.projectByKey(k);
      if (!p) throw new SessionError(`Unknown project ${k}`);
      assertWritable(this.store, p);
      return p;
    });
    const title = input.title?.trim() || firstWordsTitle(input.goal);
    const prompt = `${input.goal}\n\nRead the trackers and the code of the projects in your instructions, ask me what is unclear, and then propose the plan with set_plan.`;
    // its own model and effort: what was picked, else the starter's default
    const mine = this.defaults(startedBy);
    const session = this.sessions.startOrchestrator({ title, prompt, first: projects[0], model: input.model ?? mine.model, effort: input.effort ?? mine.effort }, startedBy, (s) =>
      this.store.createOrchestration({ session_id: s.id, goal: input.goal, project_ids: projects.map((p) => p.id), max_children: input.max_children, options: input.options, answer_children: input.answer_children, notify_owner: input.notify_owner, cost_limit_usd: input.cost_limit_usd }));
    this.emit(session.id);
    // a model names it, once, and nothing waits for that: no title given means the owner wrote none
    if (!input.title?.trim()) void this.nameIt(session, title, input.goal, projects.map((p) => `${p.key} (${p.name})`));
    return this.view(session.id);
  }

  /**
   * Replace the first-words title by a short one a model writes from the goal (DISP-110). When the
   * model fails or is too slow, or the owner gave it a title meanwhile, the title stays as it is.
   */
  private async nameIt(session: Session, fallback: string, goal: string, projects: string[]) {
    if (!this.makeTitle) return;
    try {
      const title = cleanTitle(String((await this.makeTitle(session, goal, projects)) ?? ''));
      if (!title || this.store.session(session.id)?.title !== fallback) return;
      this.sessions.setTitle(session.id, title);
      this.emit(session.id);
    } catch (e) {
      console.warn(`orchestration ${session.id}: no generated title (${(e as Error).message}); it keeps the first words of its goal`);
    }
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
        let afterStep: string | undefined;
        if (p.status !== undefined && p.status !== it.status) {
          const to = String(p.status);
          const worked = it.status === 'in_review' || it.status === 'in_progress';
          // otherwise it could reopen a closed item and then start it as a step
          if (it.status === 'done' || it.status === 'canceled' || (worked && !AFTER_STEP.includes(to))) {
            throw new Error(`${it.key} is ${it.status.replace('_', ' ')}: an orchestrator does not change the status of an item that is closed or being worked on.${worked ? ' When its step is done, you may set it to done, or to in_review or hold for the owner.' : ''}`);
          }
          if (worked || to === 'done' || to === 'in_review') afterStep = this.afterStep(s, o, it, to);
        }
        return this.sessions.agentItemUpdate(s, project, it, p, afterStep);
      }
      case 'set_plan':
        return this.setPlan(s, o, p);
      case 'amend_plan':
        return this.amendPlan(s, o, p);
      case 'retry_step':
        return this.retryOwn(s, o, this.stepOf(o, p.step_id), String(p.reason ?? '').trim());
      case 'start_step':
        return this.startStep(s, o, this.stepOf(o, p.step_id));
      case 'update_step':
        return this.updateStep(s, o, this.stepOf(o, p.step_id), p);
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
      case 'wake_me_in':
        return this.wakeMeIn(s, o, p);
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
   * The orchestrator closes an item of its own plan, or gives it to the owner (in review, hold),
   * when the step that worked on it is done and no session holds the item any more. The line that
   * goes on the item as a comment: which step and pull request completed it.
   */
  private afterStep(s: Session, o: Orchestration, it: Item, to: string): string {
    const steps = o.steps.filter((x) => x.item_ids.includes(it.id));
    const word = to.replace('_', ' ');
    if (!steps.length) throw new Error(`${it.key} is not an item of a step in your plan: you set only the items of your own steps to ${word}.`);
    const open = steps.find((x) => !SETTLED.includes(x.state));
    if (open) throw new Error(`Step ${open.position} ("${open.title}") with ${it.key} is ${open.state}: set the item to ${word} when that step is done.`);
    const step = steps.findLast((x) => x.state === 'done');
    if (!step) throw new Error(`No step with ${it.key} has run: you set an item to ${word} only after its step is done.`);
    const own = new Set(steps.map((x) => x.child_session_id));
    for (const w of this.store.sessionsForItem(it.id, 'work')) {
      if (FINAL_STATUSES.includes(w.status) && !own.has(w.id)) continue;
      if (['queued', 'running', 'waiting_input'].includes(w.status)) throw new Error(`Session #${w.id} still works on ${it.key}.`);
      if (!own.has(w.id)) throw new Error(`${it.key} is in another batch (session #${w.id}).`);
      if (this.store.prs({ session_id: w.id }).some((pr) => pr.state === 'open')) throw new Error(`Session #${w.id} has an open pull request with ${it.key}: the item is done when that merges.`);
    }
    const merged = step.child_session_id ? this.store.prs({ session_id: step.child_session_id }).filter((pr) => pr.state === 'merged') : [];
    const facts = [step.child_session_id ? `session #${step.child_session_id}` : '', ...merged.map((pr) => (pr.local ? `branch ${pr.head_ref} merged` : `${pr.repo_full_name}#${pr.number} merged`))].filter(Boolean);
    return `Set to ${word} by the orchestrator "${s.title}" after step ${step.position} "${step.title}"${facts.length ? ` (${facts.join(', ')})` : ''}.`;
  }

  /** A plan as set_plan or amend_plan give it, checked against the scope, the items and the steps that ran. */
  private buildPlan(o: Orchestration, raw: Record<string, unknown>): { plan_md: string; input: ReturnType<typeof planInput.parse>; steps: NextStep[] } {
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
      return { id: st.id, title: st.title, project_id: project.id, prompt_md: st.prompt, item_ids: items.map((it) => it.id), after: [...new Set(st.after)], optional: st.optional };
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
    return { plan_md: plan.plan_md, input: plan, steps };
  }

  /**
   * The orchestrator proposes its plan, or a change of it that needs the owner. Nothing is stored
   * unless the whole plan holds. Before the first approval nothing starts. A change of the running
   * plan waits as a proposal: the steps it changes are held until the owner answers, and the rest of
   * the plan goes on (DISP-119).
   */
  private setPlan(s: Session, o: Orchestration, raw: Record<string, unknown>): string {
    if (o.phase === 'done' || o.phase === 'stopped') throw new Error('This orchestration is closed.');
    if (o.phase === 'paused') throw new Error('The orchestration is paused: the owner resumes it first.');
    const plan = this.buildPlan(o, raw);
    this.acted.add(s.id);
    if (o.phase === 'run') {
      const proposal: PlanProposal = {
        plan_md: plan.plan_md || o.plan_md, steps: plan.input.steps, summary: describeChange(o.steps, plan.steps),
        held: heldByProposal(o.steps, plan.steps), created_at: this.now().toISOString(),
      };
      this.store.updateOrchestration(o.session_id, { proposal, plan_version: o.plan_version + 1 });
      this.sessions.systemNote(s.id, `Plan change proposed: ${proposal.summary}`);
      this.emit(o.session_id);
      const after = this.must(o.session_id);
      return `The change is shown to the owner with an Approve button. ${this.proposalText(after, proposal)} Start what is ready now (${this.readySteps(after).map((x) => x.id).join(', ') || 'nothing is'}), explain the change briefly, then end your turn.`;
    }
    this.store.replaceSteps(o.session_id, plan.steps);
    this.store.updateOrchestration(o.session_id, { plan_md: plan.plan_md, plan_approved: false, phase: 'plan', plan_version: o.plan_version + 1 });
    // it takes its batches' questions only while an approved plan runs
    this.handOverAll(o.session_id, 'The orchestrator changed its plan and waits for your approval: this is yours.');
    this.sessions.systemNote(s.id, `Plan proposed: ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}`);
    this.emit(o.session_id);
    return 'The plan is shown to the owner with an Approve button. Nothing starts before they approve. Explain the plan briefly, then stop and wait.';
  }

  /** What a change that waits for the owner holds, and what goes on meanwhile: so they can answer at once. */
  private proposalText(o: Orchestration, p: PlanProposal): string {
    const at = (ids: number[]) => o.steps.filter((x) => ids.includes(x.id)).map((x) => x.position);
    const list = (n: number[]) => (n.length > 1 ? `steps ${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : `step ${n[0]}`);
    const held = at(p.held);
    const goes = o.steps.filter((x) => !p.held.includes(x.id) && ['pending', 'running', 'review'].includes(x.state)).map((x) => x.position);
    return [
      `A change of the plan waits for your approval: ${p.summary}.`,
      held.length ? `Held until you answer: ${list(held)}.` : 'It holds no step.',
      goes.length ? `Going on now: ${list(goes)}.` : '',
    ].filter(Boolean).join(' ');
  }

  /**
   * A minor change of the approved plan, made without asking (DISP-119): applied at once, logged in
   * the plan's history, and the independent steps go on. A change that is not minor is refused with
   * the rule it breaks: the orchestrator proposes it with set_plan instead.
   */
  private amendPlan(s: Session, o: Orchestration, raw: Record<string, unknown>): string {
    if (o.phase === 'plan') throw new Error('The owner has not approved the plan yet: change it with set_plan.');
    if (o.phase !== 'run') throw new Error(`The orchestration is ${o.phase}.`);
    if (o.proposal) throw new Error("A change of the plan waits for the owner's approval: wait for their answer, or put this change into a new set_plan.");
    const change = minorChangeInput.parse(raw.change ?? {});
    const plan = this.buildPlan(o, raw);
    const problem = minorProblem(o.steps, plan.steps, change);
    if (problem) throw new Error(`This change needs the owner's approval: ${problem}. Propose it with set_plan; the steps it does not change go on meanwhile.`);
    const steps = plan.steps.map((st) => (st.id === undefined && change.kind === 'fix_blocker' ? { ...st, prompt_md: this.fixGuard(change, st.prompt_md) } : st));
    const summary = describeChange(o.steps, plan.steps, change);
    const ids = this.store.replaceSteps(o.session_id, steps);
    this.store.updateOrchestration(o.session_id, { plan_md: plan.plan_md || o.plan_md, plan_version: o.plan_version + 1 });
    const fixStep = change.kind === 'fix_blocker' ? ids[plan.steps.findIndex((st) => st.id === undefined)] : null;
    this.store.addPlanChange(o.session_id, { kind: change.kind, decided_by: 'orchestrator', summary, reason: change.reason, verification: change.verification || null, step_id: fixStep });
    this.sessions.systemNote(s.id, `Plan changed without approval (${CHANGE_WORDS[change.kind]}): ${summary}. Why: ${change.reason}${change.verification ? ` Verified by: ${change.verification}` : ''}`);
    this.acted.add(s.id);
    this.emit(o.session_id);
    const after = this.must(o.session_id);
    return `Changed: ${summary}. It is in the plan's history for the owner. Ready to start: ${this.readySteps(after).map((x) => x.id).join(', ') || 'none'}.`;
  }

  /** The prompt of a step that fixes a blocker: it may touch only what the change named, and its check must pass. */
  private fixGuard(change: ReturnType<typeof minorChangeInput.parse>, prompt: string): string {
    const touches = (change.touches ?? []).map((t) => TOUCH_WORDS[t]).join(', ');
    return [
      `(Dispatch: the orchestrator added this step without the owner's approval, as a minor fix of a blocker: ${change.reason}`,
      `Change only ${touches}. Before you open the pull request, run this check and say its result in the pull request: ${change.verification}`,
      'If the fix needs anything else (code, a new dependency with a runtime role, credentials, another repo), or the check does not pass, do not widen the change: stop and say so.)',
      '',
      prompt,
    ].join('\n').trim();
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
    if (o.proposal?.held.includes(step.id)) throw new Error(`Step ${step.position} is held by your change of the plan, which waits for the owner's approval.`);
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
    this.timerStreak.delete(o.session_id);
    this.store.updateStep(step.id, { state: 'running', child_session_id: child.id, seen: null, note: null });
    this.sessions.systemNote(s.id, `Step ${step.position} started: session #${child.id}${out.length ? ` (left out: ${out.join(', ')})` : ''}`);
    this.emit(o.session_id);
    return `Started session #${child.id} for step ${step.position}.${out.length ? ` Left out: ${out.join(', ')}.` : ''} End your turn: Dispatch wakes you when it changes.`;
  }

  /**
   * The orchestrator's own word on a step: skip one that has not started and that the plan marks
   * optional (any other skip is the owner's, DISP-119), or close one whose batch needs no merge.
   */
  private updateStep(s: Session, o: Orchestration, step: OrchestrationStep, p: Record<string, unknown>) {
    const note = p.note === undefined ? step.note : String(p.note).trim() || null;
    if (p.state === 'skipped') {
      if (step.state !== 'pending') throw new Error(`Step ${step.position} is ${step.state}: only a pending step can be skipped.`);
      if (!step.optional) throw new Error(`Step ${step.position} is not optional in the plan: skipping it needs the owner's approval. Propose the plan without it (set_plan), or ask them to skip it.`);
      this.store.addPlanChange(o.session_id, { kind: 'skip', decided_by: 'orchestrator', summary: `skipped optional step ${step.position} "${step.title}"`, reason: note ?? '', verification: null, step_id: step.id });
      this.sessions.systemNote(s.id, `Optional step ${step.position} skipped without approval${note ? `: ${note}` : '.'}`);
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

  /**
   * The orchestrator is done: the result is its last word. The session stays open for the owner,
   * who reads the summary and marks it complete, or writes to it to re-plan (DISP-121).
   */
  private finish(s: Session, o: Orchestration, result: string): string {
    if (o.phase !== 'run') throw new Error(`The orchestration is ${o.phase === 'plan' ? 'not approved yet' : o.phase}.`);
    const busy = o.steps.find((x) => x.state === 'running' || x.state === 'review');
    if (busy) throw new Error(`Step ${busy.position} is still ${busy.state === 'review' ? 'in review' : 'running'}: finish when every step is done, failed or skipped.`);
    this.store.updateOrchestration(o.session_id, { phase: 'done' });
    this.store.dropTimers(o.session_id);
    if (result) this.store.updateSession(s.id, { last_text: result.slice(0, 300) });
    // in the chat, whatever the summary says: whether the goal is met, from the steps themselves
    const gaps = finishGaps(o);
    this.sessions.systemNote(s.id, gaps ? `Finished, but the goal is not fully met: ${gaps}.` : 'Finished: every step is done.');
    // else the turn's end tells the owner: finish_notified is still false (DISP-165)
    if (this.store.session(s.id)!.status === 'idle') this.finished(s.id);
    this.emit(o.session_id);
    return 'Finished. End your turn now: the owner reads your summary and marks the orchestration complete, or writes to you to re-plan.';
  }

  /** A finished orchestration waits for its owner: one push with the result. */
  private finished(sessionId: number) {
    this.store.updateOrchestration(sessionId, { finish_notified: true });
    const s = this.store.session(sessionId)!;
    this.flushOwner(sessionId);
    // the batches it completed without a push are counted here, the one push at the end (DISP-122)
    const quiet = this.store.quietLog(sessionId, 1000).filter((e) => e.text.includes('session completed')).length;
    const counted = quiet ? `${quiet} batch${quiet === 1 ? '' : 'es'} completed without a push (see the quiet log). ` : '';
    const unmet = finishGaps(this.store.orchestration(sessionId)!) ? 'Goal not fully met. ' : '';
    void this.notifier.send({ title: `${s.title}: finished`, body: `${unmet}${counted}${s.last_text ?? 'All steps are settled.'}`.slice(0, 180), url: `/s/${sessionId}`, tag: `orch-done-${sessionId}` }, s.started_by);
    this.emit(sessionId);
  }

  /** The owner wrote to a finished orchestration: it runs again, to re-plan or answer them (DISP-121). */
  ownerWrote(sessionId: number) {
    const o = this.store.orchestration(sessionId);
    if (o?.phase !== 'done') return;
    this.store.updateOrchestration(sessionId, { phase: 'run', finish_notified: false });
    this.sessions.systemNote(sessionId, 'Opened again by the owner\'s message.');
    this.emit(sessionId);
  }

  // ---------- the owner's actions ----------

  /** `planVersion`: the plan the owner read. A plan proposed after that is not the one they approve. */
  approve(sessionId: number, planVersion?: number): Orchestration {
    const o = this.must(sessionId);
    if (planVersion !== undefined && planVersion !== o.plan_version) throw new SessionError('The plan changed since you opened it. Read it again, then approve.', 409);
    if (o.phase === 'paused') throw new SessionError('Resume the orchestration first.', 409);
    if (o.phase === 'run' && o.proposal) return this.approveChange(o);
    if (o.phase !== 'plan') throw new SessionError(o.phase === 'run' ? 'The plan is already approved.' : 'This orchestration is closed.', 409);
    if (!o.steps.length) throw new SessionError('There is no plan to approve yet.', 409);
    this.store.updateOrchestration(sessionId, { plan_approved: true, phase: 'run' });
    this.sessions.systemNote(sessionId, 'Plan approved.');
    this.emit(sessionId);
    this.wake(sessionId, 'The owner approved the plan.');
    return this.view(sessionId);
  }

  /** The owner approves a change of the running plan: it replaces the plan, and the steps it held may start. */
  private approveChange(o: Orchestration): Orchestration {
    const p = o.proposal!;
    let plan: ReturnType<Orchestrator['buildPlan']>;
    try {
      // the plan moved on since (a step ran, the scope changed): checked again as it is now
      plan = this.buildPlan(o, { plan_md: p.plan_md, steps: p.steps });
    } catch (e) {
      throw new SessionError(`The change no longer fits the plan: ${(e as Error).message} Decline it, and the orchestrator proposes it again.`, 409);
    }
    this.store.replaceSteps(o.session_id, plan.steps);
    this.store.updateOrchestration(o.session_id, { plan_md: plan.plan_md, proposal: null });
    this.store.addPlanChange(o.session_id, { kind: 'approved', decided_by: 'owner', summary: p.summary, reason: '', verification: null, step_id: null });
    this.sessions.systemNote(o.session_id, 'Plan change approved.');
    this.emit(o.session_id);
    this.wake(o.session_id, 'The owner approved your change of the plan.');
    return this.view(o.session_id);
  }

  /** The owner says no to a change of the running plan: the approved plan stays, and its held steps may start. */
  decline(sessionId: number): Orchestration {
    const o = this.must(sessionId);
    if (!o.proposal) throw new SessionError('No change of the plan waits for you.', 409);
    this.store.updateOrchestration(sessionId, { proposal: null });
    this.store.addPlanChange(sessionId, { kind: 'declined', decided_by: 'owner', summary: o.proposal.summary, reason: '', verification: null, step_id: null });
    this.sessions.systemNote(sessionId, 'Plan change declined by the owner.');
    this.emit(sessionId);
    this.wake(sessionId, 'The owner declined your change of the plan: the approved plan stays. Go on with it, or ask them what they want instead.');
    return this.view(sessionId);
  }

  /** No new steps start and the orchestrator gets no events; running batches go on. */
  pause(sessionId: number, reason: string | null = null): Orchestration {
    const o = this.must(sessionId);
    if (o.phase !== 'plan' && o.phase !== 'run') throw new SessionError(o.phase === 'paused' ? 'It is already paused.' : 'This orchestration is closed.', 409);
    this.store.updateOrchestration(sessionId, { phase: 'paused', paused_from: o.phase, paused_reason: reason });
    this.handOverAll(sessionId, 'The orchestrator is paused: this is yours.');
    this.sessions.systemNote(sessionId, reason ? `Paused by Dispatch. ${reason}` : 'Paused by the owner.');
    this.emit(sessionId);
    return this.view(sessionId);
  }

  /** Back to where it was paused, with the events that waited. */
  resumeOne(sessionId: number): Orchestration {
    const o = this.must(sessionId);
    if (o.phase !== 'paused') throw new SessionError('This orchestration is not paused.', 409);
    const cost = this.store.orchestrationCost(sessionId);
    if (o.cost_limit_usd !== null && cents(cost) >= cents(o.cost_limit_usd)) throw new SessionError(`It has used ${usd(cost)} of its ${usd(o.cost_limit_usd)} limit: raise the limit first.`, 409);
    this.store.updateOrchestration(sessionId, { phase: o.paused_from ?? 'plan', paused_from: null, paused_reason: null });
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
    this.store.dropTimers(sessionId);
    if (stopChildren) {
      for (const step of o.steps) {
        const child = step.child_session_id ? this.store.session(step.child_session_id) : undefined;
        if (child && !FINAL_STATUSES.includes(child.status)) this.sessions.finish(child.id, 'stopped');
      }
    }
    // what batches that go on had asked it (a stopped batch's question is closed with it)
    this.handOverAll(sessionId, 'The orchestrator is stopped: this is yours.');
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
    this.makePending(step);
    this.sessions.systemNote(o.session_id, `Step ${step.position}: retry asked by the owner.`);
    this.emit(o.session_id);
    this.wake(o.session_id, `The owner asks to retry step ${step.position} ("${step.title}"): start it again when it is ready.`);
    return this.view(o.session_id);
  }

  /** How often the orchestrator may retry one step by itself; then it is the owner's. */
  static readonly MAX_OWN_RETRIES = 1;

  /** The orchestrator retries a failed step by itself, once (DISP-119): logged in the plan's history. */
  private retryOwn(s: Session, o: Orchestration, step: OrchestrationStep, reason: string): string {
    if (o.phase !== 'run') throw new Error(`The orchestration is ${o.phase === 'plan' ? 'not approved yet' : o.phase}.`);
    if (!reason) throw new Error('Say why a new run should pass.');
    const done = o.changes.filter((c) => c.kind === 'retry' && c.step_id === step.id).length;
    if (done >= Orchestrator.MAX_OWN_RETRIES) throw new Error(`You retried step ${step.position} already: tell the owner what failed instead.`);
    this.makePending(step);
    this.store.addPlanChange(o.session_id, { kind: 'retry', decided_by: 'orchestrator', summary: `retried step ${step.position} "${step.title}"${step.child_session_id ? ` (session #${step.child_session_id} failed)` : ''}`, reason, verification: null, step_id: step.id });
    this.sessions.systemNote(s.id, `Step ${step.position} retried without approval: ${reason}`);
    this.acted.add(s.id);
    this.emit(o.session_id);
    return `Step ${step.position} is pending again: start it with start_step when it is ready.`;
  }

  /** A failed step goes back to pending, for a new batch, when nothing of its old one is left to finish. */
  private makePending(step: OrchestrationStep) {
    if (step.state !== 'failed') throw new SessionError(`Step ${step.position} is ${step.state}: only a failed step can be retried.`, 409);
    const busy = this.childWorks(step);
    if (busy) throw new SessionError(`Session #${busy.id} of step ${step.position} runs again: wait for it, or stop it first.`, 409);
    // a new batch could not start on items that are merged or in review, and the old change would belong to no step
    if (Object.values(step.deploys).includes('failed')) throw new SessionError(`The change of step ${step.position} is merged; only its deploy failed. Deploy it by hand, then skip the step to go on.`, 409);
    if (step.child_session_id && this.store.prs({ session_id: step.child_session_id }).some((pr) => pr.state !== 'closed')) {
      throw new SessionError(`Session #${step.child_session_id} of step ${step.position} has a pull request: retry that session from its page, or skip the step.`, 409);
    }
    this.store.updateStep(step.id, { state: 'pending', child_session_id: null, seen: null, deploys: {}, deploys_started: {}, messages_sent: 0, note: step.child_session_id ? `retry of session #${step.child_session_id}` : null });
  }

  /** The event that tells the orchestrator to wrap up, when every step is done or skipped. */
  private allFinished(o: Orchestration): string[] {
    return o.phase === 'run' && o.steps.length && o.steps.every((s) => SETTLED.includes(s.state))
      ? ['All steps are finished. Write your summary for the owner and call finish.'] : [];
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
    const status = this.store.session(sessionId)?.status;
    // its session failed: a timer that comes due waits for the owner to write to it, and says it came late
    if (status === 'failed') {
      for (const e of this.dueEvents(sessionId)) {
        if (e.due_at && e.text.startsWith('Your timer: ') && !e.text.includes('(came due at ')) {
          this.store.setOrchEventText(e.id, `${e.text} (came due at ${e.due_at.slice(11, 16)} UTC while the session was failed)`);
        }
      }
      return;
    }
    if (status !== 'idle') return;
    const pending = this.dueEvents(sessionId);
    if (!pending.length) return;
    const ids = pending.map((e) => e.id);
    this.store.markOrchEventsDelivered(ids);
    if (pending.some((e) => !e.text.startsWith('Your timer: '))) this.timerStreak.delete(sessionId);
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
    const acted = this.acted.delete(s.id);
    const planned = this.notifyPlan(s);
    const mine = this.store.orchestration(s.id);
    // finish was called in this turn (or before a restart): the owner is told once (DISP-165)
    if (mine?.phase === 'done' && !mine.finish_notified) return this.finished(s.id);
    this.emit(s.id);
    // a question it was told about and left open in the turn that just ended is the owner's
    const waiting = this.dueEvents(s.id);
    for (const input of this.store.delegatedInputs(s.id)) {
      if (!waiting.some((e) => e.text.includes(`(input_id ${input.id})`))) this.handOver(input.id, 'The orchestrator did not answer this: it is yours.');
    }
    // a stopped merge it was told about and did not write to its batch about: the owner is told
    if (!waiting.length) {
      for (const step of this.offered(s.id, 'fix_merge')) this.offerToOwner(s, step);
    }
    // a batch that ended its turn with no pull request, and the orchestrator did nothing for it: it waits for the owner (DISP-122)
    for (const step of this.offered(s.id, 'no_pr')) {
      if (waiting.some((e) => e.text.includes(`session #${step.child_session_id}) ended its turn with no pull request`))) continue;
      this.offerToOwner(s, step);
    }
    // a failed deploy it was told about and did nothing for: the owner is told (this push, not the one below)
    let told = false;
    for (const step of this.offered(s.id, 'deploy')) {
      if (waiting.some((e) => e.text.includes(`session #${step.child_session_id}): failed: ${step.note}`))) continue;
      if (acted) this.clearOffer(step.id);
      else told = this.offerToOwner(s, step, 'its deploy failed, and the orchestrator did not fix it') || told;
    }
    // a turn that started nothing and leaves nothing running ended with words for the owner (a
    // question, or what went wrong): they are told, unless its next events start it again at once
    const o = this.store.orchestration(s.id);
    const open = !!o && (o.phase === 'plan' || o.phase === 'run');
    if (open && !planned && !acted && !told && !this.waitsQuietly(o) && !this.dueEvents(s.id).length) {
      void this.notifier.send({ title: `${s.title}: waiting for you`, body: (s.last_text ?? 'Open it to reply.').slice(0, 180), url: `/s/${s.id}`, tag: `orch-turn-${s.id}` }, s.started_by);
    }
    this.flush(s.id);
  }

  /**
   * A plan, or a change of the running plan, that waits for the owner and that they were not told
   * about yet: one push, kept in the store so a restart in the middle of the turn sends it still
   * (DISP-165). True: it went out.
   */
  private notifyPlan(s: Session): boolean {
    const o = this.store.orchestration(s.id);
    if (!o || o.plan_version <= o.plan_notified_version) return false;
    const plan = o.phase === 'plan' && o.steps.length > 0 && !o.plan_approved;
    const change = o.phase === 'run' && !!o.proposal;
    if (!plan && !change) return false;
    this.store.updateOrchestration(s.id, { plan_notified_version: o.plan_version });
    const title = change ? `${s.title}: plan change to approve` : `${s.title}: plan ready to approve`;
    void this.notifier.send({ title, body: (s.last_text ?? 'Open it to read and approve the plan.').slice(0, 180), url: `/s/${s.id}`, tag: `orch-plan-${s.id}` }, s.started_by);
    return true;
  }

  /** The push for a step that only the owner can move on. */
  private needsOwner(orchestrator: Pick<Session, 'id' | 'title' | 'started_by'>, step: OrchestrationStep, note: string) {
    this.tellOwner(orchestrator.id, {
      title: `${orchestrator.title}: step ${step.position} needs you`, body: `${note.charAt(0).toUpperCase()}${note.slice(1)}.`.slice(0, 180),
      url: `/s/${step.child_session_id}`, tag: `orch-review-${step.id}`,
    });
  }

  // ---------- what the owner is told about the batches (DISP-122) ----------

  /** How long news for the owner waits for more, to go out as one push. 0: at once (tests). */
  batchMs = 2_000;
  /** per orchestration: the news for the owner that waits to go out */
  private outbox = new Map<number, { notices: Notice[]; timer: NodeJS.Timeout | null }>();

  /**
   * News about its batches that needs the owner: with what comes at the same time, it goes out as
   * one push. With the setting "all" it goes out at once, as before.
   */
  private tellOwner(orchId: number, n: Notice) {
    const o = this.store.orchestration(orchId);
    if (!o || o.notify_owner === 'all' || this.batchMs <= 0) {
      void this.notifier.send(n, o?.started_by ?? null);
      return;
    }
    const box = this.outbox.get(orchId) ?? { notices: [], timer: null };
    // the same news again (same tag): the newer one counts
    box.notices = [...box.notices.filter((x) => !n.tag || x.tag !== n.tag), n];
    if (!box.timer) {
      box.timer = setTimeout(() => {
        this.timers.delete(box.timer!);
        this.safely(() => this.flushOwner(orchId));
      }, this.batchMs);
      box.timer.unref();
      this.timers.add(box.timer);
    }
    this.outbox.set(orchId, box);
  }

  /** Send the owner the news that waits: one thing as its own push, several in one push that lists them. */
  flushOwner(orchId: number) {
    const box = this.outbox.get(orchId);
    if (!box) return;
    this.outbox.delete(orchId);
    if (box.timer) {
      clearTimeout(box.timer);
      this.timers.delete(box.timer);
    }
    const o = this.store.orchestration(orchId);
    const who = o?.started_by ?? null;
    if (box.notices.length === 1) {
      void this.notifier.send(box.notices[0], who);
      return;
    }
    if (!box.notices.length) return;
    const title = o?.title ?? 'Orchestration';
    // "<title>: step 2 failed" reads as "step 2 failed" in the list
    const line = (n: Notice) => `- ${n.title.startsWith(`${title}: `) ? n.title.slice(title.length + 2) : n.title}: ${n.body.replace(/\s+/g, ' ')}`.slice(0, 120);
    void this.notifier.send({ title: `${title}: ${box.notices.length} things need you`, body: box.notices.map(line).join('\n').slice(0, 600), url: `/s/${orchId}`, tag: `orch-news-${orchId}` }, who);
  }

  /**
   * A batch's own notice. True: its orchestration took it, and the batch sends nothing itself.
   * `routine`: news the step's state already tells (the orchestrator follows it, and the owner is
   * told when it needs them): only logged. `turn_end`: the batch ended its turn; routine while the
   * orchestrator deals with its batches, else the owner's. `needs_owner`: goes to the owner, with the
   * orchestration's other news. Not taken: the setting is "all", or the orchestration is closed.
   */
  childNotice(s: Session, n: Notice, kind: ChildNoticeKind): boolean {
    if (!s.orchestrator_id) return false;
    const o = this.store.orchestration(s.orchestrator_id);
    if (!o || o.notify_owner === 'all' || o.phase === 'done' || o.phase === 'stopped') return false;
    if (kind === 'needs_owner' || (kind === 'turn_end' && !o.answer_children)) {
      this.tellOwner(o.session_id, n);
      return true;
    }
    const step = this.store.stepOfChild(s.id);
    const what = `${n.title}${n.body ? ` (${n.body.replace(/\s+/g, ' ').slice(0, 120)})` : ''}`;
    this.store.addQuietLog(o.session_id, { session_id: s.id, step_id: step?.id ?? null, text: `Session #${s.id}: not pushed: ${what}` });
    this.emit(o.session_id);
    return true;
  }

  /**
   * A step is done because its batch merged: the batch's session is completed, with no push
   * (DISP-122). Not while it still works, asks something or has messages waiting.
   */
  private completeQuietly(o: Orchestration, step: OrchestrationStep, child: Session): boolean {
    if (o.notify_owner === 'all' || child.status !== 'idle') return false;
    if (this.store.openInputs().some((i) => i.session_id === child.id) || this.store.queuedOrchMessages(child.id).length) return false;
    this.store.addQuietLog(o.session_id, { session_id: child.id, step_id: step.id, text: `Step ${step.position} "${step.title}" (session #${child.id}): merged; session completed.` });
    this.sessions.finish(child.id, 'completed');
    return true;
  }

  /** Its plan runs, a step is at work and none has failed: it needs nothing from the owner now. */
  private waitsForSteps(o: Orchestration): boolean {
    return o.phase === 'run' && o.steps.some((s) => s.state === 'running') && !o.steps.some((s) => s.state === 'failed');
  }

  /** It waits for its steps, or for a timer it set itself, and no step has failed: nothing for the owner now. */
  private waitsQuietly(o: Orchestration): boolean {
    if (o.proposal) return false;
    return this.waitsForSteps(o) || (o.phase === 'run' && !o.steps.some((s) => s.state === 'failed' || s.state === 'review') && this.timersOf(o).length > 0);
  }

  // ---------- its own timers ----------

  static readonly MAX_TIMERS = 3;
  /** Timers it may set one after the other while nothing else happens (no step starts, no news): then it must say what it waits for. */
  static readonly MAX_TIMER_STREAK = 12;
  private timerStreak = new Map<number, number>();

  /** The orchestrator asks to be woken later: a queued event with a due time. */
  private wakeMeIn(s: Session, o: Orchestration, p: Record<string, unknown>): string {
    if (o.phase !== 'plan' && o.phase !== 'run') throw new Error(`The orchestration is ${o.phase}.`);
    const minutes = Number(p.minutes);
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 10_080) throw new Error('A timer is between 5 minutes and 7 days (10080 minutes).');
    const reason = String(p.reason ?? '').trim();
    if (!reason) throw new Error('Say what the timer is for.');
    if (this.timersOf(o).length >= Orchestrator.MAX_TIMERS) throw new Error(`${Orchestrator.MAX_TIMERS} timers wait already: that is the most.`);
    const streak = this.timerStreak.get(o.session_id) ?? 0;
    if (streak >= Orchestrator.MAX_TIMER_STREAK) throw new Error(`You set ${Orchestrator.MAX_TIMER_STREAK} timers in a row and nothing else happened: tell the owner what you wait for instead.`);
    this.timerStreak.set(o.session_id, streak + 1);
    const at = new Date(this.now().getTime() + Math.round(minutes) * 60_000).toISOString();
    this.store.addOrchEvent(o.session_id, `Your timer: ${reason.replace(/\s+/g, ' ').slice(0, 300)}`, at);
    // while it plans it waits for the owner, timer or not; in a run the timer is what it waits for
    if (o.phase === 'run') this.acted.add(s.id);
    this.emit(o.session_id);
    return `Dispatch wakes you in ${Math.round(minutes)} minutes (at ${at}). End your turn.`;
  }

  // ---------- cost ----------

  /** At its cost limit an orchestration is paused: nothing new starts, what runs goes on, and the owner is told once. */
  private checkCost(sessionId: number) {
    const o = this.store.orchestration(sessionId);
    if (!o || o.cost_limit_usd === null) return;
    // paused by the owner, its batches still spend: the cost reason is set once, and is the flag that the owner was told
    const paused = o.phase === 'paused';
    if (paused ? o.paused_reason !== null : o.phase !== 'plan' && o.phase !== 'run') return;
    const cost = this.store.orchestrationCost(sessionId);
    if (cents(cost) < cents(o.cost_limit_usd)) return;
    const used = `${usd(cost)} of ${usd(o.cost_limit_usd)} used.`;
    if (paused) {
      this.store.updateOrchestration(sessionId, { paused_reason: `Cost limit reached: ${used}` });
      this.sessions.systemNote(sessionId, `Cost limit reached while paused. ${used}`);
      this.emit(sessionId);
    } else {
      this.pause(sessionId, `Cost limit reached: ${used}`);
    }
    void this.notifier.send({ title: `${o.title}: cost limit reached`, body: `${used} Running sessions go on; no new step starts. Raise the limit to go on.`, url: `/s/${sessionId}`, tag: `orch-cost-${sessionId}` }, o.started_by);
  }

  // ---------- settings ----------

  /** The owner changes its limits or its scope while it runs. The orchestrator is told what changed. */
  update(sessionId: number, patch: OrchestrationPatch): Orchestration {
    const o = this.must(sessionId);
    if (o.phase === 'done' || o.phase === 'stopped') throw new SessionError('This orchestration is closed.', 409);
    const changed: string[] = [];
    let tell = false;
    const next: Parameters<Store['updateOrchestration']>[1] = {};
    if (patch.project_keys) {
      const keys = [...new Set(patch.project_keys.map((k) => k.trim().toUpperCase()))];
      const projects = keys.map((k) => {
        const pr = this.store.projectByKey(k);
        if (!pr) throw new SessionError(`Unknown project ${k}`);
        // a project already in scope may be disabled meanwhile: it stays; a new one must be usable
        if (!o.project_ids.includes(pr.id)) assertWritable(this.store, pr);
        return pr;
      });
      const ids = projects.map((pr) => pr.id);
      const used = o.steps.find((st) => !ids.includes(st.project_id));
      if (used) throw new SessionError(`Step ${used.position} works in ${used.project_key}: it stays in the scope.`);
      // the same projects in another order are no change (the first one stays: its checkouts use that project's GitHub account)
      const same = ids.length === o.project_ids.length && ids.every((id) => o.project_ids.includes(id));
      if (!same) {
        const kept = o.project_ids.filter((id) => ids.includes(id));
        const ordered = [...kept, ...ids.filter((id) => !kept.includes(id))];
        next.project_ids = ordered;
        changed.push(`scope ${ordered.map((id) => projects.find((pr) => pr.id === id)!.key).join(', ')}`);
        tell = true;
      }
    }
    if (patch.max_children !== undefined && patch.max_children !== o.max_children) {
      next.max_children = patch.max_children;
      changed.push(`at most ${patch.max_children} batch${patch.max_children === 1 ? '' : 'es'} at once`);
      tell = true;
    }
    if (patch.cost_limit_usd !== undefined && patch.cost_limit_usd !== o.cost_limit_usd) {
      next.cost_limit_usd = patch.cost_limit_usd;
      changed.push(patch.cost_limit_usd === null ? 'no cost limit' : `cost limit ${usd(patch.cost_limit_usd)}`);
    }
    if (patch.answer_children !== undefined && patch.answer_children !== o.answer_children) {
      next.answer_children = patch.answer_children;
      changed.push(patch.answer_children ? "it answers its batches' questions" : "its batches' questions come to the owner");
      tell = true;
    }
    if (patch.notify_owner !== undefined && patch.notify_owner !== o.notify_owner) {
      next.notify_owner = patch.notify_owner;
      changed.push(patch.notify_owner === 'all' ? 'every batch notifies the owner itself' : 'the owner is told only what needs them');
    }
    const title = patch.title !== undefined && patch.title !== o.title ? patch.title : null;
    if (title) changed.push(`title "${title}"`);
    // the merge setting of its batches (DISP-109): for the steps that start later, and for the batches
    // still at work. A change that already waits for the owner's review keeps waiting.
    const merge = patch.auto_merge !== undefined && patch.auto_merge !== o.options.auto_merge ? patch.auto_merge : null;
    if (merge) {
      next.options = { ...o.options, auto_merge: merge };
      changed.push(`when a batch is done: ${MERGE_SETTING[merge]}`);
      tell = true;
    }
    if (!changed.length) return this.view(sessionId);
    this.store.updateOrchestration(sessionId, next);
    if (title) this.sessions.setTitle(sessionId, title);
    if (merge) {
      for (const st of o.steps) {
        const child = st.state === 'running' && st.child_session_id ? this.store.session(st.child_session_id) : undefined;
        if (!child || FINAL_STATUSES.includes(child.status) || child.options.auto_merge === merge) continue;
        this.sessions.setAutoMerge(child.id, merge, `The owner changed the orchestration's setting: ${MERGE_SETTING[merge]}.`);
        this.sync(st.id);
      }
    }
    if (next.answer_children === false) this.handOverAll(sessionId, 'The orchestrator no longer answers its batches: this is yours.');
    const what = `${changed.join('; ')}.`;
    this.sessions.systemNote(sessionId, `Settings changed by the owner: ${what}`);
    this.emit(sessionId);
    // a limit it is already over pauses it first: then it gets the news when it is resumed
    this.checkCost(sessionId);
    const after = this.must(sessionId);
    // paused for a limit that no longer holds: the reason goes, the pause stays until the owner resumes
    if (after.phase === 'paused' && after.paused_reason && (after.cost_limit_usd === null || cents(this.store.orchestrationCost(sessionId)) < cents(after.cost_limit_usd))) {
      this.store.updateOrchestration(sessionId, { paused_reason: null });
      this.emit(sessionId);
    }
    if (tell) this.wake(sessionId, `The owner changed your settings: ${what}`);
    return this.view(sessionId);
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
    // a batch that keeps asking cannot loop with its orchestrator: from the cap on, its questions are the owner's
    const answered = this.store.orchestratorAnswers(step.id);
    if (answered >= Orchestrator.MAX_ANSWERS) {
      this.sessions.systemNote(s.id, `The orchestrator answered ${Orchestrator.MAX_ANSWERS} questions of this step: this one is yours.`);
      this.wake(o.session_id, `${name} asked again (input_id ${input.id}). You answered ${Orchestrator.MAX_ANSWERS} questions of this step, which is the most you may (MAX_ANSWERS = ${Orchestrator.MAX_ANSWERS}): it goes to the owner, as will the step's next questions.`);
      return false;
    }
    const count = `    You answered ${answered} of this step's questions so far. You may answer ${Orchestrator.MAX_ANSWERS} (MAX_ANSWERS); after that they go to the owner.`;
    const p = input.payload;
    // the batch's own words are fenced, line by line: none of them can pass as an event or as the plan's status
    const text = p.kind === 'plan_approval'
      ? [`${name} wants its plan approved (input_id ${input.id}):`, ...fenced(p.plan.slice(0, 3000)), '    Approve it with answer_session (approve: true) if it does what the step asks, or send it back (approve: false, feedback). If only the owner can judge it, hand it to them with hand_to_owner.', count]
      : [
        `${name} asks you (input_id ${input.id}):`,
        ...p.questions.flatMap((q) => fenced(`Q: ${q.question}${q.options?.length ? ` Options: ${q.options.map((op) => `${op.label}${op.description ? ` (${op.description})` : ''}`).join(' | ')}` : ''}`)),
        '    Answer it with answer_session if the plan, the items or what the owner told you settle it. If not, hand it to the owner with hand_to_owner.',
        count,
      ];
    this.store.setInputDelegated(input.id, o.session_id, step.id);
    this.wake(o.session_id, text.join('\n'));
    return true;
  }

  /** How many questions (and plan approvals) of one step's batches the orchestrator may answer; then they are the owner's. */
  static readonly MAX_ANSWERS = 10;

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
    // the phase first: a pause hands the questions to the owner, so ownInput alone would not say why
    if (o.phase === 'paused') throw new Error("The orchestration is paused: its batches' questions are the owner's until they resume it.");
    if (o.phase === 'done' || o.phase === 'stopped') throw new Error('This orchestration is closed.');
    if (o.phase === 'plan') throw new Error("The changed plan waits for the owner: until they approve it, your batches' questions are theirs.");
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

  /**
   * The orchestrator writes to one of its batches: what is missing, or how to fix a stopped merge.
   * A batch whose turn ended gets it at once. For one that works it is queued, and the batch gets
   * it when its turn ends (DISP-105). It counts as sent when it is queued.
   */
  private sendToSession(s: Session, o: Orchestration, p: Record<string, unknown>): string {
    if (o.phase !== 'run') throw new Error(`The orchestration is ${o.phase === 'plan' ? 'not approved yet' : o.phase}.`);
    const child = this.store.session(Number(p.session_id));
    const step = child ? this.store.stepOfChild(child.id) : undefined;
    if (!child || !step || child.orchestrator_id !== o.session_id) throw new Error(`Session #${String(p.session_id)} is not a step of this orchestration.`);
    if (!o.answer_children) throw new Error('The owner deals with the batches himself in this orchestration: tell him instead.');
    if (step.state !== 'running' && step.state !== 'review') throw new Error(`Step ${step.position} is ${step.state}: its batch needs no message.`);
    if (child.status === 'waiting_input') throw new Error(`Session #${child.id} waits for an answer: answer its question instead.`);
    if (FINAL_STATUSES.includes(child.status)) throw new Error(`Session #${child.id} is closed.`);
    const text = String(p.text ?? '').trim();
    if (!text) throw new Error('Write what the batch should do.');
    if (step.messages_sent >= Orchestrator.MAX_MESSAGES) throw new Error(`You already sent ${Orchestrator.MAX_MESSAGES} messages to this step's batch: tell the owner instead.`);
    const message = `(From the orchestrator of "${s.title}", not the owner:) ${text}`;
    const count = `message ${step.messages_sent + 1} of ${Orchestrator.MAX_MESSAGES} for this step`;
    // one that works is not interrupted; an idle one with messages still waiting takes this one after them
    const queue = child.status !== 'idle' || this.store.queuedOrchMessages(child.id).length > 0;
    if (queue) this.store.queueOrchMessage(step.id, child.id, message);
    else this.sessions.sendFromDispatch(child.id, message);
    this.store.updateStep(step.id, { messages_sent: step.messages_sent + 1 });
    this.acted.add(s.id);
    this.emit(o.session_id);
    if (!queue) return `Sent to session #${child.id} (${count}). End your turn: Dispatch wakes you when it changes.`;
    if (child.status === 'idle') this.deliverQueued(child.id);
    return `Queued for session #${child.id} (${count}): it works now and gets this when its turn ends. End your turn: Dispatch wakes you when it changes.`;
  }

  /**
   * The messages that wait for a batch (DISP-105). Its turn ended: it gets them now, in order, as
   * one message, before anything else starts a turn on it. True: it works again. If it closed or
   * began to wait for an answer first, they are dropped and the orchestrator is told: a message is
   * never delivered late into another situation. Marked before the send, as in `flush`.
   */
  private deliverQueued(sessionId: number): boolean {
    const queued = this.store.queuedOrchMessages(sessionId);
    const child = this.store.session(sessionId);
    if (!queued.length || !child) return false;
    const ids = queued.map((m) => m.id);
    const step = this.store.step(queued[0].step_id);
    const phase = step && this.store.orchestration(step.orchestration_id)?.phase;
    const drop = (why: string | null) => {
      this.store.setOrchMessagesState(ids, 'dropped');
      if (!step || !why) return false;
      const said = queued.map((m) => `"${m.text.replace(/^\(From the orchestrator of .*?, not the owner:\) /, '').replace(/\s+/g, ' ').slice(0, 300)}"`).join(', ');
      this.wake(step.orchestration_id, `Your message${queued.length === 1 ? '' : 's'} to step ${step.position} (session #${child.id}) ${queued.length === 1 ? 'was' : 'were'} not delivered: ${why}. ${queued.length === 1 ? 'It' : 'They'} said: ${said}`);
      return false;
    };
    // a closed orchestration: nobody to tell
    if (!step || !phase || phase === 'done' || phase === 'stopped') return drop(null);
    if (step.child_session_id !== child.id || FINAL_STATUSES.includes(child.status)) return drop(child.status === 'failed' ? 'the session failed' : 'the session is closed');
    if (child.status === 'waiting_input') return drop('the session waits for an answer');
    if (step.state !== 'running' && step.state !== 'review') return drop(`step ${step.position} is ${step.state}`);
    if (child.status !== 'idle') return false; // it still works: they wait
    this.store.setOrchMessagesState(ids, 'delivered');
    try {
      this.sessions.sendFromDispatch(child.id, queued.map((m) => m.text).join('\n\n'));
    } catch (e) {
      return drop((e as Error).message.replace(/\.$/, ''));
    }
    return true;
  }

  /** Messages whose batch changed while nobody looked (a server restart): deliver or drop them now. */
  checkQueued() {
    for (const id of new Set(this.store.queuedOrchMessages().map((m) => m.session_id))) this.safely(() => this.deliverQueued(id));
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

  /**
   * What the orchestrator is offered to deal with before the owner is told, kept on the step so a
   * restart does not lose it (DISP-165): a stopped merge it may fix (fix_merge), a failed deploy
   * (deploy, DISP-103), a batch that ended its turn with no pull request (no_pr, DISP-122). If it
   * does nothing for it, the owner is told.
   */
  private offer(step: OrchestrationStep, offer: StepOffer) {
    this.store.updateStep(step.id, { offer, offer_messages: step.messages_sent, offered_at: this.now().toISOString() });
  }
  private clearOffer(stepId: number) {
    this.store.updateStep(stepId, { offer: null, offer_messages: null, offered_at: null });
  }
  /** The steps of an orchestration with this offer. */
  private offered(orchestrationId: number, offer: StepOffer): OrchestrationStep[] {
    return this.store.orchestration(orchestrationId)?.steps.filter((x) => x.offer === offer) ?? [];
  }

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
    if (this.store.orchestration(step.orchestration_id)?.notify_owner === 'needs_you') this.offer(step, 'no_pr');
  }

  /** A question the orchestrator had goes to the owner: said in the batch's chat, and they are told. */
  handOver(inputId: number, why: string) {
    const input = this.store.input(inputId);
    if (!input?.delegated_to || input.answered_at || input.expired) return;
    this.store.setInputDelegated(inputId, null);
    this.sessions.systemNote(input.session_id, why);
    this.sessions.inputBackToOwner(inputId);
  }

  /** What the orchestrator had (its batches' questions, and its offers) is the owner's now: they are told. */
  private handOverAll(orchestrationId: number, why: string) {
    for (const input of this.store.delegatedInputs(orchestrationId)) this.handOver(input.id, why);
    const own = this.store.session(orchestrationId);
    for (const step of this.store.orchestration(orchestrationId)?.steps ?? []) {
      if (step.offer) this.offerToOwner(own, step, 'its deploy failed, and the orchestrator cannot fix it now');
    }
  }

  /**
   * An offer the orchestrator did not take up is cleared, and the owner is told if the step still
   * needs them: its merge still stopped and no message sent to its batch, its turn still ended with
   * no pull request and no message since, or its deploy still failed. True: they were told.
   */
  private offerToOwner(own: Pick<Session, 'id' | 'title' | 'started_by'> | undefined, step: OrchestrationStep, deployWhy = 'its deploy failed'): boolean {
    this.clearOffer(step.id);
    if (!own || !step.child_session_id) return false;
    if (step.offer === 'fix_merge' && step.state === 'review' && step.messages_sent === 0) this.needsOwner(own, step, step.note ?? 'its merge stopped');
    else if (step.offer === 'no_pr' && step.state === 'running' && step.note === 'turn ended, no PR yet' && step.messages_sent === step.offer_messages) {
      const child = this.store.session(step.child_session_id);
      this.tellOwner(own.id, { title: `${own.title}: step ${step.position} waits for you`, body: (child?.last_text ?? 'Its turn ended with no pull request.').slice(0, 180), url: `/s/${step.child_session_id}`, tag: `orch-review-${step.id}` });
    } else if (step.offer === 'deploy' && deployFailed(step)) this.needsOwner(own, step, deployWhy);
    else return false;
    return true;
  }

  /** Offers that waited for their orchestrator too long (it works, or its worker is away) go to the owner (DISP-166). */
  checkOffers() {
    const now = this.now().getTime();
    for (const o of this.store.orchestrations()) {
      if (o.phase === 'done' || o.phase === 'stopped') continue;
      const own = this.store.session(o.session_id);
      for (const step of o.steps) {
        if (step.offer && step.offered_at && now - Date.parse(step.offered_at) >= this.delegateTimeoutMs) {
          this.safely(() => this.offerToOwner(own, step, 'its deploy failed, and the orchestrator did not fix it in time'));
        }
      }
    }
  }

  /**
   * Deploys of a step that ran too long with no result (the worker restarted, or the deploy killed
   * it) are failed: the step takes the failed-deploy path (DISP-166). A late result still counts.
   */
  checkDeploys() {
    const now = this.now();
    for (const o of this.store.orchestrations()) {
      if (o.phase === 'done' || o.phase === 'stopped') continue;
      for (const step of o.steps) {
        const running = Object.keys(step.deploys).filter((repo) => step.deploys[repo] === 'running');
        if (!running.length) continue;
        const deploys = { ...step.deploys };
        const started = { ...step.deploys_started };
        let lost = false;
        for (const repo of running) {
          // a deploy that ran before its start was stored ages from now
          if (!started[repo]) started[repo] = now.toISOString();
          else if (now.getTime() - Date.parse(started[repo]) >= DEPLOY_TIMEOUT_MS) [deploys[repo], lost] = ['failed', true];
        }
        if (!lost && running.every((repo) => step.deploys_started[repo])) continue;
        this.store.updateStep(step.id, { deploys, deploys_started: started });
        if (lost) this.safely(() => this.sync(step.id));
      }
    }
  }

  /** Questions that waited for their orchestrator too long (it works, or its worker is away) go to the owner. */
  checkDelegated() {
    for (const input of this.store.delegatedInputs()) {
      if (Date.now() - Date.parse(input.created_at) >= this.delegateTimeoutMs) this.handOver(input.id, 'No answer from the orchestrator in time: this is yours.');
    }
  }

  // ---------- following the batches ----------

  private onBus(e: LiveEvent) {
    if (e.t === 'session' && e.session.kind === 'orchestrator') {
      this.safely(() => this.ownSession(e.session));
      return this.safely(() => this.checkCost(e.session.id));
    }
    if (e.t === 'session' && e.session.orchestrator_id) this.safely(() => this.checkCost(e.session.orchestrator_id!));
    const child = e.t === 'session' && e.session.orchestrator_id ? e.session.id : e.t === 'pr' ? e.pr.session_id : null;
    if (child === null) return;
    // messages that waited for this batch's turn end go first: if it works again, there is no turn end to tell
    let again = false;
    if (e.t === 'session') this.safely(() => { again = this.deliverQueued(child); });
    if (again) return;
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
      this.store.dropTimers(s.id);
      this.emit(s.id);
    }
    // its page says it waits for the owner, not for a timer that cannot fire
    if (s.status === 'failed') this.emit(s.id);
  }

  /**
   * A deploy after one of a step's merges started or ended. True: the orchestration follows this
   * step, so its result is told here (to the orchestrator, or to the owner when it needs them) and
   * the batch's own deploy notice is not sent.
   */
  onDeploy(child: Session, repo: Repo, state: DeployState): boolean {
    const step = this.store.stepOfChild(child.id);
    if (!step) return false;
    // its start is kept until its result comes (DISP-166)
    const started = { ...step.deploys_started };
    if (state === 'running') started[repo.id] = this.now().toISOString();
    else delete started[repo.id];
    this.store.updateStep(step.id, { deploys: { ...step.deploys, [repo.id]: state }, deploys_started: started });
    const phase = this.store.orchestration(step.orchestration_id)?.phase;
    const followed = !!phase && phase !== 'done' && phase !== 'stopped' && ['running', 'review', 'failed'].includes(step.state);
    this.safely(() => this.sync(step.id));
    return followed;
  }

  /**
   * A step's deploy failed. True: the orchestrator may deal with it before the owner is told. Not
   * when it cannot act (paused, closed, or the owner deals with the batches), and not when a deploy
   * of another step failed before: what it did then did not clear it.
   */
  private canFixDeploy(o: Orchestration, step: OrchestrationStep): boolean {
    const own = this.store.session(o.session_id);
    if (o.phase !== 'run' || !o.answer_children || !own || FINAL_STATUSES.includes(own.status)) return false;
    return !o.steps.some((s) => s.id !== step.id && Object.values(s.deploys).includes('failed'));
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
    else if (deploys.includes('failed')) {
      // failed with its start still kept: no result came in time
      const lost = Object.keys(step.deploys).filter((r) => step.deploys[r] === 'failed').every((r) => step.deploys_started[r]);
      [state, note] = ['failed', lost ? NO_DEPLOY_RESULT : 'deploy failed'];
    }
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
    } else if (child.limit_wait) note = 'waits for the usage limit to reset'; // it goes on by itself (DISP-108)
    const seen = `${child.status}|${state}|${note ?? ''}`;
    if (seen === step.seen) return;
    this.store.updateStep(step.id, { state, note, seen });
    const o = this.store.orchestration(orchId)!;
    const title = this.store.session(orchId)?.title ?? 'Orchestration';
    const name = `Step ${step.position} "${step.title}" (${step.project_key}, session #${child.id})`;
    const events: string[] = [];
    if (state === 'failed' && step.state !== 'failed') {
      const held = this.heldBy(o, step).map((s) => s.position);
      const heldText = this.heldText(o, step);
      // a failed deploy: the orchestrator may deal with it once before the owner is told (DISP-103)
      const tryFirst = (note === 'deploy failed' || note === NO_DEPLOY_RESULT) && this.canFixDeploy(o, step);
      const more = tryFirst ? ' Its change is merged: do not run the step again. You may fix the deploy once (a step that repairs it). If you cannot, say so to the owner.' : '';
      events.push(`${name}: failed: ${note}${held.length ? ` Do not start the steps that wait for it (${held.join(', ')}).` : ''}${more}`);
      if (tryFirst) this.offer(step, 'deploy');
      else this.tellOwner(orchId, { title: `${title}: step ${step.position} failed`, body: `${note}${/[.!?]$/.test(note ?? '') ? '' : '.'}${heldText}`.slice(0, 180), url: `/s/${orchId}`, tag: `orch-failed-${step.id}` });
    } else if (state === 'done' && step.state !== 'done') {
      const completed = merged && this.completeQuietly(o, step, child);
      events.push(`${name}: ${merged ? 'merged' : `done (${note})`}.${completed ? ' Its session is completed, and the owner was not told: check its result against the step and its items\' "Done when".' : ''}`);
    } else if (state === 'review' && (step.state !== 'review' || note !== step.note)) {
      // a stopped merge: the orchestrator may write to its batch once before the owner is asked
      const tryFirst = stoppedMerge && o.answer_children && step.messages_sent === 0;
      const more = tryFirst ? ' You may tell its session once how to fix it (send_to_session). If you cannot, say so to the owner.'
        : stoppedMerge && o.answer_children ? ' Your message did not clear it: the owner is told.' : '';
      events.push(`${name}: ${note}.${more}`);
      if (tryFirst) this.offer(step, 'fix_merge');
      else if (note === "waits for the owner's review") {
        this.tellOwner(orchId, { title: `${title}: step ${step.position} waits for your review`, body: step.title, url: `/s/${child.id}`, tag: `orch-review-${step.id}` });
      } else {
        this.needsOwner({ id: orchId, title, started_by: null }, step, note ?? 'it needs you');
      }
    }
    if (state === 'done') events.push(...this.allFinished(o));
    this.emit(orchId);
    if (events.length) this.wake(orchId, ...events);
    // no pull request after its turn: news only if it stays so (the batch often opens one a moment later)
    this.noPullRequestLater(this.store.step(step.id)!);
  }

  /**
   * A step whose batch ended its turn with no pull request: the orchestrator is woken if it stays so.
   * `resumed`: after a restart, the timer is armed again, unless the wake already went out (its offer is stored).
   */
  private noPullRequestLater(step: OrchestrationStep, resumed = false) {
    if (step.state !== 'running' || step.note !== 'turn ended, no PR yet' || !step.seen) return;
    if (resumed && step.offer === 'no_pr') return;
    const o = this.store.orchestration(step.orchestration_id);
    if (o?.phase !== 'run' || !o.answer_children) return;
    const seen = step.seen;
    this.later(this.settleMs, () => this.noPullRequest(step.id, seen));
  }
}
