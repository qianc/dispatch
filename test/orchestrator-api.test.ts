import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Orchestration } from '../src/shared/types.ts';
import { as, startMultiUser } from './helpers.ts';
import { projects, setup, type Setup } from './orchestrator-helpers.ts';

// What the owner does with an orchestration from the app: start, approve, pause, stop, and skip or
// retry a step. The inbox shows it only when it needs them.
describe('orchestrator: API', () => {
  let t: Setup;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => t.s.app.close());

  const told = (id: number) => t.events(id).filter((e) => e.startsWith('system: (From Dispatch'));
  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  const post = (path: string, body: unknown = {}) => t.s.call<Orchestration & { error?: string }>('POST', path, body);

  it('POST creates, GET lists and shows it with its steps and children', async () => {
    const made = await post('/orchestrations', { goal: 'Rework auth\nIn both apps.', project_keys: ['aa', 'BB'], max_children: 3, options: { auto_merge: 'github' } });
    expect(made.status).toBe(200);
    expect(made.data).toMatchObject({ title: 'Rework auth', goal: 'Rework auth\nIn both apps.', project_keys: ['AA', 'BB'], max_children: 3, phase: 'plan', options: { auto_merge: 'github' } });
    expect((await post('/orchestrations', { goal: '', project_keys: ['AA'] })).status).toBe(400);
    expect((await post('/orchestrations', { goal: 'x', project_keys: [] })).status).toBe(400);
    expect((await post('/orchestrations', { goal: 'x', project_keys: ['AA'], max_children: 9 })).status).toBe(400);
    const p = await t.approved();
    const child = await t.startStep(p.id, p.first.id);
    const list = (await t.s.call<Orchestration[]>('GET', '/orchestrations')).data;
    expect(list.map((o) => o.session_id)).toEqual([p.id, made.data.session_id]);
    const one = (await t.s.call<Orchestration>('GET', `/orchestrations/${p.id}`)).data;
    expect(one.steps[0]).toMatchObject({ state: 'running', child: { id: child, title: 'Token store', status: 'queued' } });
    expect(one.steps[1].child).toBeNull();
    expect(one.waiting).toBe(`Waiting for #${child} (queued) in AA`);
    expect((await t.s.call('GET', '/orchestrations/99999')).status).toBe(404);
  });

  it('approve, pause, resume and stop over the API', async () => {
    const a = await t.item('AA', 'One');
    const id = t.start().session_id;
    expect((await post(`/orchestrations/${id}/approve`)).status).toBe(409);
    await t.rpc(id, 'set_plan', { plan_md: '', steps: [{ title: 'In AA', project_key: 'AA', item_keys: [a.key] }] });
    expect((await post(`/orchestrations/${id}/approve`)).data).toMatchObject({ phase: 'run', plan_approved: true });
    expect((await post(`/orchestrations/${id}/pause`)).data).toMatchObject({ phase: 'paused', paused_from: 'run', waiting: 'Paused' });
    expect((await post(`/orchestrations/${id}/pause`)).status).toBe(409);
    const [step] = t.s.ctx.orchestrator.view(id).steps;
    await expect(t.rpc(id, 'start_step', { step_id: step.id })).rejects.toThrow('The orchestration is paused.');
    expect((await post(`/orchestrations/${id}/resume`)).data).toMatchObject({ phase: 'run', paused_from: null });
    expect((await post(`/orchestrations/${id}/resume`)).status).toBe(409);
    expect((await post(`/orchestrations/${id}/stop`)).data).toMatchObject({ phase: 'stopped', status: 'stopped' });
    expect((await post(`/orchestrations/${id}/approve`)).status).toBe(409);
  });

  it('paused: events are kept, resume delivers them', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    await post(`/orchestrations/${p.id}/pause`);
    const before = told(p.id).length;
    turn(child);
    t.pr(child, 'merged');
    expect(t.store.step(p.first.id)!.state).toBe('done');
    expect(told(p.id)).toHaveLength(before);
    await post(`/orchestrations/${p.id}/resume`);
    expect(told(p.id)).toHaveLength(before + 1);
    expect(told(p.id).at(-1)).toContain('Step 1 "Token store"');
  });

  it('stop with stop_children stops the running batches and puts their items back to todo', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    const kept = await post(`/orchestrations/${p.id}/stop`, { stop_children: true });
    expect(kept.data.phase).toBe('stopped');
    expect(t.store.session(child)!.status).toBe('stopped');
    expect(t.store.item(p.a.id)!.status).toBe('todo');
    expect(t.store.session(p.id)!.status).toBe('stopped');
    // stopping it is not a failed step: nobody is told
    expect(t.pushes.filter((x) => /step 1 failed/.test(x.title))).toEqual([]);
  });

  it('stop without stop_children leaves the running batches alone', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    await post(`/orchestrations/${p.id}/stop`);
    expect(t.store.session(child)!.status).toBe('queued');
  });

  it('skip a failed step releases its dependants; retry makes it pending and it can start again', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    expect((await post(`/orchestration-steps/${p.first.id}/skip`)).status).toBe(409); // running
    expect((await post(`/orchestration-steps/${p.first.id}/retry`)).status).toBe(409); // not failed
    t.status(child, 'running');
    t.status(child, 'failed');
    turn(p.id);
    const retried = await post(`/orchestration-steps/${p.first.id}/retry`);
    expect(retried.data.steps[0]).toMatchObject({ state: 'pending', child_session_id: null, note: `retry of session #${child}` });
    expect(told(p.id).at(-1)).toContain('The owner asks to retry step 1 ("Token store")');
    const second = await t.startStep(p.id, p.first.id);
    expect(second).not.toBe(child);
    expect(t.store.session(second)!.item_ids).toEqual([p.a.id]);
    t.status(second, 'running');
    t.status(second, 'failed');
    turn(p.id);
    const skipped = await post(`/orchestration-steps/${p.first.id}/skip`);
    expect(skipped.data.steps[0]).toMatchObject({ state: 'skipped' });
    turn(p.id); // it was still busy with the failure: the skip reaches it at its turn end
    expect(told(p.id).at(-1)).toContain('The owner skipped step 1 ("Token store")');
    await t.rpc(p.id, 'start_step', { step_id: p.second.id });
    expect(t.store.step(p.second.id)!.state).toBe('running');
    expect((await post('/orchestration-steps/99999/skip')).status).toBe(404);
  });

  it('the inbox shows a plan to approve and a failed step, not an orchestrator that only waits', async () => {
    const inbox = async () => (await t.s.call<{ idle: { id: number; attention: { kind: string; text: string } }[] }>('GET', '/inbox')).data.idle.filter((x) => x.id === id);
    const a = await t.item('AA', 'One');
    const b = await t.item('AA', 'Two');
    const id = t.start().session_id;
    turn(id);
    expect((await inbox())[0].attention).toEqual({ kind: 'plan', text: 'It waits for your reply before it can plan.' }); // it asked something in its chat
    await t.rpc(id, 'set_plan', { plan_md: '', steps: [{ title: 'First', project_key: 'AA', item_keys: [a.key] }, { title: 'Then', project_key: 'AA', item_keys: [b.key], after: [1] }] });
    expect((await inbox())[0].attention).toMatchObject({ kind: 'plan', text: 'The plan is ready: read it and approve it.' });
    await post(`/orchestrations/${id}/approve`);
    const [first] = t.s.ctx.orchestrator.view(id).steps;
    const child = await t.startStep(id, first.id);
    turn(id);
    expect(await inbox()).toEqual([]); // it waits for step 1: nothing for you
    t.status(child, 'running');
    t.status(child, 'failed');
    turn(id);
    expect((await inbox())[0].attention).toMatchObject({ kind: 'step_failed', step_id: first.id, text: 'Step 1 failed. Step 2 is held.' });
  });

  it("a session's detail carries its orchestration, and a child's says which step it is", async () => {
    const p = await t.approved();
    const child = await t.startStep(p.id, p.second.id).catch(() => null);
    expect(child).toBeNull(); // step 2 waits for step 1
    const one = await t.startStep(p.id, p.first.id);
    const own = (await t.s.call('GET', `/sessions/${p.id}`)).data;
    expect(own.orchestration).toMatchObject({ session_id: p.id, phase: 'run' });
    expect(own.part_of).toBeNull();
    const kid = (await t.s.call('GET', `/sessions/${one}`)).data;
    expect(kid.orchestration).toBeNull();
    expect(kid.part_of).toEqual({ orchestrator_id: p.id, title: 'Rework auth', step_position: 1, step_count: 3 });
  });

  it('a session the owner closes by hand stops its orchestration; a failed one is not retried as a new session', async () => {
    const p = await t.approved();
    turn(p.id);
    await t.s.call('POST', `/sessions/${p.id}/finish`, { status: 'completed' });
    expect(t.s.ctx.orchestrator.view(p.id).phase).toBe('stopped');
    const q = t.start().session_id;
    t.status(q, 'running');
    t.status(q, 'failed');
    const retry = await t.s.call('POST', `/sessions/${q}/retry`);
    expect(retry.status).toBe(400);
    expect(retry.data.error).toMatch(/Write to the orchestrator/);
  });
});

describe('orchestrator: several people', () => {
  it('another user cannot approve, pause or stop it, nor touch its steps', async () => {
    const s = await startMultiUser();
    try {
      await projects(s, as('alice'));
      const res = await s.call<Orchestration>('POST', '/orchestrations', { goal: 'Rework', project_keys: ['AA'] }, as('alice'));
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      const made = res.data;
      const id = made.session_id;
      expect(made.started_by).toBe('alice');
      await s.ctx.sessions.rpc(id, 'set_plan', { plan_md: '', steps: [{ title: 'In AA', project_key: 'AA' }] });
      const [step] = s.ctx.orchestrator.view(id).steps;
      for (const path of [`/orchestrations/${id}/approve`, `/orchestrations/${id}/pause`, `/orchestrations/${id}/stop`, `/orchestration-steps/${step.id}/skip`]) {
        expect((await s.call('POST', path, {}, as('bob'))).status, path).toBe(403);
      }
      expect((await s.call('GET', `/orchestrations/${id}`, undefined, as('bob'))).status).toBe(200);
      expect((await s.call('POST', `/orchestrations/${id}/approve`, {}, as('alice'))).status).toBe(200);
    } finally {
      await s.app.close();
    }
  });
});
