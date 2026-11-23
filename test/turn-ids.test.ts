// DISP-202, DISP-203: the server names each start and send (turn_id); the worker names in each
// status the last one it got (ack), and in its hello per live session. An idle of the turn before
// a message on its way is no turn end, and a message lost on a half-open link is sent again.
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, waitFor, OWNER } from './helpers.ts';

type Msg = { t: string; session_id?: number; text?: string; turn_id?: string; spec?: { session_id: number } };

/** A worker on a raw socket: `deaf` drops what the server writes, as a half-open link does. */
async function rawWorker(port: number, token: string, hello: Record<string, unknown> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, { headers: { 'x-worker-token': token } });
  const got: Msg[] = [];
  const w = { got, deaf: false, send: (m: object) => ws.send(JSON.stringify(m)), close: () => ws.close(), of: (t: string) => got.filter((m) => m.t === t) };
  ws.on('message', (d) => !w.deaf && got.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', live: [], ...hello }));
  return w;
}

describe('turn ids between server and worker (DISP-202, DISP-203)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let b: { id: number; secret: string };
  const get = async (id: number) => (await s.call('GET', `/sessions/${id}`)).data.session;
  const events = async (id: number) => (await s.call('GET', `/sessions/${id}`)).data.events as { body: { kind: string; text?: string } }[];
  beforeEach(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'TI', name: 'Turns' });
    await s.call('POST', '/projects/TI/repos', { github_owner: 'me', github_name: 'ti' });
    const made = s.ctx.workers.create('b', '', OWNER);
    b = { id: made.worker.id, secret: made.secret };
    s.ctx.workers.setDefault(b.id);
  });
  afterEach(() => s.app.close());

  /** A session whose first turn ran; `idle`: and ended. Returns the worker and the start's turn id. */
  const firstTurn = async (idle: boolean) => {
    const wb = await rawWorker(s.port, b.secret);
    const job = (await s.call('POST', '/projects/TI/batches', { prompt: 'x' })).data as { id: number };
    await waitFor(() => wb.of('start').length === 1, 'started');
    const t1 = wb.of('start')[0].turn_id!;
    expect(t1).toBeTruthy();
    wb.send({ t: 'status', session_id: job.id, status: 'running', sdk_session_id: 'sdk-1', ack: t1 });
    await waitFor(async () => (await get(job.id)).sdk_session_id === 'sdk-1', 'running');
    if (idle) {
      wb.send({ t: 'status', session_id: job.id, status: 'idle', ack: t1 });
      await waitFor(async () => (await get(job.id)).status === 'idle', 'idle');
    }
    return { wb, job, t1 };
  };

  it('a message sent while the worker\'s idle is on its way leaves the session running (DISP-202)', async () => {
    const { wb, job, t1 } = await firstTurn(false);
    // the worker ended the turn; before its idle arrives the owner writes
    expect((await s.call('POST', `/sessions/${job.id}/messages`, { text: 'one more thing' })).status).toBe(200);
    await waitFor(() => wb.of('send').length === 1, 'send');
    const t2 = wb.of('send')[0].turn_id!;
    expect(t2).not.toBe(t1);
    wb.send({ t: 'status', session_id: job.id, status: 'idle', ack: t1 }); // the end of the turn before
    wb.send({ t: 'event', session_id: job.id, body: { kind: 'system', text: 'marker' } });
    await waitFor(async () => (await events(job.id)).some((e) => e.body.text === 'marker'), 'idle handled');
    expect(await get(job.id)).toMatchObject({ status: 'running', waiting_reason: null });
    // the runner got the message and says it runs; that turn's end is the turn end
    wb.send({ t: 'status', session_id: job.id, status: 'running', ack: t2 });
    wb.send({ t: 'status', session_id: job.id, status: 'idle', ack: t2 });
    await waitFor(async () => (await get(job.id)).status === 'idle', 'idle');
    expect((await get(job.id)).waiting_reason).toBe('Turn finished');
    wb.close();
  });

  it('a worker without turn ids: the running it sends after the idle wins (DISP-202)', async () => {
    const { wb, job } = await firstTurn(false);
    expect((await s.call('POST', `/sessions/${job.id}/messages`, { text: 'one more thing' })).status).toBe(200);
    await waitFor(() => wb.of('send').length === 1, 'send');
    wb.send({ t: 'status', session_id: job.id, status: 'idle' });
    wb.send({ t: 'status', session_id: job.id, status: 'running' });
    wb.send({ t: 'event', session_id: job.id, body: { kind: 'system', text: 'marker' } });
    await waitFor(async () => (await events(job.id)).some((e) => e.body.text === 'marker'), 'statuses handled');
    expect((await get(job.id)).status).toBe('running');
    wb.close();
  });

  const loseSend = async () => {
    const { wb, job, t1 } = await firstTurn(true);
    wb.deaf = true; // half-open: what the server writes now is lost
    expect((await s.call('POST', `/sessions/${job.id}/messages`, { text: 'please answer this' })).status).toBe(200);
    expect((await get(job.id)).status).toBe('running');
    wb.close();
    await waitFor(() => !s.ctx.hub.isConnected(b.id), 'gone');
    return { job, t1 };
  };

  it('a send lost on a half-open link goes again on reconnect, and the old idle is no turn end (DISP-203)', async () => {
    const { job, t1 } = await loseSend();
    const wb = await rawWorker(s.port, b.secret, {
      live: [job.id], statuses: [{ t: 'status', session_id: job.id, status: 'idle', sdk_session_id: 'sdk-1', ack: t1 }], acks: { [job.id]: t1 },
    });
    await waitFor(() => wb.of('send').length === 1, 'sent again');
    const again = wb.of('send')[0];
    expect(again.text).toContain('please answer this');
    expect(again.turn_id).not.toBe(t1);
    const now = await get(job.id);
    expect(now).toMatchObject({ status: 'running', waiting_reason: null });
    const texts = (await events(job.id)).map((e) => e.body.text ?? '');
    expect(texts.some((t) => t.includes('did not reach worker b') && t.includes('sent it again'))).toBe(true);
    // the turn of the message sent again ends as usual
    wb.send({ t: 'status', session_id: job.id, status: 'running', ack: again.turn_id });
    wb.send({ t: 'status', session_id: job.id, status: 'idle', ack: again.turn_id });
    await waitFor(async () => (await get(job.id)).status === 'idle', 'idle');
    expect((await get(job.id)).waiting_reason).toBe('Turn finished');
    wb.close();
  });

  it('a lost send that cannot go again now: idle, saying the message may not have arrived (DISP-203)', async () => {
    const { job, t1 } = await loseSend();
    s.ctx.sessions.hold = 'Dispatch is updating';
    const wb = await rawWorker(s.port, b.secret, {
      live: [job.id], statuses: [{ t: 'status', session_id: job.id, status: 'idle', sdk_session_id: 'sdk-1', ack: t1 }], acks: { [job.id]: t1 },
    });
    await waitFor(async () => (await get(job.id)).status === 'idle', 'idle');
    expect((await get(job.id)).waiting_reason).toMatch(/may not have arrived/);
    expect((await events(job.id)).some((e) => e.body.kind === 'error' && /may not have reached worker b/.test(e.body.text ?? ''))).toBe(true);
    expect(wb.of('send')).toEqual([]);
    s.ctx.sessions.hold = null;
    wb.close();
  });

  it('a failed of the turn before a message on its way is no end either (finding 64)', async () => {
    const { wb, job, t1 } = await firstTurn(false);
    expect((await s.call('POST', `/sessions/${job.id}/messages`, { text: 'one more thing' })).status).toBe(200);
    await waitFor(() => wb.of('send').length === 1, 'send');
    const t2 = wb.of('send')[0].turn_id!;
    wb.send({ t: 'status', session_id: job.id, status: 'failed', error: 'The Claude process stopped unexpectedly.', ack: t1 });
    wb.send({ t: 'event', session_id: job.id, body: { kind: 'system', text: 'marker' } });
    await waitFor(async () => (await events(job.id)).some((e) => e.body.text === 'marker'), 'failed handled');
    expect(await get(job.id)).toMatchObject({ status: 'running', ended_at: null });
    wb.send({ t: 'status', session_id: job.id, status: 'failed', error: 'it broke', ack: t2 });
    await waitFor(async () => (await get(job.id)).status === 'failed', 'failed');
    wb.close();
  });

  /** A running session whose runner closed over there while the link was down. */
  const closedOver = async (status: Record<string, unknown>) => {
    const { wb: first, job, t1 } = await firstTurn(false);
    first.close();
    await waitFor(() => !s.ctx.hub.isConnected(b.id), 'gone');
    const wb = await rawWorker(s.port, b.secret, { live: [], statuses: [{ t: 'status', session_id: job.id, ack: t1, ...status }], acks: {} });
    await new Promise((r) => setTimeout(r, 200));
    return { wb, job, t1 };
  };

  it('a turn that ended while the link was down is not resumed: its idle is in the hello (finding 65)', async () => {
    const { wb, job } = await closedOver({ status: 'idle' });
    expect(await get(job.id)).toMatchObject({ status: 'idle', waiting_reason: 'Turn finished' });
    expect(wb.of('start')).toEqual([]);
    wb.close();
  });

  it('one whose idle waits in the outbox is not resumed: the idle comes after the hello (finding 65)', async () => {
    const { wb, job, t1 } = await closedOver({ status: 'idle', queued: true });
    expect(wb.of('start')).toEqual([]);
    expect((await get(job.id)).status).toBe('running');
    wb.send({ t: 'event', session_id: job.id, body: { kind: 'assistant', text: 'all done' } });
    wb.send({ t: 'status', session_id: job.id, status: 'idle', ack: t1 });
    await waitFor(async () => (await get(job.id)).status === 'idle', 'idle');
    expect((await get(job.id)).last_text).toBe('all done');
    wb.close();
  });

  it('a closed session whose last status is of an older turn is resumed as before (finding 65)', async () => {
    const { wb, job } = await closedOver({ status: 'idle', ack: 'older-turn' });
    await waitFor(() => wb.of('start').length === 1, 'resumed');
    expect((await get(job.id)).status).toBe('running');
    wb.close();
  });

  it('a send that arrived is not sent again, and its turn\'s idle from the hello ends it', async () => {
    const { wb: first, job, t1 } = await firstTurn(true);
    expect((await s.call('POST', `/sessions/${job.id}/messages`, { text: 'please answer this' })).status).toBe(200);
    await waitFor(() => first.of('send').length === 1, 'send');
    const t2 = first.of('send')[0].turn_id!;
    expect(t2).not.toBe(t1);
    first.close();
    await waitFor(() => !s.ctx.hub.isConnected(b.id), 'gone');
    const wb = await rawWorker(s.port, b.secret, {
      live: [job.id], statuses: [{ t: 'status', session_id: job.id, status: 'idle', sdk_session_id: 'sdk-1', ack: t2 }], acks: { [job.id]: t2 },
    });
    await waitFor(async () => (await get(job.id)).status === 'idle', 'idle');
    expect((await get(job.id)).waiting_reason).toBe('Turn finished');
    expect(wb.of('send')).toEqual([]);
    wb.close();
  });
});
