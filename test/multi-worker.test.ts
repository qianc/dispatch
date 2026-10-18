import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, waitFor } from './helpers.ts';

type Msg = { t: string; spec?: { session_id: number; prompt: string; resume: string | null }; session_id?: number; text?: string };

/** A hand-driven worker: records what the server sends, sends what the test says. */
async function rawWorker(port: number, token: string, hello: Record<string, unknown> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, { headers: { 'x-worker-token': token } });
  const got: Msg[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', live: [], ...hello }));
  const send = (m: Record<string, unknown>) => ws.send(JSON.stringify(m));
  const starts = () => got.filter((m) => m.t === 'start').map((m) => m.spec!.session_id);
  return { ws, got, send, starts, closed, close: () => ws.close() };
}

describe('several workers on one server', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let b: { id: number; secret: string };
  beforeEach(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'MW', name: 'Multi' });
    await s.call('POST', '/projects/MW/repos', { github_owner: 'me', github_name: 'mw' });
    const made = s.ctx.workers.create('b', 'second worker');
    b = { id: made.worker.id, secret: made.secret };
  });
  afterEach(() => s.app.close());

  it('keeps two workers connected at once', async () => {
    const wa = await rawWorker(s.port, 'test-token');
    const wb = await rawWorker(s.port, b.secret);
    await waitFor(() => s.ctx.hub.connectedIds().length === 2, 'two links');
    expect(s.ctx.hub.isConnected(s.ctx.workers.legacy().id)).toBe(true);
    expect(s.ctx.hub.isConnected(b.id)).toBe(true);
    const list = (await s.call('GET', '/workers')).data.workers;
    expect(list.map((w: { name: string; connected: boolean }) => [w.name, w.connected])).toEqual([['default', true], ['b', true]]);
    expect((await s.call('GET', '/worker')).data).toMatchObject({ connected: true, workers: [{ name: 'default', connected: true }, { name: 'b', connected: true }] });
    wa.close();
    wb.close();
  });

  it('a bad token is refused', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/worker`, { headers: { 'x-worker-token': 'dsw_wrong' } });
    expect(await new Promise((r) => ws.once('close', (code) => r(code)))).toBe(4001);
  });

  it("a session on worker b goes only to b, and its events from another worker are ignored", async () => {
    s.ctx.workers.setDefault(b.id);
    const wa = await rawWorker(s.port, 'test-token');
    const job = (await s.call('POST', '/projects/MW/batches', { prompt: 'for b' })).data;
    expect(job.worker_id).toBe(b.id);
    await new Promise((r) => setTimeout(r, 150));
    expect(wa.starts()).toEqual([]);
    expect((await s.call('GET', `/sessions/${job.id}`)).data.session.status).toBe('queued');

    const wb = await rawWorker(s.port, b.secret);
    await waitFor(() => wb.starts().includes(job.id), 'start on b');
    // worker a pretends to run it: ignored
    wa.send({ t: 'status', session_id: job.id, status: 'failed', error: 'not mine' });
    await new Promise((r) => setTimeout(r, 150));
    expect((await s.call('GET', `/sessions/${job.id}`)).data.session.status).toBe('running');
    wa.close();
    wb.close();
  });

  it("a worker's reconnect does not resume or close another worker's sessions", async () => {
    s.ctx.workers.setDefault(b.id);
    const wb = await rawWorker(s.port, b.secret);
    const job = (await s.call('POST', '/projects/MW/batches', { prompt: 'for b' })).data;
    await waitFor(() => wb.starts().includes(job.id), 'start on b');
    wb.send({ t: 'status', session_id: job.id, status: 'running', sdk_session_id: 'sdk-1' });
    await waitFor(async () => (await s.call('GET', `/sessions/${job.id}`)).data.session.sdk_session_id === 'sdk-1', 'sdk id');

    // worker a (re)connects, running nothing: b's session is not "lost"
    const wa = await rawWorker(s.port, 'test-token');
    await new Promise((r) => setTimeout(r, 200));
    expect(wa.starts()).toEqual([]);
    expect(wb.got.filter((m) => m.t === 'close')).toEqual([]);
    expect(wb.starts()).toEqual([job.id]);
    const events = (await s.call('GET', `/sessions/${job.id}`)).data.events.map((e: { body: { text?: string } }) => e.body.text);
    expect(events).not.toContain('Worker restarted — session resumed.');
    wa.close();
    wb.close();
  });

  it('revoking a worker closes its link at once', async () => {
    const wb = await rawWorker(s.port, b.secret);
    await waitFor(() => s.ctx.hub.isConnected(b.id), 'b online');
    expect((await s.call('DELETE', `/workers/${b.id}`)).status).toBe(200);
    expect(await wb.closed).toBe(4001);
    expect(s.ctx.hub.isConnected(b.id)).toBe(false);
  });
});

describe('the queue with workers that come and go', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let b: { id: number; secret: string };
  const get = async (id: number) => (await s.call('GET', `/sessions/${id}`)).data.session;
  beforeEach(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'QW', name: 'Queue' });
    await s.call('POST', '/projects/QW/repos', { github_owner: 'me', github_name: 'qw' });
    const made = s.ctx.workers.create('b', '');
    b = { id: made.worker.id, secret: made.secret };
  });
  afterEach(() => s.app.close());

  it('a session for an absent worker waits with the reason and one notice; others start meanwhile', async () => {
    const wa = await rawWorker(s.port, 'test-token');
    s.ctx.workers.setDefault(b.id);
    const forB = (await s.call('POST', '/projects/QW/batches', { prompt: 'for b' })).data;
    s.ctx.workers.setDefault(s.ctx.workers.legacy().id);
    const forA = (await s.call('POST', '/projects/QW/batches', { prompt: 'for a' })).data;
    await waitFor(() => wa.starts().includes(forA.id), 'a starts its own');
    expect(await get(forB.id)).toMatchObject({ status: 'queued', waiting_reason: 'Waiting for worker b' });
    s.ctx.sessions.dispatch();
    s.ctx.sessions.dispatch();
    expect(s.ctx.notifier.sent.filter((n) => n.tag === `worker-wait-${forB.id}`)).toHaveLength(1);
    const wb = await rawWorker(s.port, b.secret);
    await waitFor(() => wb.starts().includes(forB.id), 'b starts when it connects');
    expect((await get(forB.id)).waiting_reason).toBeNull();
    wa.close();
    wb.close();
  });

  it('a paused session does not start when its worker comes; resumed, it does', async () => {
    s.ctx.workers.setDefault(b.id);
    const job = (await s.call('POST', '/projects/QW/batches', { prompt: 'later' })).data;
    expect((await s.call('POST', `/sessions/${job.id}/pause`)).status).toBe(200);
    expect(await get(job.id)).toMatchObject({ status: 'queued', paused: true, waiting_reason: 'Paused' });
    const wb = await rawWorker(s.port, b.secret);
    await new Promise((r) => setTimeout(r, 200));
    expect(wb.starts()).toEqual([]);
    expect((await s.call('POST', `/sessions/${job.id}/resume`)).status).toBe(200);
    await waitFor(() => wb.starts().includes(job.id), 'start after resume');
    expect((await s.call('POST', `/sessions/${job.id}/pause`)).status).toBe(400); // only a queued one
    wb.close();
  });

  it('a reply to an idle session waits for its worker, then resumes the conversation with it', async () => {
    s.ctx.workers.setDefault(b.id);
    let wb = await rawWorker(s.port, b.secret);
    const job = (await s.call('POST', '/projects/QW/batches', { prompt: 'first' })).data;
    await waitFor(() => wb.starts().includes(job.id), 'started');
    wb.send({ t: 'status', session_id: job.id, status: 'running', sdk_session_id: 'sdk-9' });
    wb.send({ t: 'status', session_id: job.id, status: 'idle' });
    await waitFor(async () => (await get(job.id)).status === 'idle', 'idle');
    wb.close();
    await waitFor(() => !s.ctx.hub.isConnected(b.id), 'b gone');

    expect((await s.call('POST', `/sessions/${job.id}/messages`, { text: 'and one more thing' })).status).toBe(200);
    expect(await get(job.id)).toMatchObject({ status: 'queued', pending_prompt: 'and one more thing', waiting_reason: 'Waiting for worker b' });

    wb = await rawWorker(s.port, b.secret);
    await waitFor(() => wb.got.some((m) => m.t === 'start'), 'resumed');
    const start = wb.got.find((m) => m.t === 'start')!;
    expect(start.spec).toMatchObject({ session_id: job.id, resume: 'sdk-9', prompt: 'and one more thing' });
    expect(await get(job.id)).toMatchObject({ status: 'running', pending_prompt: null });
    wb.close();
  });

  it('a running session whose worker drops shows that it waits for it, and clears when it is back', async () => {
    s.ctx.workers.setDefault(b.id);
    let wb = await rawWorker(s.port, b.secret);
    const job = (await s.call('POST', '/projects/QW/batches', { prompt: 'long' })).data;
    await waitFor(() => wb.starts().includes(job.id), 'started');
    wb.close();
    await waitFor(async () => (await get(job.id)).waiting_reason === 'Waiting for worker b', 'reason shown');
    expect((await get(job.id)).status).toBe('running');
    wb = await rawWorker(s.port, b.secret, { live: [job.id] }); // it kept running over there
    await waitFor(async () => (await get(job.id)).waiting_reason === null, 'reason cleared');
    expect(wb.starts()).toEqual([]);
    wb.close();
  });

  it('a new chat for an absent worker is queued, not refused', async () => {
    const item = (await s.call('POST', '/projects/QW/items', { title: 'Talk about it' })).data;
    s.ctx.workers.setDefault(b.id);
    const r = await s.call('POST', `/items/${item.id}/discuss`, { text: 'hello?' });
    expect(r.status).toBe(200);
    expect(await get(r.data.id)).toMatchObject({ status: 'queued', waiting_reason: 'Waiting for worker b' });
    const wb = await rawWorker(s.port, b.secret);
    await waitFor(() => wb.starts().includes(r.data.id), 'chat starts');
    wb.close();
  });

  it('a busy worker: no start while it has no free slot; a refused start waits and starts once', async () => {
    s.ctx.workers.setDefault(b.id);
    const facts = (free: number) => ({ facts: { os: 'linux', hostname: 'h', slots: 1, free_slots: free, claude_accounts: [], github_accounts: [], local_repo_dirs: [] } });
    const wb = await rawWorker(s.port, b.secret, facts(0));
    const job = (await s.call('POST', '/projects/QW/batches', { prompt: 'x' })).data;
    await new Promise((r) => setTimeout(r, 150));
    expect(wb.starts()).toEqual([]);
    expect((await get(job.id)).waiting_reason).toBe('Waiting for worker b (busy)');
    wb.send({ t: 'slots', free: 1 });
    await waitFor(() => wb.starts().length === 1, 'started');
    // it raced another server for that slot and lost: the start comes back
    wb.send({ t: 'refused', session_id: job.id, reason: 'busy' });
    await waitFor(async () => (await get(job.id)).status === 'queued', 'queued again');
    expect((await get(job.id)).waiting_reason).toBe('Waiting for worker b (busy)');
    wb.send({ t: 'slots', free: 0 });
    await new Promise((r) => setTimeout(r, 100));
    expect(wb.starts()).toHaveLength(1);
    wb.send({ t: 'slots', free: 1 });
    await waitFor(() => wb.starts().length === 2, 'started again');
    await new Promise((r) => setTimeout(r, 150));
    expect(wb.starts()).toHaveLength(2);
    wb.close();
  });
});
