import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Orchestration } from '../src/shared/types.ts';
import { orchBusyLabel } from '../web/src/orchestration.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

// Cases the whole-branch review found: work that could leave the plan, steps that could get stuck
// with no signal, and an approval of a plan the owner did not read.
describe('orchestrator: review findings', () => {
  let t: Setup;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => t.s.app.close());

  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  const post = (path: string, body: unknown = {}) => t.s.call<Orchestration & { error?: string }>('POST', path, body);
  const fail = (id: number) => { t.status(id, 'running'); t.status(id, 'failed'); };

  it("a failed batch retried from its own page stays the step's batch", async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    fail(child);
    expect(t.store.step(p.first.id)!.state).toBe('failed');
    const retry = (await t.s.call<{ id: number }>('POST', `/sessions/${child}/retry`)).data;
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'running', child_session_id: retry.id });
    expect(t.store.session(retry.id)!.orchestrator_id).toBe(p.id);
    turn(retry.id);
    t.pr(retry.id, 'merged');
    expect(t.store.step(p.first.id)!.state).toBe('done');
  });

  it('a step whose failed batch has a pull request is not retried as a new batch', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    turn(child);
    t.pr(child, 'open');
    fail(child);
    const res = await post(`/orchestration-steps/${p.first.id}/retry`);
    expect(res.status).toBe(409);
    expect(res.data.error).toBe(`Session #${child} of step 1 has a pull request: retry that session from its page, or skip the step.`);
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'failed', child_session_id: child });
  });

  it('a step whose deploy failed is not retried: its change is merged', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    const repo = t.store.repos(t.store.session(child)!.project_id!)[0];
    turn(child);
    t.s.ctx.orchestrator.onDeploy(t.store.session(child)!, repo, 'running');
    t.pr(child, 'merged');
    t.s.ctx.orchestrator.onDeploy(t.store.session(child)!, repo, 'failed');
    const res = await post(`/orchestration-steps/${p.first.id}/retry`);
    expect(res.status).toBe(409);
    expect(res.data.error).toBe('The change of step 1 is merged; only its deploy failed. Deploy it by hand, then skip the step to go on.');
  });

  it('the orchestrator cannot reopen a closed item, nor change one that is being worked on', async () => {
    const done = await t.item('AA', 'Old work', 'done');
    const review = await t.item('AA', 'In review', 'in_review');
    const id = t.start().session_id;
    await expect(t.rpc(id, 'update_item', { key: done.key, status: 'todo' })).rejects.toThrow(`${done.key} is done: an orchestrator does not change the status of an item that is closed or being worked on.`);
    await expect(t.rpc(id, 'update_item', { key: review.key, status: 'backlog' })).rejects.toThrow(/is in review/);
    expect(t.store.item(done.id)!.status).toBe('done');
    // other fields of such an item may still change
    await t.rpc(id, 'update_item', { key: done.key, comment: 'Noted.' });
  });

  it('a pull request closed without a merge puts the step in review and tells the owner', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    turn(child);
    t.pr(child, 'open');
    turn(p.id); // it took the news of the review
    t.pr(child, 'closed');
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'review', note: 'its pull request was closed without a merge' });
    expect(t.pushes).toContainEqual(expect.objectContaining({ title: 'Rework auth: step 1 needs you', body: 'Its pull request was closed without a merge.' }));
    expect(t.events(p.id).at(-1)).toContain('closed without a merge');
  });

  it('a batch the owner marks complete with an open pull request does not finish its step', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    turn(child);
    t.pr(child, 'open');
    await t.s.call('POST', `/sessions/${child}/finish`, { status: 'completed' });
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'review', note: 'its session is closed, but its pull request is still open' });
    await expect(t.rpc(p.id, 'start_step', { step_id: p.second.id })).rejects.toThrow(/which is review/);
    t.pr(child, 'merged');
    expect(t.store.step(p.first.id)!.state).toBe('done');
  });

  it("a turn that ends with nothing started reaches the owner; one that waits for its steps does not", async () => {
    const id = t.start().session_id;
    turn(id); // it asked something in its chat
    expect(t.pushes.map((x) => x.title)).toEqual(['Rework auth: waiting for you']);
    const p = await t.approved();
    t.pushes.length = 0;
    t.status(p.id, 'running');
    await t.rpc(p.id, 'start_step', { step_id: p.first.id });
    t.status(p.id, 'idle');
    expect(t.pushes).toEqual([]); // it waits for step 1
    // a later turn, with a step still running: still nothing to tell
    turn(p.id);
    expect(t.pushes).toEqual([]);
    expect(orchBusyLabel(t.s.ctx.orchestrator.view(p.id), 'idle')).toBe('Running');
  });

  it('in the run phase, an orchestrator with no step running is your turn, in the inbox and in its label', async () => {
    const p = await t.approved();
    turn(p.id); // approved, but it started nothing and asked something instead
    expect(t.pushes.map((x) => x.title)).toContain('Rework auth: waiting for you');
    const inbox = (await t.s.call<{ idle: { id: number; attention: { kind: string; text: string } }[] }>('GET', '/inbox')).data.idle.find((x) => x.id === p.id);
    expect(inbox?.attention).toEqual({ kind: 'plan', text: 'It waits for your reply.' });
    expect(orchBusyLabel(t.s.ctx.orchestrator.view(p.id), 'idle')).toBeUndefined();
  });

  it('approve refuses a plan that changed since the owner read it', async () => {
    const a = await t.item('AA', 'One');
    const id = t.start().session_id;
    await t.rpc(id, 'set_plan', { plan_md: 'A', steps: [{ title: 'Plan A', project_key: 'AA', item_keys: [a.key] }] });
    const read = t.s.ctx.orchestrator.view(id).plan_version;
    await t.rpc(id, 'set_plan', { plan_md: 'B', steps: [{ title: 'Plan B', project_key: 'AA', item_keys: [a.key] }] });
    const stale = await post(`/orchestrations/${id}/approve`, { plan_version: read });
    expect(stale.status).toBe(409);
    expect(stale.data.error).toBe('The plan changed since you opened it. Read it again, then approve.');
    expect(t.s.ctx.orchestrator.view(id).phase).toBe('plan');
    const fresh = await post(`/orchestrations/${id}/approve`, { plan_version: t.s.ctx.orchestrator.view(id).plan_version });
    expect(fresh.data).toMatchObject({ phase: 'run', steps: [{ title: 'Plan B' }] });
  });
});
