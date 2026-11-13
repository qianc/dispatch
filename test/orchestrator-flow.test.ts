import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Orchestration } from '../src/shared/types.ts';
import { orchestratorPrompt } from '../src/worker/prompts.ts';
import { startWorker, stopWorker, waitFor } from './helpers.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

describe('orchestrator: the worker', () => {
  let t: Setup;
  let worker: ChildProcess | null = null;
  beforeEach(async () => { t = await setup(); });
  afterEach(async () => {
    if (worker) await stopWorker(worker);
    worker = null;
    await t.s.app.close();
  });

  it('the prompt names the scope, the two phases and the plan as it stands', async () => {
    const p = await t.approved();
    const spec = t.s.ctx.sessions.spec(t.store.session(p.id)!, '', null, null);
    const text = orchestratorPrompt(spec, [{ label: 'aa/CLAUDE.md', text: 'Items need a module.' }]);
    expect(text).toContain('Rework auth');
    expect(text).toContain('AA (Project AA)');
    expect(text).toContain('BB (Project BB)');
    expect(text).toMatch(/## Plan phase/);
    expect(text).toMatch(/## Run phase/);
    expect(text).toContain('set_plan');
    expect(text).toContain('start_step');
    expect(text).toMatch(/never merge/i);
    expect(text).toContain(`1. [pending] AA — Token store (step_id ${p.first.id})`);
    expect(text).toContain(`Ready to start: ${p.first.id}, ${p.third.id}`);
    expect(text).toContain('Items need a module.');
  });

  it('plans, runs both steps in order and finishes', async () => {
    await t.item('AA', 'Store tokens');
    await t.item('BB', 'Use tokens');
    worker = startWorker(t.s.port);
    await waitFor(() => t.s.ctx.hub.isConnected(t.store.defaultWorkerId()), 'worker');
    const id = (await t.s.call<Orchestration>('POST', '/orchestrations', { goal: 'Rework auth', project_keys: ['AA', 'BB'] })).data.session_id;
    const view = () => t.s.ctx.orchestrator.view(id);
    // its first turn writes the plan: one step per project, the second after the first
    await waitFor(() => view().steps.length === 2 && t.store.session(id)!.status === 'idle', 'the plan');
    expect(view()).toMatchObject({ phase: 'plan', plan_approved: false });
    expect(view().steps.map((x) => x.project_key)).toEqual(['AA', 'BB']);
    await t.s.call('POST', `/orchestrations/${id}/approve`);
    /** the step's batch runs its (fake) turn, which asks a question; answer it, then its PR merges */
    const runStep = async (n: number) => {
      const child = await waitFor(() => view().steps[n].child_session_id, `step ${n + 1} to start`);
      const input = await waitFor(() => t.store.openInputs().find((i) => i.session_id === child), `question of step ${n + 1}`);
      await t.s.call('POST', `/inputs/${input.id}/answer`, { kind: 'question', answers: { 'Which approach should I take?': 'Small fix' } });
      await waitFor(() => t.store.session(child)!.status === 'idle', `step ${n + 1} to end its turn`);
      t.pr(child, 'merged');
      return child;
    };
    const first = await runStep(0);
    const second = await runStep(1);
    expect(second).not.toBe(first);
    await waitFor(() => view().phase === 'done' && t.store.session(id)!.status === 'completed', 'the end', 15_000);
    expect(view().steps.map((x) => x.state)).toEqual(['done', 'done']);
    expect(t.store.session(id)!.last_text).toBe('(fake) All done.');
    expect(t.pushes.map((x) => x.title)).toEqual(expect.arrayContaining(['Rework auth: plan ready to approve', 'Rework auth: finished']));
  }, 40_000);
});
