// DISP-156: a second Move or Retry while the first waits for its worker is refused, so a double tap
// makes one continuation session and one resume turn.
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, waitFor, OWNER } from './helpers.ts';

type Msg = { t: string; cmd?: { c: string }; req_id?: string; session_id?: number };

/** A worker that answers each command after `delayMs`, with `data`. */
async function slowWorker(port: number, token: string, delayMs: number, data: Record<string, unknown>) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, { headers: { 'x-worker-token': token } });
  const got: Msg[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as Msg;
    got.push(m);
    if (m.t === 'cmd') setTimeout(() => ws.send(JSON.stringify({ t: 'cmd_result', req_id: m.req_id, ok: true, data })), delayMs);
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', live: [] }));
  return { got, send: (m: object) => ws.send(JSON.stringify(m)), of: (t: string) => got.filter((m) => m.t === t), close: () => ws.close() };
}

describe('Move and Retry on a double tap (DISP-156)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let b: { id: number; secret: string };
  const get = async (id: number) => (await s.call('GET', `/sessions/${id}`)).data.session;
  beforeEach(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'MR', name: 'Race' });
    await s.call('POST', '/projects/MR/repos', { github_owner: 'me', github_name: 'mr' });
    const made = s.ctx.workers.create('b', '', OWNER);
    b = { id: made.worker.id, secret: made.secret };
    s.ctx.workers.setDefault(b.id);
  });
  afterEach(() => s.app.close());

  it('two Moves in parallel make one continuation session; the second gets 409', async () => {
    const wb = await slowWorker(s.port, b.secret, 300, { ok: true });
    const job = (await s.call('POST', '/projects/MR/batches', { prompt: 'x' })).data;
    await waitFor(() => wb.of('start').length === 1, 'started');
    const to = s.ctx.workers.legacy().id;
    const [one, two] = await Promise.all([
      s.call('POST', `/sessions/${job.id}/move`, { worker_id: to }),
      s.call('POST', `/sessions/${job.id}/move`, { worker_id: to }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect((one.status === 409 ? one : two).data.error).toMatch(/already moving/);
    const all = (s.ctx.store.db.all('SELECT id FROM sessions WHERE moved_from = ?', job.id) as { id: number }[]);
    expect(all).toHaveLength(1);
    expect(wb.of('cmd')).toHaveLength(1);
    expect(wb.of('close')).toHaveLength(1);
    wb.close();
  });

  it('a Move stops, without a new session, when the session changed during the push', async () => {
    const wb = await slowWorker(s.port, b.secret, 300, { ok: true });
    const job = (await s.call('POST', '/projects/MR/batches', { prompt: 'x' })).data;
    await waitFor(() => wb.of('start').length === 1, 'started');
    wb.send({ t: 'status', session_id: job.id, status: 'running', sdk_session_id: 'sdk-m' });
    await waitFor(async () => (await get(job.id)).status === 'running', 'running');
    const moving = s.call('POST', `/sessions/${job.id}/move`, { worker_id: s.ctx.workers.legacy().id });
    await waitFor(() => wb.of('cmd').length === 1, 'push asked');
    wb.send({ t: 'status', session_id: job.id, status: 'idle' });
    const r = await moving;
    expect(r.status).toBe(409);
    expect(s.ctx.store.db.all('SELECT id FROM sessions WHERE moved_from = ?', job.id)).toHaveLength(0);
    expect(wb.of('close')).toHaveLength(0);
    expect((await get(job.id)).status).toBe('idle');
    wb.close();
  });

  /** A short turn sent from another tab while Move or Retry waits for the worker: it runs and ends idle again (DISP-198). */
  const shortTurn = async (wb: Awaited<ReturnType<typeof slowWorker>>, id: number) => {
    await waitFor(() => wb.of('cmd').length === 1, 'worker asked');
    expect((await s.call('POST', `/sessions/${id}/messages`, { text: 'quick one' })).status).toBe(200);
    wb.send({ t: 'status', session_id: id, status: 'running' });
    wb.send({ t: 'status', session_id: id, status: 'idle' });
    await waitFor(async () => (await get(id)).status === 'idle', 'idle again');
  };
  const idleJob = async (wb: Awaited<ReturnType<typeof slowWorker>>) => {
    const job = (await s.call('POST', '/projects/MR/batches', { prompt: 'x' })).data;
    await waitFor(() => wb.of('start').length === 1, 'started');
    wb.send({ t: 'status', session_id: job.id, status: 'running', sdk_session_id: 'sdk-t' });
    wb.send({ t: 'status', session_id: job.id, status: 'idle' });
    await waitFor(async () => (await get(job.id)).status === 'idle', 'idle');
    return job as { id: number };
  };

  it('a Move refuses when a turn ran and ended during the push (DISP-198)', async () => {
    const wb = await slowWorker(s.port, b.secret, 300, { ok: true });
    const job = await idleJob(wb);
    const moving = s.call('POST', `/sessions/${job.id}/move`, { worker_id: s.ctx.workers.legacy().id });
    await shortTurn(wb, job.id);
    const r = await moving;
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/changed while Dispatch was waiting/);
    expect(s.ctx.store.db.all('SELECT id FROM sessions WHERE moved_from = ?', job.id)).toHaveLength(0);
    expect(wb.of('close')).toHaveLength(0);
    wb.close();
  });

  it('a Move of a running session that writes events during the push goes through (DISP-204)', async () => {
    const wb = await slowWorker(s.port, b.secret, 300, { ok: true });
    const job = (await s.call('POST', '/projects/MR/batches', { prompt: 'x' })).data;
    await waitFor(() => wb.of('start').length === 1, 'started');
    wb.send({ t: 'status', session_id: job.id, status: 'running', sdk_session_id: 'sdk-w' });
    await waitFor(async () => (await get(job.id)).status === 'running', 'running');
    const moving = s.call('POST', `/sessions/${job.id}/move`, { worker_id: s.ctx.workers.legacy().id });
    await waitFor(() => wb.of('cmd').length === 1, 'push asked');
    wb.send({ t: 'event', session_id: job.id, body: { kind: 'assistant', text: 'still working' } });
    wb.send({ t: 'event', session_id: job.id, body: { kind: 'tool_use', tool_use_id: 't1', name: 'Bash', summary: 'git commit', input: {} } });
    const r = await moving;
    expect(r.status).toBe(200);
    expect(s.ctx.store.db.all('SELECT id FROM sessions WHERE moved_from = ?', job.id)).toHaveLength(1);
    wb.close();
  });

  it('a plain Move of an idle session still goes through (DISP-198)', async () => {
    const wb = await slowWorker(s.port, b.secret, 50, { ok: true });
    const job = await idleJob(wb);
    const r = await s.call('POST', `/sessions/${job.id}/move`, { worker_id: s.ctx.workers.legacy().id });
    expect(r.status).toBe(200);
    expect(s.ctx.store.db.all('SELECT id FROM sessions WHERE moved_from = ?', job.id)).toHaveLength(1);
    wb.close();
  });

  it('a Retry refuses when a turn ran and ended during the sign-in check, and a plain one goes through (DISP-198)', async () => {
    const wb = await slowWorker(s.port, b.secret, 300, { name: 'default', label: 'Default', kind: 'machine', logged_in: true, config_dir: null });
    const job = await idleJob(wb);
    const retrying = s.call('POST', `/sessions/${job.id}/retry-login`, {});
    await shortTurn(wb, job.id);
    const r = await retrying;
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/changed while Dispatch was waiting/);
    const sends = wb.of('send').length; // the short turn's own
    const again = await s.call('POST', `/sessions/${job.id}/retry-login`, {});
    expect(again.status).toBe(200);
    await waitFor(() => wb.of('send').length === sends + 1, 'resume turn sent');
    wb.close();
  });

  it('two Retries in parallel send one resume turn; the second gets 409', async () => {
    const wb = await slowWorker(s.port, b.secret, 300, { name: 'default', label: 'Default', kind: 'machine', logged_in: true, config_dir: null });
    const job = (await s.call('POST', '/projects/MR/batches', { prompt: 'x' })).data;
    await waitFor(() => wb.of('start').length === 1, 'started');
    wb.send({ t: 'status', session_id: job.id, status: 'running', sdk_session_id: 'sdk-r' });
    wb.send({ t: 'status', session_id: job.id, status: 'idle' });
    await waitFor(async () => (await get(job.id)).status === 'idle', 'idle');
    const [one, two] = await Promise.all([
      s.call('POST', `/sessions/${job.id}/retry-login`, {}),
      s.call('POST', `/sessions/${job.id}/retry-login`, {}),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect((one.status === 409 ? one : two).data.error).toMatch(/already retrying/);
    expect(wb.of('cmd')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(wb.of('send')).toHaveLength(1);
    wb.close();
  });
});
