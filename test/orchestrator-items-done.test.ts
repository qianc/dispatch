import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orchestratorPrompt } from '../src/worker/prompts.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

// DISP-98: the orchestrator closes the items of its own finished steps, so the owner is asked only
// for what needs a review or a decision.
describe('orchestrator: its own items done', () => {
  let t: Setup;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => t.s.app.close());

  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  /** step 1 ran and merged; step 3 (independent) still runs */
  const firstMerged = async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    const other = await t.startStep(p.id, p.third.id);
    t.status(other, 'running');
    turn(child);
    t.pr(child, 'merged');
    expect(t.store.step(p.first.id)!.state).toBe('done');
    return { ...p, child, other };
  };

  it('sets an item of a finished step to done, with a comment that says what completed it, and no push', async () => {
    const p = await firstMerged();
    expect(t.store.item(p.a.id)!.status).toBe('in_progress');
    t.pushes.length = 0;
    t.status(p.id, 'running');
    expect(await t.rpc(p.id, 'update_item', { key: p.a.key, status: 'done', comment: 'The store is in and its tests pass.' })).toMatchObject({ key: p.a.key, status: 'done' });
    t.status(p.id, 'idle');
    expect(t.store.item(p.a.id)!.status).toBe('done');
    expect(t.store.comments(p.a.id).at(-1)).toMatchObject({
      author: 'claude',
      body_md: `Set to done by the orchestrator "Rework auth" after step 1 "Token store" (session #${p.child}, me/aa#${100 + p.child} merged).\n\nThe store is in and its tests pass.`,
    });
    expect(t.events(p.id)).toContain(`system: Updated ${p.a.key}: status, comment`);
    // a routine completion is nothing for the owner
    expect(t.pushes).toEqual([]);
  });

  it('records the step on the item also when the orchestrator gives no comment', async () => {
    const p = await firstMerged();
    await t.rpc(p.id, 'update_item', { key: p.a.key, status: 'done' });
    expect(t.store.comments(p.a.id).at(-1)!.body_md).toBe(`Set to done by the orchestrator "Rework auth" after step 1 "Token store" (session #${p.child}, me/aa#${100 + p.child} merged).`);
  });

  it('an item that needs the owner goes to in review or hold instead', async () => {
    const p = await firstMerged();
    await t.rpc(p.id, 'update_item', { key: p.a.key, status: 'in_review', comment: 'Check the key length.' });
    expect(t.store.item(p.a.id)!.status).toBe('in_review');
    expect(t.store.comments(p.a.id).at(-1)!.body_md).toMatch(/^Set to in review by the orchestrator .*\n\nCheck the key length\.$/);
    await t.rpc(p.id, 'update_item', { key: p.a.key, status: 'hold', comment: 'Your decision.' });
    expect(t.store.item(p.a.id)!.status).toBe('hold');
    // nothing off hold, also not to done
    await expect(t.rpc(p.id, 'update_item', { key: p.a.key, status: 'done' })).rejects.toThrow(/on hold/);
  });

  it('closes the item of a step it closed itself, with nothing merged', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    turn(child);
    await t.rpc(p.id, 'update_step', { step_id: p.first.id, state: 'done', note: 'nothing to merge' });
    await t.rpc(p.id, 'update_item', { key: p.a.key, status: 'done', comment: 'Already in place.' });
    expect(t.store.item(p.a.id)!.status).toBe('done');
    expect(t.store.comments(p.a.id).at(-1)!.body_md).toContain(`after step 1 "Token store" (session #${child}).`);
  });

  it('refuses an item outside its plan', async () => {
    const p = await firstMerged();
    const loose = await t.item('AA', 'Not in the plan', 'todo');
    await expect(t.rpc(p.id, 'update_item', { key: loose.key, status: 'done' })).rejects.toThrow(`${loose.key} is not an item of a step in your plan: you set only the items of your own steps to done.`);
    await expect(t.rpc(p.id, 'update_item', { key: loose.key, status: 'in_review' })).rejects.toThrow(/not an item of a step in your plan/);
    const outside = await t.item('CC', 'Another project', 'todo');
    await expect(t.rpc(p.id, 'update_item', { key: outside.key, status: 'done' })).rejects.toThrow(/not in this orchestration's scope/);
    expect(t.store.item(loose.id)!.status).toBe('todo');
    // the other limits stay as they were
    expect(await t.rpc(p.id, 'update_item', { key: loose.key, status: 'backlog' })).toMatchObject({ status: 'backlog' });
  });

  it('refuses an item of a step that still runs, has not started, or was only skipped', async () => {
    const p = await firstMerged();
    await expect(t.rpc(p.id, 'update_item', { key: p.d.key, status: 'done' })).rejects.toThrow(`Step 3 ("Docs") with ${p.d.key} is running: set the item to done when that step is done.`);
    await expect(t.rpc(p.id, 'update_item', { key: p.d.key, status: 'todo' })).rejects.toThrow(/is in progress: an orchestrator does not change the status/);
    await expect(t.rpc(p.id, 'update_item', { key: p.b.key, status: 'done' })).rejects.toThrow(/Step 2 \("Use the tokens"\) .* is pending/);
    await t.s.call('POST', `/orchestration-steps/${p.second.id}/skip`);
    await expect(t.rpc(p.id, 'update_item', { key: p.b.key, status: 'done' })).rejects.toThrow(`No step with ${p.b.key} has run`);
    expect(t.store.item(p.d.id)!.status).toBe('in_progress');
    expect(t.store.item(p.b.id)!.status).toBe('backlog');
  });

  it('refuses while a session still works on the item or has it in an open pull request', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    turn(child);
    await t.rpc(p.id, 'update_step', { step_id: p.first.id, state: 'done' });
    t.status(child, 'running'); // the owner wrote to it again
    await expect(t.rpc(p.id, 'update_item', { key: p.a.key, status: 'done' })).rejects.toThrow(`Session #${child} still works on ${p.a.key}.`);
    t.status(child, 'idle');
    t.pr(child, 'open');
    await expect(t.rpc(p.id, 'update_item', { key: p.a.key, status: 'done' })).rejects.toThrow(/has an open pull request/);
    expect(t.store.item(p.a.id)!.status).toBe('in_progress');
  });

  it('never reopens a closed item', async () => {
    const p = await firstMerged();
    await t.rpc(p.id, 'update_item', { key: p.a.key, status: 'done' });
    await expect(t.rpc(p.id, 'update_item', { key: p.a.key, status: 'in_review' })).rejects.toThrow(/is done: an orchestrator does not change the status/);
    t.store.updateItem(p.a.id, { status: 'canceled' });
    await expect(t.rpc(p.id, 'update_item', { key: p.a.key, status: 'done' })).rejects.toThrow(/is canceled/);
  });

  it('a scheduled planner run still closes nothing', async () => {
    const it0 = await t.item('AA', 'Triage me', 'triage');
    const sc = (await t.s.call('POST', '/projects/AA/schedules', { name: 'Nightly', at_time: '02:00', scope_md: 'Triage.' })).data;
    const run = (await t.s.call('POST', `/schedules/${sc.id}/run`)).data;
    await expect(t.s.ctx.sessions.rpc(run.id, 'update_item', { key: it0.key, status: 'done' })).rejects.toThrow('A scheduled run cannot set an item to done (it may set: triage, backlog, todo, hold, canceled).');
    await expect(t.s.ctx.sessions.rpc(run.id, 'update_item', { key: it0.key, status: 'in_review' })).rejects.toThrow(/cannot set an item to in_review/);
    expect(t.store.item(it0.id)!.status).toBe('triage');
  });

  it('its instructions say when it closes an item and when the owner must look', async () => {
    const p = await t.approved();
    const text = orchestratorPrompt(t.s.ctx.sessions.spec(t.store.session(p.id)!, '', null, null));
    expect(text).toContain('set the item to `done` yourself with `update_item`');
    expect(text).toContain('set it to `in_review` or `hold`');
    expect(text).not.toContain('or close one');
  });
});
