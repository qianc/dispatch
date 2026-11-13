import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER } from './helpers.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

// The orchestrator starts its plan's steps as batches; the server decides whether each may start.
describe('orchestrator: steps', () => {
  let t: Setup;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => t.s.app.close());

  const work = () => t.store.sessions({ kind: 'work' });

  it('start_step starts a batch as the starter, with the orchestration\'s options', async () => {
    const p = await t.approved({ options: { auto_merge: 'github', model: 'sonnet' } });
    const reply = String(await t.rpc(p.id, 'start_step', { step_id: p.first.id }));
    const child = work()[0];
    expect(reply).toBe(`Started session #${child.id} for step 1. End your turn: Dispatch wakes you when it changes.`);
    expect(child).toMatchObject({ kind: 'work', project_key: 'AA', title: 'Token store', started_by: OWNER, orchestrator_id: p.id, item_ids: [p.a.id], initial_prompt: 'Build the store.' });
    expect(child.options).toMatchObject({ auto_merge: 'github', model: 'sonnet' });
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'running', child_session_id: child.id });
    expect(t.store.item(p.a.id)!.status).toBe('in_progress');
    expect(t.events(p.id)).toContain(`system: Step 1 started: session #${child.id}`);
  });

  it('a step waits for the steps before it', async () => {
    const p = await t.approved();
    await expect(t.rpc(p.id, 'start_step', { step_id: p.second.id })).rejects.toThrow('Step 2 waits for step 1 ("Token store"), which is pending.');
    expect(work()).toHaveLength(0);
  });

  it('a step starts once', async () => {
    const p = await t.approved();
    await t.rpc(p.id, 'start_step', { step_id: p.first.id });
    await expect(t.rpc(p.id, 'start_step', { step_id: p.first.id })).rejects.toThrow('Step 1 is already running.');
    expect(work()).toHaveLength(1);
  });

  it('the child limit holds', async () => {
    const p = await t.approved({ max_children: 1 });
    await t.rpc(p.id, 'start_step', { step_id: p.first.id });
    await expect(t.rpc(p.id, 'start_step', { step_id: p.third.id })).rejects.toThrow('1 step is running, which is the limit. Wait for one to finish.');
    expect(work()).toHaveLength(1);
  });

  it('a locked project refuses, the step stays pending, another project\'s step still starts', async () => {
    const a = await t.item('AA', 'One');
    const b = await t.item('BB', 'Two');
    const id = t.start().session_id;
    await t.rpc(id, 'set_plan', { plan_md: '', steps: [{ title: 'In AA', project_key: 'AA', item_keys: [a.key] }, { title: 'In BB', project_key: 'BB', item_keys: [b.key] }] });
    t.s.ctx.orchestrator.approve(id);
    const [inA, inB] = t.s.ctx.orchestrator.view(id).steps;
    await t.s.call('POST', '/projects/BB/disable');
    await expect(t.rpc(id, 'start_step', { step_id: inB.id })).rejects.toThrow(/Project BB is disabled/);
    expect(t.store.step(inB.id)).toMatchObject({ state: 'pending', child_session_id: null });
    await t.rpc(id, 'start_step', { step_id: inA.id });
    expect(work().map((w) => w.project_key)).toEqual(['AA']);
  });

  it('items on hold are left out; a step whose items are all held is refused', async () => {
    const p = await t.approved();
    const extra = await t.item('AA', 'Held one', 'hold');
    await t.rpc(p.id, 'set_plan', { plan_md: '', steps: [
      { id: p.first.id, title: 'Token store', project_key: 'AA', item_keys: [p.a.key, extra.key] },
      { title: 'Only held', project_key: 'AA', item_keys: [extra.key] },
    ] });
    t.s.ctx.orchestrator.approve(p.id);
    const [first, onlyHeld] = t.s.ctx.orchestrator.view(p.id).steps;
    await expect(t.rpc(p.id, 'start_step', { step_id: onlyHeld.id })).rejects.toThrow(`Nothing left to start: ${extra.key} is on hold.`);
    await t.rpc(p.id, 'start_step', { step_id: first.id });
    expect(work()[0].item_ids).toEqual([p.a.id]);
    expect(t.store.item(extra.id)!.status).toBe('hold');
  });

  it('update_step: a skipped step lets its dependants start; done is refused while a PR is open', async () => {
    const p = await t.approved();
    await expect(t.rpc(p.id, 'update_step', { step_id: p.first.id, state: 'done' })).rejects.toThrow('Step 1 is pending: only a step that ran can be done.');
    expect(await t.rpc(p.id, 'update_step', { step_id: p.first.id, state: 'skipped', note: 'Not needed.' })).toMatchObject({ state: 'skipped', note: 'Not needed.' });
    const child = await t.startStep(p.id, p.second.id);
    t.status(child, 'running');
    await expect(t.rpc(p.id, 'update_step', { step_id: p.second.id, state: 'done' })).rejects.toThrow(`Step 2 is still working in session #${child}.`);
    t.status(child, 'idle');
    t.pr(child, 'open');
    await expect(t.rpc(p.id, 'update_step', { step_id: p.second.id, state: 'done' })).rejects.toThrow('Step 2 has an open PR: it is done when that merges.');
    await expect(t.rpc(p.id, 'update_step', { step_id: p.second.id, state: 'skipped' })).rejects.toThrow(/only a pending step can be skipped/);
  });

  it('get_session shows a child with its PRs, and refuses a session that is not a child', async () => {
    const p = await t.approved();
    const child = await t.startStep(p.id, p.first.id);
    t.pr(child, 'open');
    expect(await t.rpc(p.id, 'get_session', { session_id: child })).toMatchObject({
      id: child, title: 'Token store', step_id: p.first.id, prs: [{ repo: 'me/aa', state: 'open' }],
    });
    const other = (await t.s.call('POST', '/projects/AA/batches', { item_ids: [], new_items: [], prompt: 'something else' })).data as { id: number };
    await expect(t.rpc(p.id, 'get_session', { session_id: other.id })).rejects.toThrow(`Session #${other.id} is not a step of this orchestration.`);
  });

  it('finish is refused while a step runs; with all steps settled it completes the session', async () => {
    const p = await t.approved();
    await t.startStep(p.id, p.first.id);
    await expect(t.rpc(p.id, 'finish', { result: 'x' })).rejects.toThrow('Step 1 is still running: finish when every step is done, failed or skipped.');
    for (const st of [p.first, p.second, p.third]) t.store.updateStep(st.id, { state: 'done' });
    await t.rpc(p.id, 'finish', { result: 'Tokens are in. Both projects use them.' });
    expect(t.s.ctx.orchestrator.view(p.id).phase).toBe('done');
    expect(t.store.session(p.id)).toMatchObject({ status: 'completed', last_text: 'Tokens are in. Both projects use them.' });
    expect(t.pushes.map((x) => x.title)).toContain('Rework auth: finished');
  });

  it('not approved: start_step is refused', async () => {
    const a = await t.item('AA', 'One');
    const id = t.start().session_id;
    await t.rpc(id, 'set_plan', { plan_md: '', steps: [{ title: 'In AA', project_key: 'AA', item_keys: [a.key] }] });
    const [step] = t.s.ctx.orchestrator.view(id).steps;
    await expect(t.rpc(id, 'start_step', { step_id: step.id })).rejects.toThrow('The owner has not approved the plan yet.');
    await expect(t.rpc(id, 'start_step', { step_id: 9999 })).rejects.toThrow('No step 9999 in this plan.');
  });
});
