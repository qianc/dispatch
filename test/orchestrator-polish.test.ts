import { describe, expect, it } from 'vitest';
import { sessionStatusWords, type Orchestration, type OrchestrationStep } from '../src/shared/types.ts';
import { dispatchEvents, orchBusyLabel, stepRight } from '../web/src/orchestration.ts';
import { setup } from './orchestrator-helpers.ts';

// What the owner reads about an orchestration is in plain words, and says "your turn" only when it is.
describe('orchestration wording', () => {
  const step = (over: Partial<OrchestrationStep>): OrchestrationStep => ({
    id: 1, orchestration_id: 5, position: 1, title: 'x', project_id: 1, project_key: 'AA', prompt_md: '', item_ids: [], item_keys: [], depends_on: [],
    state: 'running', note: null, child_session_id: 12, seen: null, deploys: {}, messages_sent: 0, child: null, ...over,
  });

  it('a batch that asks its owner something "needs you", in the step line and in what the orchestration waits for', async () => {
    expect(sessionStatusWords('waiting_input')).toBe('needs you');
    expect(sessionStatusWords('running')).toBe('working');
    expect(sessionStatusWords('idle')).toBe('turn ended');
    expect(stepRight(step({ child: { id: 12, status: 'waiting_input', title: 'x', waiting_reason: null } }), { steps: [], phase: 'run' })).toBe('#12 needs you');
    const t = await setup();
    try {
      const p = await t.approved();
      const child = await t.startStep(p.id, p.first.id);
      t.store.updateSession(child, { status: 'waiting_input' });
      expect(t.s.ctx.orchestrator.view(p.id).waiting).toBe(`Waiting for #${child} (needs you) in AA`);
    } finally {
      await t.s.app.close();
    }
  });

  it('an idle orchestrator that waits for its steps is running, not "your turn"', () => {
    const o = (over: Partial<Orchestration>) => ({ phase: 'run', plan_approved: true, steps: [step({})], ...over }) as Orchestration;
    expect(orchBusyLabel(o({}), 'idle')).toBe('Running');
    expect(orchBusyLabel(o({ phase: 'paused' }), 'idle')).toBe('Paused');
    // it needs the owner: a plan to approve or a question, or a failed step
    expect(orchBusyLabel(o({ phase: 'plan', plan_approved: false }), 'idle')).toBeUndefined();
    expect(orchBusyLabel(o({ steps: [step({ state: 'failed' })] }), 'idle')).toBeUndefined();
    // its own status says the rest
    expect(orchBusyLabel(o({}), 'running')).toBeUndefined();
    expect(orchBusyLabel(o({ phase: 'done' }), 'completed')).toBeUndefined();
  });

  it("Dispatch's message to the orchestrator is shown as its events, not as one long line", () => {
    const text = '(From Dispatch, not the owner.)\nEvents:\n- Step 1 "Token store" (AA, session #2): merged.\n- All steps are finished. Write the result for the owner and call finish.\n\nPlan now (phase run, at most 2 at once):\n1. [done] AA — Token store (step_id 1, session #2)\nReady to start: none';
    expect(dispatchEvents(text)).toEqual(['Step 1 "Token store" (AA, session #2): merged.', 'All steps are finished. Write the result for the owner and call finish.']);
    expect(dispatchEvents('Plan approved.')).toBeNull();
  });
});
