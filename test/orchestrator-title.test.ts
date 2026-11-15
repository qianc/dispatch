// DISP-110: a model writes an orchestration's short title once, when it is created. The first
// words of the goal stay when that fails, and a title the owner gave is never replaced.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Orchestration } from '../src/shared/types.ts';
import { cleanTitle, firstWordsTitle } from '../src/shared/orchestrationTitle.ts';
import { waitFor } from './helpers.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

const GOAL = 'Move sign-in to the new tokens in the app and the admin tool, and remove the old cookie path everywhere';

describe('the title a model wrote, made safe', () => {
  it('strips quotes, marks, a label and end punctuation', () => {
    expect(cleanTitle('"Token sign-in migration."')).toBe('Token sign-in migration');
    expect(cleanTitle('**Title:** Token sign-in migration!\n\nIt names the goal.')).toBe('Token sign-in migration');
    expect(cleanTitle("  'Move sign-in to tokens' … ")).toBe('Move sign-in to tokens');
    expect(cleanTitle("Remove the app's old cookies")).toBe("Remove the app's old cookies");
  });
  it('limits the length, at a word', () => {
    const long = cleanTitle('Move the sign-in of the app and of the admin tool to the new tokens and remove cookies')!;
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toBe('Move the sign-in of the app and of the admin tool to the new');
    expect(cleanTitle('x'.repeat(200))).toHaveLength(60);
  });
  it('gives null for nothing usable', () => {
    expect(cleanTitle('')).toBeNull();
    expect(cleanTitle(' "…" \n')).toBeNull();
  });
});

describe('the title of a new orchestration', () => {
  let t: Setup;
  afterEach(() => t.s.app.close());
  type MakeTitle = (s: { id: number }, goal: string, projects: string[]) => Promise<string>;
  /** the model the server asks (in production: a small model on the orchestrator's worker) */
  const model = (fn: MakeTitle) => {
    const spy = vi.fn(fn);
    (t.s.ctx.orchestrator as unknown as { makeTitle: MakeTitle }).makeTitle = spy;
    return spy;
  };
  const titleOf = (id: number) => t.s.ctx.orchestrator.view(id).title;

  it('is short and names the goal, from the goal and the projects, without the owner typing one', async () => {
    t = await setup();
    const asked = model(async () => '"Token sign-in migration."');
    const o = t.start({ goal: GOAL });
    // nothing waits for the model: it starts with the first words
    expect(o.title).toBe(firstWordsTitle(GOAL));
    await waitFor(() => titleOf(o.session_id) === 'Token sign-in migration', 'the generated title');
    expect(t.store.session(o.session_id)!.title).toBe('Token sign-in migration');
    expect(asked).toHaveBeenCalledWith(expect.objectContaining({ id: o.session_id }), GOAL, ['AA (Project AA)', 'BB (Project BB)']);
    // once: not again on its turns or on later changes
    t.status(o.session_id, 'running');
    t.status(o.session_id, 'idle');
    await t.s.call('PATCH', `/orchestrations/${o.session_id}`, { max_children: 3 });
    expect(asked).toHaveBeenCalledTimes(1);
    expect(titleOf(o.session_id)).toBe('Token sign-in migration');
  });

  it('keeps the first words of the goal when the model fails, times out or says nothing', async () => {
    t = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = model(async () => { throw new Error('worker command make_title timed out'); });
    const a = t.start({ goal: GOAL });
    await waitFor(() => failing.mock.results.length === 1 && warn.mock.calls.length > 0, 'the failed call');
    expect(titleOf(a.session_id)).toBe(firstWordsTitle(GOAL));
    const empty = model(async () => ' "" ');
    const b = t.start({ goal: GOAL });
    await waitFor(() => empty.mock.results.length === 1, 'the empty answer');
    await new Promise((r) => setTimeout(r, 20));
    expect(titleOf(b.session_id)).toBe(firstWordsTitle(GOAL));
    warn.mockRestore();
  });

  it('never replaces a title the owner gave: at the start, or edited before the model answered', async () => {
    t = await setup();
    let answer: (title: string) => void = () => undefined;
    const asked = model(() => new Promise<string>((r) => (answer = r)));
    const named = t.start({ goal: GOAL, title: 'Auth rework' });
    expect(asked).not.toHaveBeenCalled();
    expect(named.title).toBe('Auth rework');

    const o = t.start({ goal: GOAL });
    expect(asked).toHaveBeenCalledTimes(1);
    const edited = (await t.s.call<Orchestration>('PATCH', `/orchestrations/${o.session_id}`, { title: 'My tokens project' })).data;
    expect(edited.title).toBe('My tokens project');
    answer('Token sign-in migration');
    await new Promise((r) => setTimeout(r, 20));
    expect(titleOf(o.session_id)).toBe('My tokens project');
    // and it is kept on later updates
    await t.s.call('PATCH', `/orchestrations/${o.session_id}`, { max_children: 1, auto_merge: 'github' });
    expect(titleOf(o.session_id)).toBe('My tokens project');
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('the owner can edit a generated title afterwards', async () => {
    t = await setup();
    model(async () => 'Token sign-in migration');
    const o = t.start({ goal: GOAL });
    await waitFor(() => titleOf(o.session_id) === 'Token sign-in migration', 'the generated title');
    expect((await t.s.call<Orchestration>('PATCH', `/orchestrations/${o.session_id}`, { title: 'Tokens' })).data.title).toBe('Tokens');
    expect((await t.s.call('PATCH', `/orchestrations/${o.session_id}`, { title: ' ' })).status).toBe(400);
  });
});
