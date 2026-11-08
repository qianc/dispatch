import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, startMultiUser, waitFor } from './helpers.ts';

/** A hand-driven worker: records the sessions the server starts on it. */
async function rawWorker(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, { headers: { 'x-worker-token': token } });
  const got: { t: string; spec?: { session_id: number } }[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', live: [] }));
  return { starts: () => got.filter((m) => m.t === 'start').map((m) => m.spec!.session_id), close: () => ws.close() };
}

const NO_WORKER = 'You have no worker yet. Add one in Settings → Workers.';

// DISP-63: workers and schedules belong to people, and sessions to whoever started them.
describe('who owns workers, schedules and sessions', () => {
  let s: Awaited<ReturnType<typeof startMultiUser>>;
  let legacy: number;
  beforeEach(async () => {
    s = await startMultiUser();
    await s.call('POST', '/projects', { key: 'OW', name: 'Owned' }, as('alice'));
    await s.call('POST', '/projects/OW/repos', { github_owner: 'me', github_name: 'ow' }, as('alice'));
    legacy = s.ctx.workers.legacy().id;
  });
  afterEach(() => s.app.close());

  const addWorker = async (user: string, name: string) => {
    const r = await s.call('POST', '/workers', { name }, as(user));
    expect(r.status).toBe(200);
    return { id: r.data.worker.id as number, secret: r.data.secret as string };
  };
  const batch = (user: string, body: Record<string, unknown> = {}) => s.call('POST', '/projects/OW/batches', { prompt: 'work', ...body }, as(user));

  it("bob's batches run on bob's worker, and say he started them", async () => {
    const b = await addWorker('bob', 'bobs-laptop');
    const w = await rawWorker(s.port, b.secret);
    const job = (await batch('bob')).data;
    expect(job).toMatchObject({ worker_id: b.id, started_by: 'bob' });
    await waitFor(() => w.starts().includes(job.id), "start on bob's worker");
    const mine = (await batch('alice')).data;
    expect(mine).toMatchObject({ worker_id: legacy, started_by: 'alice' });
    w.close();
  });

  it('someone with no worker of their own cannot start work', async () => {
    const r = await batch('bob');
    expect(r.status).toBe(400);
    expect(r.data.error).toBe(NO_WORKER);
    expect((await s.call('POST', '/projects/OW/planner', { prompt: 'plan', source_id: null }, as('bob'))).data.error).toBe(NO_WORKER);
  });

  it("bob cannot start on, rename, remove or move to alice's worker", async () => {
    const b = await addWorker('bob', 'bobs');
    const byId = await batch('bob', { options: { worker_id: legacy } });
    expect(byId.status).toBe(400);
    expect(byId.data.error).toBe('Worker default is not yours.');
    expect((await batch('bob', { worker: 'default' })).data.error).toBe('Worker default is not yours.');
    expect((await s.call('PATCH', `/workers/${legacy}`, { name: 'mine' }, as('bob'))).status).toBe(403);
    expect((await s.call('DELETE', `/workers/${legacy}`, undefined, as('bob'))).status).toBe(403);
    expect((await s.call('PUT', '/settings/default-worker', { worker_id: legacy }, as('bob'))).status).toBe(403);
    expect((await s.call('PUT', `/repos/${s.ctx.store.repos(s.ctx.store.projectByKey('OW')!.id)[0].id}/placements/${legacy}`, { local_path: '/x' }, as('bob'))).status).toBe(403);
    const job = (await batch('bob')).data;
    const moved = await s.call('POST', `/sessions/${job.id}/move`, { worker_id: legacy }, as('bob'));
    expect(moved.status).toBe(400);
    expect(moved.data.error).toBe('Worker default is not yours.');
    // his own: fine; and alice (the install owner) may remove it
    expect((await s.call('PATCH', `/workers/${b.id}`, { description: 'laptop' }, as('bob'))).status).toBe(200);
    expect((await s.call('PATCH', `/workers/${b.id}`, { description: 'x' }, as('alice'))).status).toBe(403);
    expect((await s.call('DELETE', `/workers/${b.id}`, undefined, as('alice'))).status).toBe(200);
  });

  it('each person sees their own workers; the install owner sees all, with their owner', async () => {
    await addWorker('bob', 'bobs');
    const bob = (await s.call('GET', '/workers', undefined, as('bob'))).data;
    expect(bob.workers.map((w: { name: string; owner: string }) => [w.name, w.owner])).toEqual([['bobs', 'bob']]);
    const alice = (await s.call('GET', '/workers', undefined, as('alice'))).data;
    expect(alice.workers.map((w: { name: string; owner: string }) => [w.name, w.owner])).toEqual([['default', 'alice'], ['bobs', 'bob']]);
    expect((await s.call('GET', '/worker', undefined, as('bob'))).data.workers.map((w: { name: string }) => w.name)).toEqual(['bobs']);
  });

  it("a project's default worker is skipped for someone it does not belong to", async () => {
    expect((await s.call('PATCH', '/projects/OW', { worker_id: legacy }, as('alice'))).status).toBe(200);
    const b = await addWorker('bob', 'bobs');
    expect((await batch('bob')).data.worker_id).toBe(b.id);
    expect((await batch('alice')).data.worker_id).toBe(legacy);
  });

  it('each person has their own default worker', async () => {
    const b1 = await addWorker('bob', 'bob-one');
    const b2 = await addWorker('bob', 'bob-two');
    expect((await batch('bob')).data.worker_id).toBe(b1.id);
    expect((await s.call('PUT', '/settings/default-worker', { worker_id: b2.id }, as('bob'))).data.default_worker_id).toBe(b2.id);
    expect((await batch('bob')).data.worker_id).toBe(b2.id);
    expect((await s.call('GET', '/workers', undefined, as('bob'))).data.default_worker_id).toBe(b2.id);
    expect((await s.call('GET', '/workers', undefined, as('alice'))).data.default_worker_id).toBe(legacy);
    expect((await batch('alice')).data.worker_id).toBe(legacy);
  });

  it('schedules belong to whoever made them; everyone can read them', async () => {
    const b = await addWorker('bob', 'bobs');
    const made = await s.call('POST', '/projects/OW/schedules', { name: 'Nightly', at_time: '02:00' }, as('bob'));
    expect(made.data).toMatchObject({ owner: 'bob' });
    const id = made.data.id;
    expect((await s.call('GET', '/projects/OW/schedules', undefined, as('alice'))).data[0]).toMatchObject({ id, owner: 'bob' });
    // the install owner may switch it off, nothing more
    expect((await s.call('PATCH', `/schedules/${id}`, { name: 'Mine now' }, as('alice'))).status).toBe(403);
    expect((await s.call('PATCH', `/schedules/${id}`, { enabled: false }, as('alice'))).data).toMatchObject({ enabled: false });
    expect((await s.call('PATCH', `/schedules/${id}`, { enabled: true }, as('alice'))).status).toBe(403);
    expect((await s.call('PATCH', `/schedules/${id}`, { enabled: true, name: 'Nightly bugs' }, as('bob'))).data).toMatchObject({ enabled: true, name: 'Nightly bugs' });
    expect((await s.call('POST', `/schedules/${id}/run`, undefined, as('alice'))).status).toBe(403);
    // it runs as bob, on bob's worker; the batch it starts is bob's too
    const run = (await s.call('POST', `/schedules/${id}/run`, undefined, as('bob'))).data;
    expect(run).toMatchObject({ kind: 'planner', started_by: 'bob', worker_id: b.id });
    const reply = String(await s.ctx.sessions.rpc(run.id, 'propose', { type: 'batch', title: 'Fixes', item_ids: [], prompt: 'fix it' }));
    expect(reply).toMatch(/^Started session #\d+/);
    expect(s.ctx.store.sessions({ kind: 'work' })[0]).toMatchObject({ started_by: 'bob', worker_id: b.id });
    // a user-less token cannot make one (it would run as nobody)
    s.ctx.store.db.setSetting('api_token', 'dsp_legacy_token_value_1234567890');
    const legacyToken = await s.call('POST', '/projects/OW/schedules', { name: 'Token', at_time: '03:00' }, { authorization: 'Bearer dsp_legacy_token_value_1234567890' });
    expect(legacyToken.status).toBe(400);
    // the install owner may remove it
    expect((await s.call('DELETE', `/schedules/${id}`, undefined, as('alice'))).status).toBe(200);
  });

  it('a batch from a proposal card, and a moved session, keep who started them', async () => {
    const b1 = await addWorker('bob', 'bob-one');
    const b2 = await addWorker('bob', 'bob-two');
    const plan = (await s.call('POST', '/projects/OW/planner', { prompt: 'plan', source_id: null }, as('bob'))).data;
    s.ctx.store.updateSession(plan.id, { status: 'idle' });
    const card = s.ctx.store.addEvent(plan.id, { kind: 'proposal', proposal: { type: 'batch', title: 'Next', item_ids: [], new_items: [], prompt: 'go', force_plan: false } });
    const job = (await batch('bob', { proposal: { session_id: plan.id, event_id: card.id } })).data;
    expect(job).toMatchObject({ started_by: 'bob', worker_id: b1.id });
    // started (it has a conversation): moving makes a new session, still bob's
    s.ctx.store.updateSession(job.id, { status: 'idle', sdk_session_id: 'sdk-1' });
    const next = (await s.call('POST', `/sessions/${job.id}/move`, { worker_id: b2.id }, as('bob'))).data;
    expect(next).toMatchObject({ moved_from: job.id, started_by: 'bob', worker_id: b2.id });
  });

  it('each person has their own assistant chat', async () => {
    await addWorker('bob', 'bobs');
    const a = (await s.call('POST', '/assistant/messages', { text: 'hello' }, as('alice'))).data;
    const b = (await s.call('POST', '/assistant/messages', { text: 'hello' }, as('bob'))).data;
    expect(a.id).not.toBe(b.id);
    expect(a.started_by).toBe('alice');
    expect(b.started_by).toBe('bob');
    expect((await s.call('GET', '/assistant', undefined, as('alice'))).data.session_id).toBe(a.id);
    expect((await s.call('GET', '/assistant', undefined, as('bob'))).data.session_id).toBe(b.id);
    // bob's "new chat" closes only his
    await s.call('POST', '/assistant/new', undefined, as('bob'));
    expect((await s.call('GET', '/assistant', undefined, as('bob'))).data.session_id).toBeNull();
    expect((await s.call('GET', '/assistant', undefined, as('alice'))).data.session_id).toBe(a.id);
  });

  it("only the install owner's assistant changes projects", async () => {
    await addWorker('bob', 'bobs');
    const chat = (await s.call('POST', '/assistant/messages', { text: 'hello' }, as('bob'))).data;
    await expect(s.ctx.sessions.rpc(chat.id, 'create_project', { name: 'Sneaky' })).rejects.toThrow(/install owner/);
    await expect(s.ctx.sessions.rpc(chat.id, 'update_project', { key: 'OW', name: 'Renamed' })).rejects.toThrow(/install owner/);
    expect(s.ctx.store.projectByKey('OW')!.name).toBe('Owned');
    const mine = (await s.call('POST', '/assistant/messages', { text: 'hello' }, as('alice'))).data;
    await expect(s.ctx.sessions.rpc(mine.id, 'update_project', { key: 'OW', name: 'Renamed' })).resolves.toBeTruthy();
  });

  it('discuss chats are per person too', async () => {
    await addWorker('bob', 'bobs');
    const item = (await s.call('POST', '/projects/OW/items', { title: 'Talk about me' }, as('alice'))).data;
    const a = (await s.call('POST', `/items/${item.id}/discuss`, { text: 'why?' }, as('alice'))).data;
    const b = (await s.call('POST', `/items/${item.id}/discuss`, { text: 'why?' }, as('bob'))).data;
    expect(a.id).not.toBe(b.id);
    expect((await s.call('GET', `/items/${item.id}/discuss`, undefined, as('bob'))).data.session_id).toBe(b.id);
    expect((await s.call('GET', `/items/${item.id}/discuss`, undefined, as('alice'))).data.session_id).toBe(a.id);
  });
});
