// What the orchestration panel shows for a plan and its steps (no React here, so tests can call it).
import { asksOrchestrator, waitsOnOwner } from '../../src/shared/attention.ts';
import { sessionStatusWords, type Attention, type PendingInput, type Orchestration, type Session, type OrchestrationStep, type PlanChange, type SessionStatus, type StepState } from '../../src/shared/types.ts';

export const STEP_MARK: Record<StepState, string> = { done: '✓', running: '●', review: '◐', failed: '✕', skipped: '–', pending: '○' };
export const STEP_LABEL: Record<StepState, string> = { done: 'Done', running: 'Running', review: 'In review', failed: 'Failed', skipped: 'Skipped', pending: 'Not started' };

/** Steps that are done or skipped. */
export const doneCount = (o: Pick<Orchestration, 'steps'>) => o.steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;

/** Whether the owner can still act on it. */
export const isOpen = (o: Pick<Orchestration, 'phase'>) => o.phase !== 'done' && o.phase !== 'stopped';

/** The failed step that keeps `step` from starting, directly or through the steps between. */
export function holderOf(step: OrchestrationStep, o: Pick<Orchestration, 'steps'>): OrchestrationStep | null {
  const byId = new Map(o.steps.map((s) => [s.id, s]));
  const seen = new Set<number>();
  const find = (s: OrchestrationStep): OrchestrationStep | null => {
    for (const id of s.depends_on) {
      const before = byId.get(id);
      if (!before || seen.has(id)) continue;
      seen.add(id);
      if (before.state === 'failed') return before;
      if (before.state === 'pending') {
        const up = find(before);
        if (up) return up;
      }
    }
    return null;
  };
  return find(step);
}

/** The short text at the end of a step's line: its batch and state, or what it waits for. */
export function stepRight(step: OrchestrationStep, o: Pick<Orchestration, 'steps' | 'phase'> & { proposal?: Orchestration['proposal'] }): string {
  if (step.state === 'pending') {
    if (o.proposal?.held.includes(step.id)) return 'held by the plan change';
    const holder = holderOf(step, o);
    if (holder) return `held by step ${holder.position}`;
    const place = new Map(o.steps.map((s) => [s.id, s]));
    const waits = step.depends_on.flatMap((id) => {
      const before = place.get(id);
      return before && before.state !== 'done' && before.state !== 'skipped' ? [before.position] : [];
    });
    if (waits.length) return `after ${waits.join(', ')}`;
    return o.phase === 'run' ? 'ready' : '';
  }
  const child = step.child_session_id ? `#${step.child_session_id}` : '';
  if (step.state === 'failed') return step.note ?? 'failed';
  const what = step.note ?? (step.state === 'running' ? (step.child ? sessionStatusWords(step.child.status) : 'working') : step.state);
  return [child, what].filter(Boolean).join(' ');
}

export type StepAction = 'retry' | 'skip' | 'open';

/** What the owner can do with a step from its menu. */
export function stepActions(step: OrchestrationStep, o: Pick<Orchestration, 'phase'>): StepAction[] {
  const open: StepAction[] = step.child_session_id ? ['open'] : [];
  if (!isOpen(o)) return open;
  if (step.state === 'failed') return ['retry', 'skip', ...open];
  if (step.state === 'pending' || step.state === 'review') return ['skip', ...open];
  return open;
}

const MERGE_NOW: Record<Orchestration['options']['auto_merge'], string> = {
  off: 'each change waits for your review',
  github: 'each change is merged on GitHub when its checks pass',
  local: 'each change is merged locally when its checks pass',
};

/**
 * Under the merge setting of a running orchestration (DISP-109): what it uses now, when a change
 * of it applies, and what happens to the steps that already wait for a review.
 */
export function mergeHint(o: Pick<Orchestration, 'options' | 'steps'>, picked: Orchestration['options']['auto_merge']): string {
  const waiting = o.steps.filter((s) => s.state === 'review').length;
  const now = `It uses now: ${MERGE_NOW[o.options.auto_merge]}.`;
  if (picked === o.options.auto_merge) return `${now} You can change it while it runs.`;
  const kept = waiting ? ` ${waiting === 1 ? '1 step already waits' : `${waiting} steps already wait`} for your review: ${waiting === 1 ? 'it keeps' : 'they keep'} waiting, merge ${waiting === 1 ? 'it' : 'them'} yourself.` : '';
  return `${now} After Save: ${MERGE_NOW[picked]}, from the next merge on (steps that start later, and batches still at work).${kept}`;
}

/** Why a new orchestration cannot start yet, or null. */
export function orchestrationProblem(goal: string, projectKeys: string[]): string | null {
  if (!goal.trim()) return 'Say what it should reach.';
  if (!projectKeys.length) return 'Pick at least one project.';
  return null;
}

/**
 * For lists of sessions: each step's batch (by session id) with the step and orchestration it is part of.
 * The step comes first: the title is often the start of a long goal, and a row cuts it (DISP-99).
 * `nested`: the row is under its orchestrator's row, so the step alone says it.
 */
export function partOfIndex(list: Pick<Orchestration, 'title' | 'steps'>[], nested = false): Map<number, string> {
  const index = new Map<number, string>();
  for (const o of list) {
    for (const s of o.steps) if (s.child_session_id) index.set(s.child_session_id, `Step ${s.position} of ${o.steps.length}${nested ? '' : ` · ${o.title}`}`);
  }
  return index;
}

/** The page of an orchestrator, opened at its plan and not at the newest message. */
export const planLink = (orchestratorId: number) => `/s/${orchestratorId}#plan`;

/**
 * The status to show for an idle orchestrator that needs nothing from its owner: it waits for its
 * steps, so it is at work (or paused), not "your turn". Undefined: its own status says it.
 */
export function orchBusyLabel(o: Pick<Orchestration, 'phase' | 'steps'> & Partial<Pick<Orchestration, 'next_wake'>>, status: SessionStatus): string | undefined {
  if (status !== 'idle') return undefined;
  if (o.phase === 'paused') return 'Paused';
  // at work: a step runs, or it set itself a timer; and no step has failed
  const waits = o.steps.some((s) => s.state === 'running') || !!o.next_wake;
  return o.phase === 'run' && waits && !o.steps.some((s) => s.state === 'failed') ? 'Running' : undefined;
}

/** The events in a message Dispatch sent to the orchestrator, or null for any other text. */
export function dispatchEvents(text: string): string[] | null {
  if (!text.startsWith('(From Dispatch, not the owner.)')) return null;
  const lines = text.split('\n');
  const from = lines.indexOf('Events:');
  if (from < 0) return [];
  const events: string[] = [];
  for (const line of lines.slice(from + 1)) {
    if (!line.startsWith('- ')) break;
    events.push(line.slice(2));
  }
  return events;
}

/**
 * What a question card shows as the answer to one of its questions: while it is open, what the
 * owner picks; once answered, the answer that was given (it may arrive while the card is on screen,
 * e.g. from the orchestrator).
 */
export function shownAnswer(input: Pick<PendingInput, 'answer' | 'answered_at' | 'expired'>, picked: Record<string, string>, question: string): string {
  const open = !input.answered_at && !input.expired;
  if (!open && input.answer?.kind === 'question') return input.answer.answers[question] ?? '';
  return picked[question] ?? '';
}

/** What an orchestration cost so far, with its limit when it has one ("$4.10 of $20.00"); empty before any cost. */
export function costText(o: Pick<Orchestration, 'cost_usd' | 'cost_limit_usd'>): string {
  if (!o.cost_usd && o.cost_limit_usd === null) return '';
  if (!o.cost_usd && o.cost_limit_usd !== null) return `$0.00 of $${o.cost_limit_usd.toFixed(2)}`;
  return `$${o.cost_usd.toFixed(2)}${o.cost_limit_usd !== null ? ` of $${o.cost_limit_usd.toFixed(2)}` : ''}`;
}

export interface LiveRow { s: Session; /** its batches that need the owner himself: always shown */ needs: Session[]; /** its other batches: folded */ children: Session[] }

/**
 * Activity's Live list with each orchestrator's batches under it. A batch whose orchestrator is in
 * the list is no row of its own. One that needs the owner (it asks them, or its turn waits on them)
 * shows without unfolding; one that asked its orchestrator does not.
 */
export function foldLive(live: Session[], attention: ReadonlyMap<number, Attention>): LiveRow[] {
  const here = new Set(live.filter((s) => s.kind === 'orchestrator').map((s) => s.id));
  const rows = new Map<number, LiveRow>();
  const out: LiveRow[] = [];
  for (const s of live) {
    if (s.orchestrator_id && here.has(s.orchestrator_id)) continue;
    const row = { s, needs: [], children: [] };
    rows.set(s.id, row);
    out.push(row);
  }
  for (const s of live) {
    const parent = s.orchestrator_id ? rows.get(s.orchestrator_id) : undefined;
    if (!parent || !here.has(s.orchestrator_id!)) continue;
    const a = attention.get(s.id);
    const asksOwner = s.status === 'waiting_input' && !asksOrchestrator(s);
    (asksOwner || (a && waitsOnOwner(a)) ? parent.needs : parent.children).push(s);
  }
  return out;
}

/**
 * A cost limit as the owner types it: null for an empty field (no limit), undefined when it is
 * no plain amount ("12,50" and "12.5" are; "1,000" is not, so it is never read as one dollar).
 */
export function parseLimit(text: string): number | null | undefined {
  const s = text.trim();
  if (!s) return null;
  if (!/^\d+([.,]\d{1,2})?$/.test(s)) return undefined;
  const n = Number(s.replace(',', '.'));
  return n > 0 && n <= 10_000 ? n : undefined;
}

const places = (n: number[]) => (n.length > 1 ? `steps ${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : `step ${n[0]}`);

/** A change of the running plan that waits for the owner (DISP-119): what it holds, and what goes on meanwhile. */
export function proposalLines(o: Pick<Orchestration, 'steps' | 'proposal'>): { held: string; goes: string } | null {
  const p = o.proposal;
  if (!p) return null;
  const held = o.steps.filter((s) => p.held.includes(s.id)).map((s) => s.position);
  const goes = o.steps.filter((s) => !p.held.includes(s.id) && ['pending', 'running', 'review'].includes(s.state)).map((s) => s.position);
  return {
    held: held.length ? `Held until you answer: ${places(held)}.` : 'It holds no step.',
    goes: goes.length ? `Going on now: ${places(goes)}.` : 'Nothing else is open.',
  };
}

const CHANGE_KIND: Record<PlanChange['kind'], string> = {
  fix_blocker: 'Fixed a blocker', reorder: 'Reordered', reword: 'Reworded', split: 'Split a step', retry: 'Retried a step',
  skip: 'Skipped an optional step', approved: 'You approved', declined: 'You declined',
};

/** One entry of the plan's history: who, what, why, and whether its verification passed (its step's state). */
export function changeLine(c: PlanChange, o: Pick<Orchestration, 'steps'>): { title: string; detail: string[] } {
  const step = c.step_id ? o.steps.find((s) => s.id === c.step_id) : undefined;
  const result = !c.verification ? ''
    : step?.state === 'done' ? ' (passed: its step is merged)'
    : step?.state === 'failed' ? ' (failed)'
    : step?.state === 'running' || step?.state === 'review' ? ' (running)'
    : ' (not run yet)';
  return {
    title: `${CHANGE_KIND[c.kind]}${c.decided_by === 'orchestrator' ? ' without asking' : ''}: ${c.summary}`,
    detail: [c.reason ? `Why: ${c.reason}` : '', c.verification ? `Verification: ${c.verification}${result}` : ''].filter(Boolean),
  };
}
