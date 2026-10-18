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
