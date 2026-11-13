// What the orchestration panel shows for a plan and its steps (no React here, so tests can call it).
import type { Orchestration, OrchestrationStep, StepState } from '../../src/shared/types.ts';

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
  const what = step.note ?? (step.state === 'running' ? step.child?.status ?? 'running' : step.state);
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
