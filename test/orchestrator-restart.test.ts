import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup, type Setup } from './orchestrator-helpers.ts';

// DISP-165: a server restart in the middle of the orchestrator's turn (a deploy of Dispatch itself)
// loses nothing it still has to tell: each test makes a new Orchestrator on the same store between
// the event and the turn's end.
describe('orchestrator: pushes and wakes survive a restart (DISP-165)', () => {
  let t: Setup;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => { t.s.ctx.orchestrator.stop(); return t.s.app.close(); });

  const told = (id: number) => t.events(id).filter((e) => e.startsWith('system: (From Dispatch'));
  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  const titles = () => t.pushes.map((p) => p.title);
  const count = (title: string) => titles().filter((x) => x === title).length;
  const running = async (extra: Record<string, unknown> = {}) => {
    const p = await t.approved(extra);
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    t.status(child, 'running');
    turn(p.id);
    t.pushes.length = 0;
    return { ...p, child };
  };

  it('plan ready: the turn that proposed it ends after the restart', async () => {
    const a = await t.item('AA', 'One');
    const id = t.start().session_id;
    t.status(id, 'running');
    await t.rpc(id, 'set_plan', { plan_md: '', steps: [{ title: 'In AA', project_key: 'AA', item_keys: [a.key] }] });
    t.restart();
    t.status(id, 'idle');
    expect(titles()).toEqual(['Rework auth: plan ready to approve']);
    // the worker reports idle again, and a later turn that changes nothing: no second push
    t.status(id, 'idle');
    turn(id);
    expect(count('Rework auth: plan ready to approve')).toBe(1);
  });

  it('plan change to approve: the turn that proposed it ends after the restart', async () => {
    const p = await running();
    t.status(p.id, 'running');
    await t.rpc(p.id, 'set_plan', { plan_md: 'Without the docs.', steps: [
      { id: p.first.id, title: 'Token store', project_key: 'AA', prompt: 'Build the store.', item_keys: [p.a.key] },
      { id: p.second.id, title: 'Use the tokens', project_key: 'BB', prompt: 'Use it.', item_keys: [p.b.key], after: [1] },
    ] });
    t.restart();
    t.status(p.id, 'idle');
    t.status(p.id, 'idle');
    turn(p.id);
    expect(count('Rework auth: plan change to approve')).toBe(1);
  });

  it('finished: finish was called in the turn that ends after the restart', async () => {
    const p = await t.approved();
    for (const st of [p.first, p.second, p.third]) t.store.updateStep(st.id, { state: 'done' });
    t.status(p.id, 'running');
    await t.rpc(p.id, 'finish', { result: 'All in.' });
    t.restart();
    expect(titles()).not.toContain('Rework auth: finished');
    t.status(p.id, 'idle');
    t.status(p.id, 'idle');
    expect(count('Rework auth: finished')).toBe(1);
    // the owner writes to it: it runs again, and a second finish is told again
    t.s.ctx.orchestrator.ownerWrote(p.id);
    t.status(p.id, 'running');
    await t.rpc(p.id, 'finish', { result: 'Still all in.' });
    t.restart();
    t.status(p.id, 'idle');
    expect(count('Rework auth: finished')).toBe(2);
  });

  it('a stopped merge it did not try to fix: the owner is told at the turn end after the restart', async () => {
    const p = await running({ options: { auto_merge: 'github' } });
    t.status(p.child, 'idle');
    t.pr(p.child, 'open', { blocked: 'the check failed' });
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'review', offer: 'fix_merge', offered_at: expect.any(String) });
    t.restart();
    expect(titles()).toEqual([]);
    t.status(p.id, 'idle');
    t.status(p.id, 'idle');
    expect(count('Rework auth: step 1 needs you')).toBe(1);
    expect(t.store.step(p.first.id)).toMatchObject({ offer: null, offer_messages: null, offered_at: null });
  });

  it('a failed deploy it did nothing for: one push at the turn end after the restart', async () => {
    const p = await running();
    const child = t.store.session(p.child)!;
    const repo = t.store.repos(child.project_id!)[0];
    turn(p.child);
    t.s.ctx.orchestrator.onDeploy(child, repo, 'running');
    t.pr(p.child, 'merged');
    turn(p.id);
    t.pushes.length = 0;
    t.s.ctx.sessions.onWorkerMessage(child.worker_id!, { t: 'deploy_result', session_id: p.child, repo_id: repo.id, ok: false, sha: 'abc1234', output: 'boom', duration_ms: 1000 });
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'failed', note: 'deploy failed', offer: 'deploy' });
    t.restart();
    turn(p.id);
    t.status(p.id, 'idle');
    expect(t.pushes.filter((x) => x.title === 'Rework auth: step 1 needs you')).toEqual([{ title: 'Rework auth: step 1 needs you', body: 'Its deploy failed, and the orchestrator did not fix it.', url: `/s/${p.child}` }]);
  });

  it('a turn that ended with no pull request, told to it before the restart: the owner is told once', async () => {
    const p = await running();
    t.s.ctx.orchestrator.settleMs = 0;
    turn(p.child);
    expect(told(p.id).filter((m) => m.includes('ended its turn with no pull request'))).toHaveLength(1);
    expect(t.store.step(p.first.id)).toMatchObject({ offer: 'no_pr', offer_messages: 0 });
    let armed = 0;
    t.restart((o) => { o.later = () => void armed++; });
    expect(armed).toBe(0); // its wake went out before: not again
    t.status(p.id, 'idle');
    turn(p.id);
    expect(count('Rework auth: step 1 waits for you')).toBe(1);
    expect(told(p.id).filter((m) => m.includes('ended its turn with no pull request'))).toHaveLength(1);
  });

  it('a turn that ended with no pull request just before the restart: its wake comes after resume', async () => {
    const p = await running();
    t.s.ctx.orchestrator.later = () => {}; // the server stops before the timer runs
    turn(p.child);
    expect(t.store.step(p.first.id)).toMatchObject({ note: 'turn ended, no PR yet' });
    const wakes: (() => void)[] = [];
    t.restart((o) => { o.later = (_ms, fn) => void wakes.push(fn); });
    expect(wakes).toHaveLength(1);
    wakes[0]();
    expect(told(p.id).filter((m) => m.includes(`(AA, session #${p.child}) ended its turn with no pull request`))).toHaveLength(1);
    // its turn ends with nothing done for it: the owner is told
    turn(p.id);
    expect(count('Rework auth: step 1 waits for you')).toBe(1);
  });
});
