import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeChange, heldByProposal, minorProblem, type NextStep } from '../src/server/planChange.ts';
import type { MinorChange, OrchestrationStep } from '../src/shared/types.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

// DISP-119: the orchestrator amends its approved plan by itself for a minor change, and asks the
// owner only for a change that matters; while it asks, the steps the change does not touch go on.
describe('orchestrator: changes of the approved plan', () => {
  let t: Setup;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => t.s.app.close());

  /**
   * The picomatch case: step 1 (AA) has a pull request that does not merge because of an npm audit
   * advisory; step 2 (AA) waits for step 1; step 3 (BB, enablement) is independent.
   */
  async function blocked() {
    const a = await t.item('AA', 'Feature');
    const b = await t.item('AA', 'After the feature');
    const e = await t.item('BB', 'Enablement');
    const id = t.start().session_id;
    await t.rpc(id, 'set_plan', { plan_md: 'Feature, then what builds on it; enablement on its own.', steps: [
      { title: 'Feature', project_key: 'AA', prompt: 'Build it.', item_keys: [a.key] },
      { title: 'After the feature', project_key: 'AA', prompt: 'Build on it.', item_keys: [b.key], after: [1] },
      { title: 'Enablement', project_key: 'BB', prompt: 'Enable it.', item_keys: [e.key] },
    ] });
    t.status(id, 'running');
    t.status(id, 'idle');
    t.s.ctx.orchestrator.approve(id);
    const [first, second, third] = t.s.ctx.orchestrator.view(id).steps;
    const child = await t.startStep(id, first.id);
    t.status(child, 'idle');
    const pr40 = t.pr(child, 'open', { blocked: 'npm audit: picomatch advisory' });
    return { id, a, b, e, first, second, third, child, pr40 };
  }

  const keep = (s: OrchestrationStep, after: number[] = []) => ({ id: s.id, title: s.title, project_key: s.project_key, prompt: s.prompt_md, item_keys: s.item_keys, after });
  const fix = (unblocks: number, item: string, extra: Partial<MinorChange> = {}) => ({
    kind: 'fix_blocker', reason: 'PR 40 is blocked by the npm audit advisory on picomatch.', verification: '`npm audit --audit-level=high` passes',
    touches: ['dependency_pins', 'lockfiles'], unblocks, ...extra,
  });

  it('the picomatch fix is added and runs without approval; PR 40 merges, and the independent step runs in parallel', async () => {
    const p = await blocked();
    expect(t.store.step(p.first.id)!.state).toBe('review');
    const fixItem = await t.rpc(p.id, 'create_item', { project_key: 'AA', type: 'bug', title: 'Resolve the picomatch npm audit advisory', body_md: 'Pin picomatch.' }) as { key: string };
    const pushes = t.pushes.length;
    const reply = String(await t.rpc(p.id, 'amend_plan', {
      steps: [
        keep(p.first),
        // the step that waited for step 1 may also wait for its fix; the independent step does not
        keep(p.second, [1, 4]),
        keep(p.third),
        { title: 'Resolve the picomatch advisory', project_key: 'AA', prompt: 'Pin picomatch to a fixed version.', item_keys: [fixItem.key] },
      ],
      change: fix(p.first.id, fixItem.key),
    }));
    let o = t.s.ctx.orchestrator.view(p.id);
    const fixStep = o.steps[3];
    expect(o).toMatchObject({ phase: 'run', plan_approved: true, proposal: null });
    expect(reply).toContain(`Ready to start: ${p.third.id}, ${fixStep.id}`);
    expect(o.changes).toEqual([expect.objectContaining({
      kind: 'fix_blocker', decided_by: 'orchestrator', reason: 'PR 40 is blocked by the npm audit advisory on picomatch.',
      verification: '`npm audit --audit-level=high` passes', step_id: fixStep.id, summary: 'adds step 4 "Resolve the picomatch advisory"; step 2 "After the feature": waits for other steps; touches only dependency pins, lockfiles',
    })]);
    expect(fixStep.prompt_md).toMatch(/^\(Dispatch: the orchestrator added this step without the owner's approval/);
    expect(fixStep.prompt_md).toContain('Change only dependency pins, lockfiles.');
    expect(fixStep.prompt_md).toContain('Pin picomatch to a fixed version.');
    expect(t.events(p.id).some((x) => x.startsWith('system: Plan changed without approval (a step that fixes a blocker)'))).toBe(true);
    // nothing asks the owner
    expect(t.pushes.slice(pushes)).toEqual([]);

    // the fix and the independent step run at the same time
    const fixChild = await t.startStep(p.id, fixStep.id);
    const enable = await t.startStep(p.id, p.third.id);
    expect(t.store.step(fixStep.id)!.state).toBe('running');
    expect(t.store.step(p.third.id)!.state).toBe('running');
    // the fix merges: its verification passed
    t.status(fixChild, 'idle');
    t.pr(fixChild, 'merged');
    expect(t.store.step(fixStep.id)!.state).toBe('done');
    // PR 40 merges after it; the step that waited for both is ready
    t.store.setPrBlocked(p.pr40.id, null);
    t.pr(p.child, 'merged');
    o = t.s.ctx.orchestrator.view(p.id);
    expect(o.steps.map((x) => x.state)).toEqual(['done', 'pending', 'running', 'done']);
    expect(t.s.ctx.orchestrator.readySteps(o).map((x) => x.id)).toEqual([p.second.id]);
    expect(t.store.step(p.third.id)!.child_session_id).toBe(enable);
  });

  it('a fix that would hold the independent step, or touches more than config, needs the owner', async () => {
    const p = await blocked();
    const step = { title: 'Fix', project_key: 'AA', prompt: '' };
    await expect(t.rpc(p.id, 'amend_plan', { steps: [keep(p.first), keep(p.second, [1]), keep(p.third, [4]), step], change: fix(p.first.id, '') }))
      .rejects.toThrow(/needs the owner's approval: step 3 \("Enablement"\) would wait for the new step: .*hold independent work/);
    // no blocked step named: nothing may wait for the fix
    await expect(t.rpc(p.id, 'amend_plan', { steps: [keep(p.first), keep(p.second, [1, 4]), keep(p.third), step], change: fix(p.first.id, '', { unblocks: undefined }) }))
      .rejects.toThrow(/step 2 \("After the feature"\) would wait for the new step/);
    // a new runtime dependency is not something a minor fix can name
    await expect(t.rpc(p.id, 'amend_plan', { steps: [keep(p.first), keep(p.second, [1]), keep(p.third), step], change: fix(p.first.id, '', { touches: ['runtime_dependency' as never] }) }))
      .rejects.toThrow();
    await expect(t.rpc(p.id, 'amend_plan', { steps: [keep(p.first), keep(p.second, [1]), keep(p.third), step], change: fix(p.first.id, '', { verification: '' }) }))
      .rejects.toThrow(/say how the fix is verified/);
    expect(t.s.ctx.orchestrator.view(p.id)).toMatchObject({ changes: [], proposal: null });
    expect(t.s.ctx.orchestrator.view(p.id).steps).toHaveLength(3);
  });

  it('a new architectural step, or a change of model or budget, stops for approval; the steps it does not touch go on', async () => {
    const p = await blocked();
    // not one of the minor kinds: refused, with the rule
    await expect(t.rpc(p.id, 'amend_plan', {
      steps: [keep(p.first), keep(p.second, [1]), keep(p.third), { title: 'New token service', project_key: 'AA', prompt: 'A new service.' }],
      change: { kind: 'reword', reason: 'Needs a service.' },
    })).rejects.toThrow("This change needs the owner's approval: it adds a step. Propose it with set_plan");
    await expect(t.rpc(p.id, 'amend_plan', { steps: [keep(p.first), keep(p.second, [1]), keep(p.third)], change: { kind: 'budget', reason: 'More money.' } })).rejects.toThrow();
    // a change of the model of the enablement step, and a new architectural step after it: proposed
    const reply = String(await t.rpc(p.id, 'set_plan', { plan_md: 'Enable it on the bigger model, then add the service.', steps: [
      keep(p.first), keep(p.second, [1]), { ...keep(p.third), prompt: 'Enable it. Use Opus and raise the budget to $50.' },
      { title: 'New token service', project_key: 'BB', prompt: 'A new service.', after: [3] },
    ] }));
    expect(reply).toContain('Held until you answer: step 3.');
    expect(reply).toContain('Going on now: steps 1 and 2.');
    let o = t.s.ctx.orchestrator.view(p.id);
    expect(o).toMatchObject({ phase: 'run', waiting: 'A change of the plan waits for your approval' });
    expect(o.proposal!.held).toEqual([p.third.id]);
    expect(t.s.ctx.orchestrator.attention(p.id)).toMatchObject({ kind: 'plan', text: expect.stringContaining('Held until you answer: step 3. Going on now: steps 1 and 2.') });
    // the held step does not start; the plan as approved still runs
    await expect(t.rpc(p.id, 'start_step', { step_id: p.third.id })).rejects.toThrow(/held by your change of the plan/);
    expect(t.s.ctx.orchestrator.statusText(o)).toContain('held by your change that waits for the owner');
    // a minor change waits while a change is with the owner
    await expect(t.rpc(p.id, 'amend_plan', { steps: [keep(p.first), keep(p.second, [1]), keep(p.third)], change: { kind: 'reorder', reason: 'x' } }))
      .rejects.toThrow(/waits for the owner's approval/);
    // the turn's end asks the owner once
    t.status(p.id, 'running');
    t.status(p.id, 'idle');
    expect(t.pushes.map((x) => x.title)).toContain('Rework auth: plan change to approve');
    // the owner approves: the plan changes, and the held step may start
    o = (await t.s.call('POST', `/orchestrations/${p.id}/approve`, { plan_version: o.plan_version })).data as typeof o;
    expect(o).toMatchObject({ proposal: null, plan_md: 'Enable it on the bigger model, then add the service.' });
    expect(o.steps.map((x) => x.title)).toEqual(['Feature', 'After the feature', 'Enablement', 'New token service']);
    expect(o.changes.map((c) => [c.kind, c.decided_by])).toEqual([['approved', 'owner']]);
    expect(t.s.ctx.orchestrator.readySteps(o).map((x) => x.id)).toEqual([p.third.id]);
  });

  it('the owner can decline a change: the approved plan stays and its held steps start', async () => {
    const p = await blocked();
    await t.rpc(p.id, 'set_plan', { plan_md: '', steps: [keep(p.first), keep(p.second, [1])] });
    expect(t.s.ctx.orchestrator.view(p.id).proposal!.held).toEqual([p.third.id]);
    const o = (await t.s.call('POST', `/orchestrations/${p.id}/decline`)).data as ReturnType<typeof t.s.ctx.orchestrator.view>;
    expect(o).toMatchObject({ proposal: null });
    expect(o.steps).toHaveLength(3);
    expect(o.changes.map((c) => c.kind)).toEqual(['declined']);
    expect(t.s.ctx.orchestrator.readySteps(o).map((x) => x.id)).toEqual([p.third.id]);
    expect((await t.s.call('POST', `/orchestrations/${p.id}/decline`)).status).toBe(409);
  });

  it('it may reorder or reword steps that have not started, and retry a failed step once', async () => {
    const p = await blocked();
    await t.rpc(p.id, 'amend_plan', {
      steps: [keep(p.first), { ...keep(p.third), title: 'Turn it on' }, keep(p.second, [1])],
      change: { kind: 'reword', reason: 'Clearer names.' },
    });
    let o = t.s.ctx.orchestrator.view(p.id);
    expect(o.steps.map((x) => x.title)).toEqual(['Feature', 'Turn it on', 'After the feature']);
    expect(o.changes[0]).toMatchObject({ kind: 'reword', summary: 'step 3 "Enablement": renamed to "Turn it on", now at place 2; step 2 "After the feature": now at place 3' });
    // reorder that changes what waits for what is not a reorder
    await expect(t.rpc(p.id, 'amend_plan', { steps: [keep(o.steps[0]), keep(o.steps[1]), keep(o.steps[2])], change: { kind: 'reorder', reason: 'x' } }))
      .rejects.toThrow(/the steps step 3 \("After the feature"\) waits for change/);

    // the batch of step 1 fails; it may run it again once
    t.status(p.child, 'failed');
    expect(t.store.step(p.first.id)!.state).toBe('failed');
    await expect(t.rpc(p.id, 'retry_step', { step_id: p.first.id })).rejects.toThrow(/Say why/);
    t.pr(p.child, 'closed');
    expect(await t.rpc(p.id, 'retry_step', { step_id: p.first.id, reason: 'The worker went away.' })).toMatch(/pending again/);
    const again = await t.startStep(p.id, p.first.id);
    t.status(again, 'failed');
    await expect(t.rpc(p.id, 'retry_step', { step_id: p.first.id, reason: 'Again.' })).rejects.toThrow(/You retried step 1 already/);
    o = t.s.ctx.orchestrator.view(p.id);
    expect(o.changes.map((c) => [c.kind, c.decided_by])).toEqual([['reword', 'orchestrator'], ['retry', 'orchestrator']]);
  });

  it('amend_plan is refused before the first approval', async () => {
    const a = await t.item('AA', 'Feature');
    const id = t.start().session_id;
    await t.rpc(id, 'set_plan', { plan_md: '', steps: [{ title: 'Feature', project_key: 'AA', item_keys: [a.key] }] });
    await expect(t.rpc(id, 'amend_plan', { steps: [{ title: 'Feature', project_key: 'AA' }], change: { kind: 'reword', reason: 'x' } }))
      .rejects.toThrow(/has not approved the plan yet/);
  });
});

describe('planChange rules', () => {
  const step = (id: number, over: Partial<OrchestrationStep> = {}): OrchestrationStep => ({
    id, orchestration_id: 1, position: id, title: `S${id}`, project_id: 1, project_key: 'AA', prompt_md: '', item_ids: [], item_keys: [], depends_on: [],
    state: 'pending', note: null, child_session_id: null, seen: null, deploys: {}, messages_sent: 0, offer: null, offer_messages: null, offered_at: null, optional: false, ...over,
  });
  const next = (s: OrchestrationStep, after: number[] = [], over: Partial<NextStep> = {}): NextStep => ({ id: s.id, title: s.title, project_id: s.project_id, prompt_md: s.prompt_md, item_ids: s.item_ids, after, optional: s.optional, ...over });
  const split = { kind: 'split', reason: 'Too big.' } as const;

  it('a split shares out the items of a step that has not started; what waited for it waits for the parts', () => {
    const old = [step(1), step(2, { item_ids: [10, 11], depends_on: [1] }), step(3, { depends_on: [2] })];
    const part = (items: number[], after: number[]): NextStep => ({ title: 'part', project_id: 1, prompt_md: '', item_ids: items, after, optional: false });
    const ok = [next(old[0]), part([10], [1]), part([11], [1, 2]), next(old[2], [3])];
    expect(minorProblem(old, ok, split)).toBeNull();
    expect(describeChange(old, ok, split)).toBe('split step 2 "S2" into step 2 "part", step 3 "part"; step 3 "S3": waits for other steps, now at place 4');
    expect(minorProblem(old, [next(old[0]), part([10], [1]), part([], [1]), next(old[2], [3])], split)).toMatch(/share out its items/);
    expect(minorProblem(old, [next(old[0]), part([10, 11], [1]), next(old[2], [2])], split)).toMatch(/replaces one step by two or more/);
    const started = old.map((s) => (s.id === 2 ? { ...s, state: 'running' as const } : s));
    expect(minorProblem(started, ok, split)).toMatch(/has started/);
  });

  it('started steps keep their prompt and their order; nothing moves to another project', () => {
    const old = [step(1, { state: 'running' }), step(2, { state: 'done' }), step(3)];
    const reword = { kind: 'reword', reason: 'x' } as const;
    expect(minorProblem(old, [next(old[0], [], { prompt_md: 'new' }), next(old[1]), next(old[2])], reword)).toMatch(/its batch has its prompt already/);
    expect(minorProblem(old, [next(old[1]), next(old[0]), next(old[2])], { kind: 'reorder', reason: 'x' })).toMatch(/steps that have started change their order/);
    expect(minorProblem(old, [next(old[2]), next(old[0]), next(old[1])], { kind: 'reorder', reason: 'x' })).toBeNull();
    expect(minorProblem(old, [next(old[0]), next(old[1]), next(old[2], [], { project_id: 2 })], reword)).toMatch(/moves to another project/);
    expect(minorProblem(old, [next(old[0]), next(old[1]), next(old[2], [], { optional: true })], reword)).toMatch(/becomes optional/);
  });

  it('a fix may only work in a project the plan already works in', () => {
    const old = [step(1)];
    const fixStep: NextStep = { title: 'Fix', project_id: 2, prompt_md: '', item_ids: [], after: [], optional: false };
    const change: MinorChange = { kind: 'fix_blocker', reason: 'x', verification: 'npm audit', touches: ['lockfiles'] };
    expect(minorProblem(old, [next(old[0]), fixStep], change)).toMatch(/a project no step of the plan works in/);
    expect(minorProblem(old, [next(old[0]), { ...fixStep, project_id: 1 }], change)).toBeNull();
  });

  it('a proposal holds the pending steps it changes, and those only', () => {
    const old = [step(1, { state: 'running' }), step(2, { depends_on: [1] }), step(3), step(4)];
    const proposed: NextStep[] = [next(old[0], [], { title: 'renamed' }), next(old[1], [1, 4]), next(old[2]), { title: 'New', project_id: 1, prompt_md: '', item_ids: [], after: [], optional: false }];
    // step 1 runs (nothing to hold), step 2 would wait for the new step, step 3 stays, step 4 goes
    expect(heldByProposal(old, proposed)).toEqual([2, 4]);
  });
});
