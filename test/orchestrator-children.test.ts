import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/server/orchestrator.ts';
import { OWNER } from './helpers.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

// The server follows each step's batch and wakes the orchestrator when a step is done, fails or
// needs a review. Events wait until the orchestrator's session is idle, and come together.
describe('orchestrator: children', () => {
  let t: Setup;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => t.s.app.close());

  /** the messages Dispatch sent to the orchestrator */
  const told = (id: number) => t.events(id).filter((e) => e.startsWith('system: (From Dispatch'));
  /** the orchestrator works for a turn, then is idle again */
  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  /** a child's turn ends */
  const childTurn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };

  it('a merged child makes the step done and wakes the orchestrator with the plan and what is ready', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    childTurn(child);
    t.pr(child, 'merged');
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'done', note: null });
    const last = told(p.id).at(-1)!;
    expect(last).toContain(`- Step 1 "Token store" (AA, session #${child}): merged.`);
    expect(last).toContain(`1. [done] AA — Token store (step_id ${p.first.id}, session #${child})`);
    expect(last).toContain(`Ready to start: ${p.second.id}, ${p.third.id}`);
    expect(t.store.pendingOrchEvents(p.id)).toEqual([]);
  });

  it('events wait while the orchestrator works and come together at its turn end', async () => {
    const p = await t.approved();
    t.status(p.id, 'running');
    const before = told(p.id).length;
    const one = await t.startStep(p.id, p.first.id);
    const three = await t.startStep(p.id, p.third.id);
    childTurn(one);
    childTurn(three);
    t.pr(one, 'merged');
    t.pr(three, 'merged');
    expect(told(p.id)).toHaveLength(before);
    expect(t.store.pendingOrchEvents(p.id)).toHaveLength(2);
    t.status(p.id, 'idle');
    expect(told(p.id)).toHaveLength(before + 1);
    expect(told(p.id).at(-1)).toMatch(/Step 1 "Token store"[^\n]*merged\.\n- Step 3 "Docs"[^\n]*merged\./);
  });

  it('a failed child fails the step, holds its dependants and tells the owner once', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    t.status(child, 'running');
    t.s.ctx.sessions.onWorkerMessage(t.store.session(child)!.worker_id!, { t: 'status', session_id: child, status: 'failed', error: 'The build broke.' });
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'failed', note: 'The build broke.' });
    const mine = () => t.pushes.filter((x) => x.title === 'Rework auth: step 1 failed');
    expect(mine()).toHaveLength(1);
    expect(mine()[0]).toMatchObject({ body: 'The build broke. Step 2 is held.', url: `/s/${p.id}` });
    expect(told(p.id).at(-1)).toContain(`- Step 1 "Token store" (AA, session #${child}): failed: The build broke.`);
    // the same state again tells nobody again
    t.s.ctx.bus.emit({ t: 'session', session: t.store.session(child)! });
    expect(mine()).toHaveLength(1);
    await expect(t.rpc(p.id, 'start_step', { step_id: p.second.id })).rejects.toThrow(/which is failed/);
    expect(t.s.ctx.orchestrator.view(p.id).waiting).toBe('Step 1 failed');
  });

  it('an open PR without auto-merge puts the step in review and tells the owner', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    childTurn(child);
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'running', note: 'turn ended, no PR yet' });
    t.pr(child, 'open');
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'review', note: "waits for the owner's review" });
    expect(t.pushes).toContainEqual(expect.objectContaining({ title: 'Rework auth: step 1 waits for your review', url: `/s/${child}` }));
    expect(told(p.id).at(-1)).toContain("waits for the owner's review");
    t.pr(child, 'merged');
    expect(t.store.step(p.first.id)!.state).toBe('done');
  });

  it('a child that waits for auto-merge stays running and wakes nobody; a blocked merge needs a review', async () => {
    const p = await t.approved({ options: { auto_merge: 'github' } });
    turn(p.id);
    const before = told(p.id).length;
    const child = await t.startStep(p.id, p.first.id);
    childTurn(child);
    t.pr(child, 'open');
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'running', note: 'checking, then auto-merge' });
    expect(told(p.id)).toHaveLength(before);
    t.pr(child, 'open', { blocked: 'the check failed' });
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'review', note: 'the check failed' });
    expect(told(p.id).at(-1)).toContain('the check failed');
  });

  it('a deploy keeps the step running until it reports; a failed deploy fails it', async () => {
    const p = await t.approved();
    turn(p.id);
    const one = await t.startStep(p.id, p.first.id);
    const three = await t.startStep(p.id, p.third.id);
    const repo = t.store.repos(t.store.session(one)!.project_id!)[0];
    childTurn(one);
    childTurn(three);
    t.s.ctx.orchestrator.onDeploy(t.store.session(one)!, repo, 'running');
    t.pr(one, 'merged');
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'running', note: 'deploying' });
    t.s.ctx.orchestrator.onDeploy(t.store.session(one)!, repo, 'ok');
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'done', note: null });
    t.s.ctx.orchestrator.onDeploy(t.store.session(three)!, repo, 'running');
    t.pr(three, 'merged');
    t.s.ctx.orchestrator.onDeploy(t.store.session(three)!, repo, 'failed');
    expect(t.store.step(p.third.id)).toMatchObject({ state: 'failed', note: 'deploy failed' });
  });

  it('a moved child keeps its step', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    const old = t.store.session(child)!;
    const next = t.store.createSession({
      project_id: old.project_id, kind: 'work', title: old.title, status: 'queued', force_plan: false, branch: null,
      initial_prompt: '', source_id: null, item_ids: old.item_ids, worker_id: old.worker_id!, started_by: OWNER, moved_from: old.id,
    });
    t.s.ctx.sessions.finish(child, 'stopped');
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'running', child_session_id: next.id });
    expect(t.store.session(next.id)!.orchestrator_id).toBe(p.id);
    expect(t.pushes.filter((x) => /failed/.test(x.title))).toEqual([]);
  });

  it('a stopped child fails its step', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    t.s.ctx.sessions.finish(child, 'stopped');
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'failed', note: 'stopped' });
  });

  it('all steps finished: it is told to write the result', async () => {
    const p = await t.approved();
    turn(p.id);
    t.store.updateStep(p.second.id, { state: 'skipped' });
    t.store.updateStep(p.third.id, { state: 'done' });
    const child = await t.startStep(p.id, p.first.id);
    childTurn(child);
    t.pr(child, 'merged');
    expect(told(p.id).at(-1)).toContain('- All steps are finished. Write the result for the owner and call finish.');
  });

  it('a restart delivers queued events once', async () => {
    const p = await t.approved();
    turn(p.id);
    const before = told(p.id).length;
    t.store.addOrchEvent(p.id, 'First thing.');
    t.store.addOrchEvent(p.id, 'Second thing.');
    const again = new Orchestrator({ store: t.store, bus: t.s.ctx.bus, sessions: t.s.ctx.sessions, notifier: t.s.ctx.notifier });
    again.resume();
    again.resume();
    again.stop();
    expect(told(p.id)).toHaveLength(before + 1);
    expect(told(p.id).at(-1)).toMatch(/- First thing\.\n- Second thing\./);
    expect(t.store.pendingOrchEvents(p.id)).toEqual([]);
  });

  it('a restart catches up with a child that changed while the server was down', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    t.s.ctx.orchestrator.stop(); // nobody listens: the server is "down"
    childTurn(child);
    t.pr(child, 'merged');
    expect(t.store.step(p.first.id)!.state).toBe('running');
    const again = new Orchestrator({ store: t.store, bus: t.s.ctx.bus, sessions: t.s.ctx.sessions, notifier: t.s.ctx.notifier });
    again.resume();
    again.stop();
    expect(t.store.step(p.first.id)!.state).toBe('done');
  });

  it("the orchestrator's own turn end sends no push, except plan ready", async () => {
    const a = await t.item('AA', 'One');
    const id = t.start().session_id;
    t.status(id, 'running');
    t.status(id, 'idle');
    expect(t.pushes).toEqual([]);
    t.status(id, 'running');
    await t.rpc(id, 'set_plan', { plan_md: '', steps: [{ title: 'In AA', project_key: 'AA', item_keys: [a.key] }] });
    expect(t.pushes).toEqual([]);
    t.status(id, 'idle');
    expect(t.pushes.map((x) => x.title)).toEqual(['Rework auth: plan ready to approve']);
    turn(id);
    expect(t.pushes).toHaveLength(1);
  });

  it('finish during a turn completes the session when the turn ends', async () => {
    const p = await t.approved();
    for (const st of [p.first, p.second, p.third]) t.store.updateStep(st.id, { state: 'done' });
    t.status(p.id, 'running');
    await t.rpc(p.id, 'finish', { result: 'All in.' });
    expect(t.store.session(p.id)!.status).toBe('running');
    t.status(p.id, 'idle');
    expect(t.store.session(p.id)!.status).toBe('completed');
    expect(t.pushes.map((x) => x.title)).toContain('Rework auth: finished');
  });
});
