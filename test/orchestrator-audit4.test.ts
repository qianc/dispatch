import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrationStep } from '../src/shared/types.ts';
import { OWNER } from './helpers.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

// DISP-243: the fourth audit's orchestrator findings 38-42, and the nice-to-have 73-75 (source 68).
describe('orchestrator: fourth audit (DISP-243)', () => {
  let t: Setup;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => { t.s.ctx.orchestrator.stop(); return t.s.app.close(); });

  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  const keep = (s: OrchestrationStep, after: number[] = [], over: Record<string, unknown> = {}) =>
    ({ id: s.id, title: s.title, project_key: s.project_key, prompt: s.prompt_md, item_keys: s.item_keys, after, ...over });
  const view = (id: number) => t.s.ctx.orchestrator.view(id);

  it('38: finishing with a required step never started is not a success', async () => {
    const p = await t.approved();
    t.store.updateStep(p.first.id, { state: 'done' });
    t.store.updateStep(p.second.id, { state: 'done' });
    turn(p.id);
    await t.rpc(p.id, 'finish', { result: 'All done.' });
    expect(t.s.ctx.orchestrator.attention(p.id)).toEqual({
      kind: 'finished', met: false, text: 'Finished, but the goal is not fully met: step 3 not started. Read its summary, then re-plan or mark it complete.',
    });
    expect(t.events(p.id)).toContain('system: Finished, but the goal is not fully met: step 3 not started.');
    expect(t.pushes.find((x) => x.title === 'Rework auth: finished')?.body).toBe('Goal not fully met. All done.');
  });

  it("39: a retried step closes its old batch, so a Retry on that batch's page makes no orphan", async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    t.status(child, 'failed');
    expect(t.store.step(p.first.id)!.state).toBe('failed');
    t.s.ctx.orchestrator.retryStep(p.first.id);
    expect(t.store.session(child)).toMatchObject({ status: 'failed', closed_reason: 'retried' });
    expect((await t.s.call('POST', `/sessions/${child}/retry`)).status).toBe(409);
    // the step starts its new batch on the items
    const again = await t.startStep(p.id, p.first.id);
    expect(again).not.toBe(child);
  });

  it('40: decline checks the plan version the owner read', async () => {
    const p = await t.approved();
    turn(p.id);
    await t.rpc(p.id, 'set_plan', { plan_md: '', steps: [keep(p.first), keep(p.second, [1])] });
    const seen = view(p.id).plan_version;
    // the orchestrator replaces change A by change B while the owner reads A
    await t.rpc(p.id, 'set_plan', { plan_md: '', steps: [keep(p.first), keep(p.second, [1]), keep(p.third, [], { title: 'Docs, later' })] });
    expect((await t.s.call('POST', `/orchestrations/${p.id}/decline`, { plan_version: seen })).status).toBe(409);
    expect(view(p.id).proposal).not.toBeNull();
    expect((await t.s.call('POST', `/orchestrations/${p.id}/decline`, { plan_version: view(p.id).plan_version })).status).toBe(200);
    expect(view(p.id).proposal).toBeNull();
  });

  it('42: a step a waiting change rewrites is held from the live state, also when it failed before and is retried since', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    t.status(child, 'failed');
    // the change rewrites failed step 1: it holds nothing when it is made
    await t.rpc(p.id, 'set_plan', { plan_md: '', steps: [keep(p.first, [], { prompt: 'Build the store, the new way.' }), keep(p.second, [1]), keep(p.third)] });
    expect(view(p.id).proposal!.held).toEqual([]);
    t.s.ctx.orchestrator.retryStep(p.first.id);
    // pending again: the change holds it, so it does not start with the old prompt
    expect(view(p.id).proposal!.held).toEqual([p.first.id]);
    expect(t.s.ctx.orchestrator.readySteps(view(p.id)).map((x) => x.id)).toEqual([p.third.id]);
    await expect(t.rpc(p.id, 'start_step', { step_id: p.first.id })).rejects.toThrow('Step 1 is held by your change of the plan');
    t.s.ctx.orchestrator.approve(p.id, view(p.id).plan_version);
    expect(t.store.step(p.first.id)!.prompt_md).toBe('Build the store, the new way.');
    const again = await t.startStep(p.id, p.first.id);
    expect(t.store.session(again)!.initial_prompt).toContain('Build the store, the new way.');
  });

  it('73: a step batch moved to another worker takes the messages that waited for it', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    t.status(child, 'running');
    expect(await t.rpc(p.id, 'send_to_session', { session_id: child, text: 'Add the tests too.' })).toMatch(/^Queued/);
    const old = t.store.session(child)!;
    const next = t.store.createSession({
      project_id: old.project_id, kind: 'work', title: old.title, status: 'queued', force_plan: false, branch: null,
      initial_prompt: '', source_id: null, item_ids: old.item_ids, worker_id: old.worker_id!, started_by: OWNER, moved_from: old.id,
    });
    t.s.ctx.sessions.finish(child, 'stopped');
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'running', child_session_id: next.id });
    expect(t.store.queuedOrchMessages(next.id).map((m) => m.text)).toEqual([expect.stringContaining('Add the tests too.')]);
    expect(t.events(p.id).some((e) => e.includes('not delivered'))).toBe(false);
    // its first turn ends: it gets the message
    turn(next.id);
    expect(t.store.queuedOrchMessages(next.id)).toEqual([]);
    expect(t.events(next.id).some((e) => e.includes('Add the tests too.'))).toBe(true);
  });

  it('74: the parts of a split step keep its retries and answers', async () => {
    const a1 = await t.item('AA', 'Store part one');
    const a2 = await t.item('AA', 'Store part two');
    const id = t.start().session_id;
    await t.rpc(id, 'set_plan', { plan_md: '', steps: [{ title: 'Big store', project_key: 'AA', prompt: 'Build it.', item_keys: [a1.key, a2.key] }] });
    turn(id);
    t.s.ctx.orchestrator.approve(id);
    const [big] = view(id).steps;
    const child = await t.startStep(id, big.id);
    t.status(child, 'failed');
    await t.rpc(id, 'retry_step', { step_id: big.id, reason: 'The worker went away.' });
    // answers its batches got, counted on the step (here: carried from an earlier split)
    t.store.setCarried(big.id, { retries: 0, answers: 4 });
    await t.rpc(id, 'amend_plan', {
      steps: [
        { title: 'Store, part one', project_key: 'AA', prompt: 'One.', item_keys: [a1.key] },
        { title: 'Store, part two', project_key: 'AA', prompt: 'Two.', item_keys: [a2.key] },
      ],
      change: { kind: 'split', reason: 'Too big.' },
    });
    const [one, two] = view(id).steps;
    expect([one.id, two.id]).not.toContain(big.id);
    for (const part of [one, two]) {
      expect(t.store.carried(part.id)).toEqual({ retries: 1, answers: 4 });
      expect(t.store.orchestratorAnswers(part.id)).toBe(4);
    }
    // a part that fails is the owner's to retry: the step was retried once already
    const partChild = await t.startStep(id, one.id);
    t.status(partChild, 'failed');
    await expect(t.rpc(id, 'retry_step', { step_id: one.id, reason: 'Again.' })).rejects.toThrow(/You retried step 1 already/);
  });

  it('75: a plan write that fails half-way leaves the plan as it was', async () => {
    const p = await t.approved();
    turn(p.id);
    await t.rpc(p.id, 'set_plan', { plan_md: '', steps: [keep(p.first), keep(p.second, [1])] });
    const before = view(p.id);
    const write = vi.spyOn(t.store, 'updateOrchestration').mockImplementationOnce(() => { throw new Error('killed'); });
    expect(() => t.s.ctx.orchestrator.approve(p.id, before.plan_version)).toThrow('killed');
    write.mockRestore();
    expect(view(p.id).steps.map((x) => x.id)).toEqual(before.steps.map((x) => x.id));
    expect(view(p.id).proposal).not.toBeNull();
    // and for a new plan before the first approval: steps and version change together
    const id = t.start().session_id;
    vi.spyOn(t.store, 'updateOrchestration').mockImplementationOnce(() => { throw new Error('killed'); });
    const a = await t.item('AA', 'One');
    await expect(t.rpc(id, 'set_plan', { plan_md: '', steps: [{ title: 'One', project_key: 'AA', item_keys: [a.key] }] })).rejects.toThrow('killed');
    expect(view(id)).toMatchObject({ steps: [], plan_version: 0 });
  });
});
