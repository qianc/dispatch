import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup, type Setup } from './orchestrator-helpers.ts';

// DISP-122: an orchestrator's batches send the owner nothing themselves. It completes the batches
// that went to plan, logs what it handled, and tells the owner only what needs them, several
// things in one push.
describe('orchestrator: notices of its batches (DISP-122)', () => {
  let t: Setup;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => t.s.app.close());

  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  const titles = () => t.pushes.map((p) => p.title);
  /** an approved plan whose steps 1 and 3 run; the pushes so far are dropped */
  const running = async (extra: Record<string, unknown> = {}) => {
    const p = await t.approved(extra);
    turn(p.id);
    const one = await t.startStep(p.id, p.first.id);
    const three = await t.startStep(p.id, p.third.id);
    turn(p.id);
    t.pushes.length = 0;
    return { ...p, one, three };
  };

  it('batches that finish and merge send no push; their sessions are completed and logged', async () => {
    const p = await running();
    turn(p.one);
    turn(p.three);
    t.pr(p.one, 'merged');
    t.pr(p.three, 'merged');
    turn(p.id);
    expect(titles()).toEqual([]);
    expect(t.store.session(p.one)!.status).toBe('completed');
    expect(t.store.session(p.three)!.status).toBe('completed');
    const log = t.s.ctx.orchestrator.view(p.id).quiet_log.map((e) => e.text);
    expect(log).toContain(`Step 1 "Token store" (session #${p.one}): merged; session completed.`);
    expect(log).toContain(`Step 3 "Docs" (session #${p.three}): merged; session completed.`);
  });

  it("a batch's own notice is logged, not pushed", async () => {
    const p = await running();
    t.s.ctx.github['tellStarter'](t.store.session(p.one)!, { title: 'AA: done and merged', body: 'Built it.', url: `/s/${p.one}` }, 'routine');
    expect(titles()).toEqual([]);
    expect(t.s.ctx.orchestrator.view(p.id).quiet_log[0].text).toBe(`Session #${p.one}: not pushed: AA: done and merged (Built it.)`);
  });

  it('a failed batch gives exactly one push: the step failed', async () => {
    const p = await running();
    t.status(p.one, 'failed');
    expect(titles()).toEqual(['Rework auth: step 1 failed']);
  });

  it('several things at once go out as one push that lists them', async () => {
    const p = await running();
    t.s.ctx.orchestrator.batchMs = 60_000;
    t.status(p.one, 'failed');
    t.status(p.three, 'failed');
    expect(titles()).toEqual([]);
    t.s.ctx.orchestrator.flushOwner(p.id);
    expect(t.pushes).toHaveLength(1);
    expect(t.pushes[0].title).toBe('Rework auth: 2 things need you');
    expect(t.pushes[0].body).toContain('- step 1 failed');
    expect(t.pushes[0].body).toContain('- step 3 failed');
    expect(t.pushes[0].url).toBe(`/s/${p.id}`);
  });

  it("a batch's question goes to the owner when the orchestrator does not answer them", async () => {
    const p = await running({ answer_children: false });
    t.s.ctx.sessions.onWorkerMessage(t.store.session(p.one)!.worker_id!, { t: 'input_request', session_id: p.one, local_id: 'q1', payload: { kind: 'question', questions: [{ question: 'Which store?', header: 'Store', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }] } } as never);
    expect(titles()).toEqual(['AA: question']);
  });

  it('a batch that ends its turn with nothing for the orchestrator to do reaches the owner', async () => {
    t.s.ctx.orchestrator.settleMs = 0;
    const p = await running();
    turn(p.one);
    expect(titles()).toEqual([]);
    turn(p.id); // the orchestrator did nothing for it
    expect(titles()).toEqual(['Rework auth: step 1 waits for you']);
  });

  it('with the setting "all", every batch notifies the owner itself', async () => {
    const p = await running({ notify_owner: 'all' });
    t.status(p.one, 'failed');
    expect(titles()).toContain('AA: session failed');
    expect(titles()).toContain('Rework auth: step 1 failed');
  });

  it('the owner changes the setting', async () => {
    const p = await running();
    expect(t.s.ctx.orchestrator.view(p.id).notify_owner).toBe('needs_you');
    const res = await t.s.call('PATCH', `/orchestrations/${p.id}`, { notify_owner: 'all' });
    expect(res.data.notify_owner).toBe('all');
    expect(t.events(p.id).some((e) => e.includes('every batch notifies the owner itself'))).toBe(true);
  });

  it('the end is one push, with the batches it completed quietly', async () => {
    const p = await running();
    for (const child of [p.one, p.three]) {
      turn(child);
      t.pr(child, 'merged');
    }
    turn(p.id);
    t.s.ctx.orchestrator.skipStep(p.second.id);
    t.status(p.id, 'running');
    await t.rpc(p.id, 'finish', { result: 'All done.' });
    t.status(p.id, 'idle');
    expect(t.pushes).toEqual([{ title: 'Rework auth: finished', body: 'Goal not fully met. 2 batches completed without a push (see the quiet log). All done.', url: `/s/${p.id}` }]);
  });
});
