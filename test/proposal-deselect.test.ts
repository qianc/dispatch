import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, OWNER } from './helpers.ts';

// DISP-38: an item unticked on a batch card stays out of the session started from it
describe('an item left out on a proposal card', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'DSL', name: 'Deselect' });
    await s.call('POST', '/projects/DSL/repos', { github_owner: 'me', github_name: 'dsl' });
  });
  afterAll(() => s.app.close());

  const card = async (prompt: string) => {
    const p = s.ctx.store.createSession({ started_by: OWNER, worker_id: s.ctx.store.defaultWorkerId(), project_id: s.ctx.store.projectByKey('DSL')!.id, kind: 'planner', title: 'Plan', status: 'idle', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [] });
    const [a, b] = await Promise.all(['Keep me', 'Leave me out'].map(async (title) => (await s.call('POST', '/projects/DSL/items', { title })).data as { id: number; key: string }));
    s.ctx.store.addEvent(p.id, { kind: 'user', text: 'plan it' });
    await s.ctx.sessions.rpc(p.id, 'propose', { type: 'batch', title: 'Two things', item_ids: [a.id, b.id], prompt: prompt.replace('A', a.key).replace('B', b.key) });
    const ev = (await s.call('GET', `/sessions/${p.id}`)).data.events as { id: number; body: { kind: string; event_id?: number; note?: string } }[];
    return { p, a, b, eventId: ev.find((e) => e.body.kind === 'proposal')!.id };
  };

  it('starts only the picked items, tells the session, and keeps the left-out one out of the batch', async () => {
    const { p, a, b, eventId } = await card('Do A, then B.');
    const res = await s.call('POST', '/projects/DSL/batches', { title: 'Two things', item_ids: [a.id], prompt: `Do ${a.key}, then ${b.key}.`, proposal: { session_id: p.id, event_id: eventId } });
    expect(res.status).toBe(200);
    const session = s.ctx.store.session(res.data.id)!;
    expect(session.item_ids).toEqual([a.id]);
    expect(s.ctx.store.itemsByIds([b.id])[0].status).not.toBe('in_progress');
    expect(session.initial_prompt).toMatch(new RegExp(`^The owner left ${b.key} out of this batch\\. Do not work on it`));
    const notes = (await s.call('GET', `/sessions/${p.id}`)).data.events as { body: { kind: string; note?: string } }[];
    expect(notes.find((e) => e.body.kind === 'proposal_done')?.body.note).toBe(`Started session #${session.id} (left out ${b.key})`);

    // the instructions name it, but adding it to the batch is refused until the owner asks
    await expect(s.ctx.sessions.rpc(session.id, 'add_to_batch', { keys: [b.key] })).rejects.toThrow(/left .* out of this batch/);
    expect(s.ctx.store.session(session.id)!.item_ids).toEqual([a.id]);
    s.ctx.store.addEvent(session.id, { kind: 'user', text: `also do ${b.key}` });
    await s.ctx.sessions.rpc(session.id, 'add_to_batch', { keys: [b.key] });
    expect(s.ctx.store.session(session.id)!.item_ids.toSorted()).toEqual([a.id, b.id].toSorted());
  });

  it('a card started as proposed has no left-out line', async () => {
    const { p, a, b, eventId } = await card('Do both.');
    const res = await s.call('POST', '/projects/DSL/batches', { title: 'Two things', item_ids: [a.id, b.id], prompt: 'Do both.', proposal: { session_id: p.id, event_id: eventId } });
    expect(res.status).toBe(200);
    expect(s.ctx.store.session(res.data.id)!.initial_prompt).toBe('Do both.');
  });
});
