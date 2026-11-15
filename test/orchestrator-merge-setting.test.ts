// DISP-109: the merge setting of an orchestration's batches can change while it runs.
import { afterEach, describe, expect, it } from 'vitest';
import type { Orchestration } from '../src/shared/types.ts';
import { mergeHint } from '../web/src/orchestration.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

describe('the merge setting of a running orchestration', () => {
  let t: Setup;
  afterEach(() => t.s.app.close());
  const patch = async (id: number, auto_merge: string) => (await t.s.call<Orchestration>('PATCH', `/orchestrations/${id}`, { auto_merge })).data;
  const mergeOf = (sessionId: number) => t.store.session(sessionId)!.options.auto_merge;

  it('switches from asking every merge to auto-merge and back, from the next merge on', async () => {
    t = await setup();
    const { id, first, third } = await t.approved(); // started with "Leave for review"
    // step 1 is done with its work and waits for the owner's review
    const c1 = await t.startStep(id, first.id);
    t.status(c1, 'running');
    t.pr(c1, 'open');
    t.status(c1, 'idle');
    expect(t.s.ctx.orchestrator.view(id).steps[0]).toMatchObject({ state: 'review', note: "waits for the owner's review" });

    // ask-every-merge -> auto-merge, while it runs
    const auto = await patch(id, 'github');
    expect(auto.options.auto_merge).toBe('github');
    expect(auto.phase).toBe('run');
    expect(t.events(id).join('\n')).toContain('Settings changed by the owner: when a batch is done: it is merged by itself on GitHub when its checks pass.');
    // the merge that already waits for approval keeps waiting
    expect(mergeOf(c1)).toBe('off');
    expect(t.s.ctx.orchestrator.view(id).steps[0]).toMatchObject({ state: 'review', note: "waits for the owner's review" });
    // the next step that starts uses the new value: its change merges by itself
    const c3 = await t.startStep(id, third.id);
    expect(mergeOf(c3)).toBe('github');
    t.status(c3, 'running');
    t.pr(c3, 'open');
    t.status(c3, 'idle');
    expect(t.s.ctx.orchestrator.view(id).steps[2]).toMatchObject({ state: 'running', note: 'checking, then auto-merge' });

    // and back, mid-run: a batch still at work follows; its next merge waits for the owner again
    const back = await patch(id, 'off');
    expect(back.options.auto_merge).toBe('off');
    expect(mergeOf(c3)).toBe('off');
    expect(t.events(c3).join('\n')).toContain("The owner changed the orchestration's setting: its change waits for the owner's review.");
    expect(t.s.ctx.orchestrator.view(id).steps[2]).toMatchObject({ state: 'review', note: "waits for the owner's review" });
    expect(mergeOf(c1)).toBe('off');
  });

  it('a batch that works takes the new value for its merge', async () => {
    t = await setup();
    const { id, first } = await t.approved();
    const c1 = await t.startStep(id, first.id);
    t.status(c1, 'running');
    await patch(id, 'local');
    expect(mergeOf(c1)).toBe('local');
    // the same value again changes nothing and tells nobody
    const before = t.events(id).length;
    await patch(id, 'local');
    expect(t.events(id)).toHaveLength(before);
  });

  it('a closed orchestration refuses the change', async () => {
    t = await setup();
    const { id } = await t.approved();
    t.s.ctx.orchestrator.stopAll(id, false);
    expect((await t.s.call('PATCH', `/orchestrations/${id}`, { auto_merge: 'github' })).status).toBe(409);
  });

  it('the settings say what it uses now and what happens to a merge that already waits', () => {
    const o = { options: { auto_merge: 'off' }, steps: [{ state: 'review' }, { state: 'running' }] } as unknown as Orchestration;
    expect(mergeHint(o, 'off')).toBe('It uses now: each change waits for your review. You can change it while it runs.');
    expect(mergeHint(o, 'github')).toBe('It uses now: each change waits for your review. After Save: each change is merged on GitHub when its checks pass, from the next merge on (steps that start later, and batches still at work). 1 step already waits for your review: it keeps waiting, merge it yourself.');
  });
});
