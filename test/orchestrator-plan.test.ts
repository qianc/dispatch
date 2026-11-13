import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER } from './helpers.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

// An orchestration starts as a chat that writes a plan; nothing runs until the owner approves it.
describe('orchestrator: plan', () => {
  let t: Setup;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => t.s.app.close());

  const twoSteps = (a: string, b: string) => ({
    plan_md: 'First the store, then its use.',
    steps: [
      { title: 'Token store', project_key: 'AA', prompt: 'Build the store.', item_keys: [a] },
      { title: 'Use the tokens', project_key: 'BB', prompt: 'Use it.', item_keys: [b], after: [1] },
    ],
  });

  it('start makes an orchestrator session with no project', () => {
    const o = t.start();
    const session = t.store.session(o.session_id)!;
    expect(session).toMatchObject({ kind: 'orchestrator', project_id: null, title: 'Rework auth', started_by: OWNER });
    expect(session.initial_prompt).toContain('Rework auth');
    expect(o).toMatchObject({ phase: 'plan', plan_approved: false, project_keys: ['AA', 'BB'], max_children: 2, steps: [] });
    const spec = t.s.ctx.sessions.spec(session, '', null, null);
    expect(spec.orchestration).toMatchObject({ goal: 'Rework auth', phase: 'plan', max_children: 2 });
    expect(spec.orchestration!.projects.map((p) => p.key)).toEqual(['AA', 'BB']);
    expect(spec.repos.map((r) => r.github_name).sort()).toEqual(['aa', 'bb']);
  });

  it('start refuses an unknown or locked project', async () => {
    expect(() => t.start({ project_keys: ['AA', 'NOPE'] })).toThrow(/Unknown project NOPE/);
    await t.s.call('POST', '/projects/BB/disable');
    expect(() => t.start()).toThrow(/Project BB is disabled/);
  });

  it('tracker tools stay inside the scope', async () => {
    const a = await t.item('AA', 'Store tokens');
    const c = await t.item('CC', 'Other');
    const held = await t.item('BB', 'Later', 'hold');
    const id = t.start().session_id;
    expect((await t.rpc(id, 'list_projects') as { key: string }[]).map((p) => p.key)).toEqual(['AA', 'BB']);
    expect((await t.rpc(id, 'list_items', { project_key: 'AA' }) as { key: string }[]).map((i) => i.key)).toEqual([a.key]);
    expect(await t.rpc(id, 'get_item', { key: a.key })).toMatchObject({ key: a.key, title: 'Store tokens' });
    await expect(t.rpc(id, 'get_item', { key: c.key })).rejects.toThrow("Project CC is not in this orchestration's scope (AA, BB).");
    await expect(t.rpc(id, 'list_items', { project_key: 'CC' })).rejects.toThrow(/not in this orchestration's scope/);
    const made = await t.rpc(id, 'create_item', { project_key: 'BB', type: 'backlog', title: 'Found gap', body_md: 'x' }) as { key: string };
    expect(made.key).toMatch(/^BB-/);
    await t.rpc(id, 'add_comment', { key: a.key, body: 'Part of the rework.' });
    expect(t.store.comments(a.id).map((x) => x.body_md)).toEqual(['Part of the rework.']);
    await expect(t.rpc(id, 'update_item', { key: held.key, status: 'todo' })).rejects.toThrow(/on hold/);
    expect(await t.rpc(id, 'update_item', { key: a.key, status: 'todo', comment: 'Ready.' })).toMatchObject({ status: 'todo' });
  });

  it('set_plan stores steps and waits for approval', async () => {
    const a = await t.item('AA', 'Store tokens');
    const b = await t.item('BB', 'Use tokens');
    const id = t.start().session_id;
    const reply = String(await t.rpc(id, 'set_plan', twoSteps(a.key, b.key)));
    expect(reply).toMatch(/Approve/);
    const o = t.s.ctx.orchestrator.view(id);
    expect(o).toMatchObject({ phase: 'plan', plan_approved: false, plan_md: 'First the store, then its use.', waiting: 'Plan ready to approve' });
    expect(o.steps.map((x) => [x.position, x.project_key, x.title, x.item_keys, x.state])).toEqual([
      [1, 'AA', 'Token store', [a.key], 'pending'], [2, 'BB', 'Use the tokens', [b.key], 'pending'],
    ]);
    expect(o.steps[1].depends_on).toEqual([o.steps[0].id]);
    expect(t.events(id)).toContain('system: Plan proposed: 2 steps');
  });

  it('set_plan refuses a project out of scope, an unknown item, and a cycle', async () => {
    const a = await t.item('AA', 'Store tokens');
    const id = t.start().session_id;
    const step = (over: Record<string, unknown>) => ({ plan_md: '', steps: [{ title: 'x', project_key: 'AA', item_keys: [], ...over }] });
    await expect(t.rpc(id, 'set_plan', step({ project_key: 'CC' }))).rejects.toThrow(/not in this orchestration's scope/);
    await expect(t.rpc(id, 'set_plan', step({ item_keys: ['AA-99'] }))).rejects.toThrow(/No item AA-99/);
    await expect(t.rpc(id, 'set_plan', step({ project_key: 'BB', item_keys: [a.key] }))).rejects.toThrow(`${a.key} is not in project BB`);
    await expect(t.rpc(id, 'set_plan', step({ after: [1] }))).rejects.toThrow(/cannot come after itself/);
    await expect(t.rpc(id, 'set_plan', step({ after: [4] }))).rejects.toThrow(/no step 4/);
    await expect(t.rpc(id, 'set_plan', { plan_md: '', steps: [{ title: 'x', project_key: 'AA', after: [2] }, { title: 'y', project_key: 'AA', after: [1] }] })).rejects.toThrow(/wait for each other/);
    expect(t.s.ctx.orchestrator.view(id).steps).toEqual([]);
  });

  it('approve moves to run; approving twice is refused', async () => {
    const a = await t.item('AA', 'Store tokens');
    const b = await t.item('BB', 'Use tokens');
    const id = t.start().session_id;
    expect(() => t.s.ctx.orchestrator.approve(id)).toThrow(/no plan to approve/i);
    await t.rpc(id, 'set_plan', twoSteps(a.key, b.key));
    expect(t.s.ctx.orchestrator.approve(id)).toMatchObject({ phase: 'run', plan_approved: true });
    expect(t.events(id)).toContain('system: Plan approved.');
    expect(() => t.s.ctx.orchestrator.approve(id)).toThrow(/already approved/);
  });

  it('set_plan in run goes back to plan and needs a new approval', async () => {
    const a = await t.item('AA', 'Store tokens');
    const b = await t.item('BB', 'Use tokens');
    const id = t.start().session_id;
    await t.rpc(id, 'set_plan', twoSteps(a.key, b.key));
    t.s.ctx.orchestrator.approve(id);
    const [first, second] = t.s.ctx.orchestrator.view(id).steps;
    await t.rpc(id, 'set_plan', { plan_md: 'Changed.', steps: [
      { id: first.id, title: 'Token store', project_key: 'AA', item_keys: [a.key] },
      { id: second.id, title: 'Use the tokens', project_key: 'BB', item_keys: [b.key], after: [1] },
      { title: 'Docs', project_key: 'AA', after: [2] },
    ] });
    const o = t.s.ctx.orchestrator.view(id);
    expect(o).toMatchObject({ phase: 'plan', plan_approved: false });
    expect(o.steps.map((x) => x.id).slice(0, 2)).toEqual([first.id, second.id]);
    expect(t.s.ctx.orchestrator.approve(id).phase).toBe('run');
  });

  it('set_plan cannot drop a step that has a child session, nor move it to another project', async () => {
    const a = await t.item('AA', 'Store tokens');
    const b = await t.item('BB', 'Use tokens');
    const id = t.start().session_id;
    await t.rpc(id, 'set_plan', twoSteps(a.key, b.key));
    const [first] = t.s.ctx.orchestrator.view(id).steps;
    const child = t.store.createSession({
      project_id: first.project_id, kind: 'work', title: 'c', status: 'queued', force_plan: false, branch: null,
      initial_prompt: '', source_id: null, item_ids: [], worker_id: t.store.defaultWorkerId(), started_by: OWNER,
    });
    t.store.updateStep(first.id, { state: 'running', child_session_id: child.id });
    await expect(t.rpc(id, 'set_plan', { plan_md: '', steps: [{ title: 'Only this', project_key: 'BB' }] }))
      .rejects.toThrow(`Step "Token store" already ran as session #${child.id}: keep it in the plan.`);
    await expect(t.rpc(id, 'set_plan', { plan_md: '', steps: [{ id: first.id, title: 'Token store', project_key: 'BB' }] }))
      .rejects.toThrow(/cannot move to another project/);
    await expect(t.rpc(id, 'set_plan', { plan_md: '', steps: [{ id: 9999, title: 'x', project_key: 'AA' }] })).rejects.toThrow(/No step 9999 in this plan/);
    expect(t.s.ctx.orchestrator.view(id).steps).toHaveLength(2);
  });
});
