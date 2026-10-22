import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './helpers.ts';

// DISP-2: a proposal card made earlier must not re-open or re-run items closed or started elsewhere since.
describe('starting a proposal whose items moved on', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'STL', name: 'Stale' });
    await s.call('POST', '/projects/STL/repos', { github_owner: 'me', github_name: 'stl' }).catch(() => undefined);
  });
  afterAll(() => s.app.close());

  const planner = () => s.ctx.store.createSession({ project_id: s.ctx.store.projectByKey('STL')!.id, kind: 'planner', title: 'Plan', status: 'idle', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [] });
  const item = async (title: string) => (await s.call('POST', '/projects/STL/items', { title })).data as { id: number; key: string };
  const card = async (sessionId: number, item_ids: number[]) => {
    await s.ctx.sessions.rpc(sessionId, 'propose', { type: 'batch', title: 'Batch', item_ids });
    const ev = (await s.call('GET', `/sessions/${sessionId}`)).data.events as { id: number; body: { kind: string } }[];
    return ev.filter((e) => e.body.kind === 'proposal').at(-1)!.id;
  };
  const note = async (sessionId: number, eventId: number) => {
    const ev = (await s.call('GET', `/sessions/${sessionId}`)).data.events as { body: { kind: string; event_id?: number; note?: string } }[];
    return ev.find((e) => e.body.kind === 'proposal_done' && e.body.event_id === eventId)?.body.note ?? null;
  };

  it('drops done, canceled and busy items and leaves them as they are', async () => {
    const [open, done, canceled, busy] = await Promise.all(['Still open', 'Closed meanwhile', 'Dropped meanwhile', 'Taken meanwhile'].map(item));
    const p = planner();
    const ev = await card(p.id, [open.id, done.id, canceled.id, busy.id]);
    // meanwhile, other sessions moved on
    s.ctx.store.updateItem(done.id, { status: 'done' });
    s.ctx.store.updateItem(canceled.id, { status: 'canceled' });
    s.ctx.sessions.startBatch(s.ctx.store.projectByKey('STL')!, { item_ids: [busy.id], new_items: [], prompt: '' });

    const res = await s.call('POST', '/projects/STL/batches', { title: 'Batch', item_ids: [open.id, done.id, canceled.id, busy.id], prompt: '', proposal: { session_id: p.id, event_id: ev } });
    expect(res.status).toBe(200);
    expect(res.data.item_ids).toEqual([open.id]);
    expect(s.ctx.store.item(done.id)!.status).toBe('done');
    expect(s.ctx.store.item(canceled.id)!.status).toBe('canceled');
    expect(await note(p.id, ev)).toMatch(new RegExp(`^Started session #\\d+ \\(left out ${done.key}, ${canceled.key}, ${busy.key}: closed or in progress elsewhere\\)$`));
  });

  it('refuses to start an empty batch when every item is gone; the card stays open', async () => {
    const gone = await item('Closed meanwhile too');
    const p = planner();
    const ev = await card(p.id, [gone.id]);
    s.ctx.store.updateItem(gone.id, { status: 'done' });
    const before = s.ctx.store.sessions({ kind: 'work' }).length;
    const res = await s.call('POST', '/projects/STL/batches', { title: 'Batch', item_ids: [gone.id], prompt: 'do it', proposal: { session_id: p.id, event_id: ev } });
    expect(res.status).toBe(409);
    expect(res.data.error).toMatch(/already closed or in progress/);
    expect(s.ctx.store.sessions({ kind: 'work' }).length).toBe(before);
    expect(s.ctx.store.item(gone.id)!.status).toBe('done');
  });
});
