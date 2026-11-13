// What the orchestration panel shows for a plan and its steps (no React here, so tests can call it).
import { sessionStatusWords, type Orchestration, type OrchestrationStep, type SessionStatus, type StepState } from '../../src/shared/types.ts';

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
export function stepRight(step: OrchestrationStep, o: Pick<Orchestration, 'steps' | 'phase'>): string {
  if (step.state === 'pending') {
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

/** Why a new orchestration cannot start yet, or null. */
export function orchestrationProblem(goal: string, projectKeys: string[]): string | null {
  if (!goal.trim()) return 'Say what it should reach.';
  if (!projectKeys.length) return 'Pick at least one project.';
  return null;
}

/** For lists of sessions: each step's batch (by session id) with the orchestration and step it is part of. */
export function partOfIndex(list: Pick<Orchestration, 'title' | 'steps'>[]): Map<number, string> {
  const index = new Map<number, string>();
  for (const o of list) {
    for (const s of o.steps) if (s.child_session_id) index.set(s.child_session_id, `${o.title} · step ${s.position} of ${o.steps.length}`);
  }
  return index;
}

/**
 * The status to show for an idle orchestrator that needs nothing from its owner: it waits for its
 * steps, so it is at work (or paused), not "your turn". Undefined: its own status says it.
 */
export function orchBusyLabel(o: Pick<Orchestration, 'phase' | 'steps'>, status: SessionStatus): string | undefined {
  if (status !== 'idle') return undefined;
  if (o.phase === 'paused') return 'Paused';
  return o.phase === 'run' && o.steps.some((s) => s.state === 'running') && !o.steps.some((s) => s.state === 'failed') ? 'Running' : undefined;
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
