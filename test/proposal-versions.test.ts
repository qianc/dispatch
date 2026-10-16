import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './helpers.ts';

const items = (title: string) => ({ type: 'items', source_id: null, items: [{ type: 'backlog', title, body_md: '', importance: 2, effort: null }] });

describe('proposal cards that were revised', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'VER', name: 'Versions' });
  });
  afterAll(() => s.app.close());

  const planner = () => s.ctx.store.createSession({ project_id: s.ctx.store.projectByKey('VER')!.id, kind: 'planner', title: 'Plan', status: 'idle', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [] });
  const state = async (id: number) => {
    const ev = (await s.call('GET', `/sessions/${id}`)).data.events as { id: number; body: { kind: string; event_id?: number; note?: string; proposal?: { items: { title: string }[] } } }[];
    const done = new Map(ev.filter((e) => e.body.kind === 'proposal_done').map((e) => [e.body.event_id, e.body.note]));
    return ev.filter((e) => e.body.kind === 'proposal').map((e) => ({ id: e.id, title: e.body.proposal!.items[0].title, done: done.get(e.id) ?? null }));
  };

  it('a proposal from a later turn replaces the open ones; cards from one turn stay side by side', async () => {
    const p = planner();
    s.ctx.store.addEvent(p.id, { kind: 'user', text: 'plan it' });
    await s.ctx.sessions.rpc(p.id, 'propose', items('First take'));
    s.ctx.store.addEvent(p.id, { kind: 'user', text: 'change it: smaller' });
    await s.ctx.sessions.rpc(p.id, 'propose', items('Smaller A'));
    await s.ctx.sessions.rpc(p.id, 'propose', items('Smaller B')); // same turn
    expect(await state(p.id)).toEqual([
      expect.objectContaining({ title: 'First take', done: 'Replaced by a newer proposal below' }),
      expect.objectContaining({ title: 'Smaller A', done: null }),
      expect.objectContaining({ title: 'Smaller B', done: null }),
    ]);
    const first = (await state(p.id))[0];
    expect((await s.call('POST', `/sessions/${p.id}/accept-items`, { items: items('x').items, event_id: first.id })).status).toBe(409);
  });

  it('accepting a card closes open cards from earlier turns (chats from before this rule)', async () => {
    const p = planner();
    s.ctx.store.addEvent(p.id, { kind: 'user', text: 'plan it' });
    const old = s.ctx.store.addEvent(p.id, { kind: 'proposal', proposal: items('Old take') as never });
    s.ctx.store.addEvent(p.id, { kind: 'user', text: 'revise' });
    const now = s.ctx.store.addEvent(p.id, { kind: 'proposal', proposal: items('Revised') as never });
    expect((await s.call('POST', `/sessions/${p.id}/accept-items`, { items: items('Revised').items, event_id: now.id })).status).toBe(200);
    const st = await state(p.id);
    expect(st.find((c) => c.id === old.id)!.done).toBe('Not used: a later version was started');
    expect(st.find((c) => c.id === now.id)!.done).toMatch(/^Created VER-\d+$/);
  });
});
