// DISP-197: a status written on a half-open worker link is lost. The worker's next hello repeats
// the last status of each live session, and the server handles one it missed.
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerToServer } from '../src/shared/protocol.ts';
import { ServerLink, Slots } from '../src/worker/serverLink.ts';
import { startServer, waitFor, OWNER } from './helpers.ts';

describe('the worker repeats its last statuses in the hello (DISP-197)', () => {
  let wss: WebSocketServer | null = null;
  let link: ServerLink | null = null;
  afterEach(async () => {
    link?.closeAll();
    link = null;
    for (const c of wss?.clients ?? []) c.terminate();
    await new Promise((r) => (wss ? wss.close(r) : r(null)));
    wss = null;
  });

  it('a status lost on a half-open link is in the next hello; one that waited in the outbox is not', async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss!.once('listening', r));
    const hellos: Extract<WorkerToServer, { t: 'hello' }>[] = [];
    wss.on('connection', (ws) => ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as WorkerToServer;
      if (m.t === 'hello') hellos.push(m);
    }));
    const entry = { name: 'home', url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/worker`, token: 't', local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: null, releases: [], repo_env_dir: '/nonexistent' };
    link = new ServerLink(entry, {
      fake: true, opts: { assistantReadDirs: [] } as never, workspacesDir: mkdtempSync(join(tmpdir(), 'dsp-hello-')), slots: new Slots(2),
      claudeAccounts: () => [], githubAccounts: [], gitEnv: () => ({}), remoteBase: 'https://github.com',
    });
    // two live sessions (still being set up, so no runner to fake)
    const starting = (link as unknown as { starting: Map<number, string[]> }).starting;
    starting.set(5, []);
    starting.set(6, []);
    link.connect(50);
    await waitFor(() => hellos.length === 1, 'first hello');
    expect(hellos[0].statuses).toEqual([]);
    link.send({ t: 'status', session_id: 5, status: 'running', sdk_session_id: 'sdk-5' });
    link.send({ t: 'status', session_id: 6, status: 'running', sdk_session_id: 'sdk-6' });
    link.send({ t: 'status', session_id: 5, status: 'idle' }); // written, then lost with the link
    for (const c of wss.clients) c.terminate();
    await waitFor(() => !(link as unknown as { ws: unknown }).ws, 'link down');
    link.send({ t: 'status', session_id: 6, status: 'idle' }); // to the outbox: it goes out after the hello
    await waitFor(() => hellos.length === 2, 'second hello', 5000);
    expect(hellos[1].statuses).toEqual([{ t: 'status', session_id: 5, status: 'idle', sdk_session_id: 'sdk-5' }]);
  }, 10_000);

  it('statuses name the last start or send the worker got, and the hello names it per live session (DISP-202, DISP-203)', async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss!.once('listening', r));
    const got: WorkerToServer[] = [];
    wss.on('connection', (ws) => ws.on('message', (d) => got.push(JSON.parse(String(d)) as WorkerToServer)));
    const entry = { name: 'home', url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/worker`, token: 't', local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: null, releases: [], repo_env_dir: '/nonexistent' };
    link = new ServerLink(entry, {
      fake: true, opts: { assistantReadDirs: [] } as never, workspacesDir: mkdtempSync(join(tmpdir(), 'dsp-hello-')), slots: new Slots(2),
      claudeAccounts: () => [], githubAccounts: [], gitEnv: () => ({}), remoteBase: 'https://github.com',
    });
    const starting = (link as unknown as { starting: Map<number, string[]> }).starting;
    starting.set(5, []);
    starting.set(6, []);
    link.connect(50);
    const hellos = () => got.filter((m): m is Extract<WorkerToServer, { t: 'hello' }> => m.t === 'hello');
    await waitFor(() => hellos().length === 1, 'first hello');
    expect(hellos()[0].acks).toEqual({});
    link.send({ t: 'status', session_id: 5, status: 'idle' });
    // a message for session 5 arrives (it is still being set up: it waits for the start)
    for (const c of wss.clients) c.send(JSON.stringify({ t: 'send', session_id: 5, text: 'more', spec: { session_id: 5 }, turn_id: 'turn-5' }));
    await waitFor(() => starting.get(5)!.length === 1, 'message taken');
    link.send({ t: 'status', session_id: 5, status: 'running' });
    link.send({ t: 'status', session_id: 6, status: 'running' });
    await waitFor(() => got.filter((m) => m.t === 'status').length === 3, 'statuses');
    expect(got.filter((m) => m.t === 'status').map((m) => (m as { ack?: string }).ack)).toEqual([undefined, 'turn-5', undefined]);
    for (const c of wss.clients) c.terminate();
    await waitFor(() => hellos().length === 2, 'second hello', 5000);
    expect(hellos()[1].acks).toEqual({ 5: 'turn-5' });
  }, 10_000);

  it('the hello names the last status of a session closed since the last one, and whether it is still to come (DISP-248)', async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss!.once('listening', r));
    const got: WorkerToServer[] = [];
    wss.on('connection', (ws) => ws.on('message', (d) => got.push(JSON.parse(String(d)) as WorkerToServer)));
    const entry = { name: 'home', url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/worker`, token: 't', local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: null, releases: [], repo_env_dir: '/nonexistent' };
    link = new ServerLink(entry, {
      fake: true, opts: { assistantReadDirs: [] } as never, workspacesDir: mkdtempSync(join(tmpdir(), 'dsp-hello-')), slots: new Slots(2),
      claudeAccounts: () => [], githubAccounts: [], gitEnv: () => ({}), remoteBase: 'https://github.com',
    });
    const starting = (link as unknown as { starting: Map<number, unknown[]> }).starting;
    starting.set(5, []);
    starting.set(6, []);
    link.connect(50);
    const hellos = () => got.filter((m): m is Extract<WorkerToServer, { t: 'hello' }> => m.t === 'hello');
    await waitFor(() => hellos().length === 1, 'first hello');
    link.send({ t: 'status', session_id: 5, status: 'idle' }); // written, maybe lost with the link
    for (const c of wss.clients) c.terminate();
    await waitFor(() => !(link as unknown as { ws: unknown }).ws, 'link down');
    link.send({ t: 'status', session_id: 6, status: 'idle' }); // to the outbox
    // both close over here before the link is back
    starting.delete(5);
    starting.delete(6);
    await waitFor(() => hellos().length === 2, 'second hello', 5000);
    expect(hellos()[1].live).toEqual([]);
    expect(hellos()[1].statuses).toEqual([{ t: 'status', session_id: 5, status: 'idle' }, { t: 'status', session_id: 6, status: 'idle', queued: true }]);
    // the outbox's idle follows the hello; written now, the next hello repeats it
    await waitFor(() => got.some((m) => m.t === 'status' && m.session_id === 6), 'outbox sent');
    for (const c of wss.clients) c.terminate();
    await waitFor(() => hellos().length === 3, 'third hello', 5000);
    expect(hellos()[2].statuses).toEqual([{ t: 'status', session_id: 6, status: 'idle' }]);
  }, 15_000);
});

type Msg = { t: string; session_id?: number; spec?: { session_id: number } };

async function rawWorker(port: number, token: string, hello: Record<string, unknown> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, { headers: { 'x-worker-token': token } });
  const got: Msg[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', live: [], ...hello }));
  return { got, send: (m: object) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

describe('the server takes a lost status from the hello (DISP-197)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let b: { id: number; secret: string };
  const get = async (id: number) => (await s.call('GET', `/sessions/${id}`)).data.session;
  beforeEach(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'HS', name: 'Hello' });
    await s.call('POST', '/projects/HS/repos', { github_owner: 'me', github_name: 'hs' });
    const made = s.ctx.workers.create('b', '', OWNER);
    b = { id: made.worker.id, secret: made.secret };
    s.ctx.workers.setDefault(b.id);
  });
  afterEach(() => s.app.close());

  const running = async () => {
    const wb = await rawWorker(s.port, b.secret);
    const job = (await s.call('POST', '/projects/HS/batches', { prompt: 'x' })).data as { id: number };
    await waitFor(() => wb.got.some((m) => m.t === 'start'), 'started');
    wb.send({ t: 'status', session_id: job.id, status: 'running', sdk_session_id: 'sdk-1' });
    await waitFor(async () => (await get(job.id)).sdk_session_id === 'sdk-1', 'running');
    wb.close();
    await waitFor(() => !s.ctx.hub.isConnected(b.id), 'gone');
    return job;
  };

  it('a turn that ended while the link was half-open ends here on the next hello', async () => {
    const job = await running();
    const wb = await rawWorker(s.port, b.secret, { live: [job.id], statuses: [{ t: 'status', session_id: job.id, status: 'idle', sdk_session_id: 'sdk-2' }] });
    await waitFor(async () => (await get(job.id)).status === 'idle', 'idle');
    const now = await get(job.id);
    expect(now).toMatchObject({ sdk_session_id: 'sdk-2', waiting_reason: 'Turn finished' });
    expect(wb.got.filter((m) => m.t === 'start' || m.t === 'close')).toEqual([]); // nothing resumed or closed
    wb.close();
  });

  it('a hello with no statuses (an older worker), or the same status, leaves the session running', async () => {
    const job = await running();
    let wb = await rawWorker(s.port, b.secret, { live: [job.id] });
    await waitFor(async () => (await get(job.id)).waiting_reason === null, 'back');
    wb.close();
    await waitFor(() => !s.ctx.hub.isConnected(b.id), 'gone');
    wb = await rawWorker(s.port, b.secret, { live: [job.id], statuses: [{ t: 'status', session_id: job.id, status: 'running', sdk_session_id: 'sdk-1' }] });
    await waitFor(async () => (await get(job.id)).waiting_reason === null, 'back');
    expect((await get(job.id)).status).toBe('running');
    wb.close();
  });
});
