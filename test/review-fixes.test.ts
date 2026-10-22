import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import { ServerLink, Slots } from '../src/worker/serverLink.ts';
import { startServer, waitFor } from './helpers.ts';

type Msg = { t: string; spec?: Record<string, any>; cmd?: { c: string }; req_id?: string; session_id?: number; text?: string };

async function rawWorker(port: number, token: string, hello: Record<string, unknown> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, { headers: { 'x-worker-token': token } });
  const got: Msg[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as Msg;
    got.push(m);
    if (m.t === 'cmd') ws.send(JSON.stringify({ t: 'cmd_result', req_id: m.req_id, ok: true, data: { ok: true } }));
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', live: [], ...hello }));
  return { ws, got, send: (m: object) => ws.send(JSON.stringify(m)), starts: () => got.filter((m) => m.t === 'start'), close: () => ws.close() };
}

const facts = (claude: string[], free = 3) => ({ facts: { os: 'linux', hostname: 'h', slots: 3, free_slots: free, claude_accounts: claude.map((name) => ({ name, label: name, kind: 'machine', logged_in: true, config_dir: null })), github_accounts: [], local_repo_dirs: [] } });

describe('review fixes', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let b: { id: number; secret: string };
  const get = async (id: number) => (await s.call('GET', `/sessions/${id}`)).data.session;
  beforeEach(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'RF', name: 'Fixes' });
    await s.call('POST', '/projects/RF/repos', { github_owner: 'me', github_name: 'rf' });
    const made = s.ctx.workers.create('b', '');
    b = { id: made.worker.id, secret: made.secret };
    s.ctx.workers.setDefault(b.id);
  });
  afterEach(() => s.app.close());

  it('#1 a refused resume, started again later, continues the conversation instead of repeating the first prompt', async () => {
    const wb = await rawWorker(s.port, b.secret);
    const job = (await s.call('POST', '/projects/RF/batches', { prompt: 'do the batch' })).data;
    await waitFor(() => wb.starts().length === 1, 'first start');
    wb.send({ t: 'status', session_id: job.id, status: 'running', sdk_session_id: 'sdk-1' });
    await waitFor(async () => (await get(job.id)).sdk_session_id === 'sdk-1', 'sdk');
    wb.send({ t: 'refused', session_id: job.id, reason: 'busy' });
    await waitFor(async () => (await get(job.id)).status === 'queued', 'queued');
    wb.send({ t: 'slots', free: 1 });
    await waitFor(() => wb.starts().length === 2, 'started again');
    const spec = wb.starts()[1].spec!;
    expect(spec.resume).toBe('sdk-1');
    expect(spec.prompt).not.toBe('do the batch');
    expect(spec.resume_note).toMatch(/continue/i);
    wb.close();
  });

  it('#3 a revoked worker is cut off at once: its messages are ignored right after the revoke', async () => {
    const wb = await rawWorker(s.port, b.secret);
    const job = (await s.call('POST', '/projects/RF/batches', { prompt: 'x' })).data;
    await waitFor(() => wb.starts().length === 1, 'started');
    expect((await s.call('DELETE', `/workers/${b.id}`)).status).toBe(200);
    expect(s.ctx.hub.isConnected(b.id)).toBe(false); // not after the close handshake: now
    wb.send({ t: 'status', session_id: job.id, status: 'failed', error: 'from a revoked worker' });
    await new Promise((r) => setTimeout(r, 150));
    expect((await get(job.id)).status).not.toBe('failed');
  });

  it('#5 a batch for an offline worker is checked against that worker, not the ones online', async () => {
    const first = await rawWorker(s.port, b.secret, facts(['work']));
    await waitFor(() => s.ctx.hub.isConnected(b.id), 'b seen once');
    first.close();
    await waitFor(() => !s.ctx.hub.isConnected(b.id), 'b asleep');
    const wa = await rawWorker(s.port, 'test-token', facts(['home']));
    await waitFor(() => s.ctx.hub.isConnected(s.ctx.workers.legacy().id), 'a online');
    const r = await s.call('POST', '/projects/RF/batches', { prompt: 'x', options: { ...DEFAULT_RUN_OPTIONS, worker_id: b.id, claude_account: 'work' } });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ status: 'queued', claude_account: 'work' });
    wa.close();
  });

  it('#6 a reply while the link was down reaches a runner that kept going, without killing its turn', async () => {
    let wb = await rawWorker(s.port, b.secret);
    const job = (await s.call('POST', '/projects/RF/batches', { prompt: 'x' })).data;
    await waitFor(() => wb.starts().length === 1, 'started');
    wb.send({ t: 'status', session_id: job.id, status: 'running', sdk_session_id: 'sdk-6' });
    wb.send({ t: 'status', session_id: job.id, status: 'idle' });
    await waitFor(async () => (await get(job.id)).status === 'idle', 'idle');
    wb.close();
    await waitFor(() => !s.ctx.hub.isConnected(b.id), 'gone');
    await s.call('POST', `/sessions/${job.id}/messages`, { text: 'one more' });
    wb = await rawWorker(s.port, b.secret, { live: [job.id] });
    await waitFor(() => wb.got.some((m) => m.t === 'send' || m.t === 'start' || m.t === 'close'), 'delivered');
    await new Promise((r) => setTimeout(r, 100));
    expect(wb.got.filter((m) => m.t === 'close')).toEqual([]);
    expect(wb.got.find((m) => m.t === 'send')).toMatchObject({ session_id: job.id, text: 'one more' });
    expect(await get(job.id)).toMatchObject({ status: 'running', pending_prompt: null });
    wb.close();
  });

  it('#7 a short worker restart sends no push; an "after" batch shows what it really waits for', async () => {
    s.ctx.sessions.workerGraceMs = 60_000;
    let wb = await rawWorker(s.port, b.secret);
    const item = (await s.call('POST', '/projects/RF/items', { title: 'i' })).data;
    const first = (await s.call('POST', '/projects/RF/batches', { item_ids: [item.id], prompt: 'a' })).data;
    await waitFor(() => wb.starts().length === 1, 'first runs');
    wb.close();
    await waitFor(() => !s.ctx.hub.isConnected(b.id), 'restart');
    const after = (await s.call('POST', '/projects/RF/batches', { prompt: 'b', options: { ...DEFAULT_RUN_OPTIONS, start: 'after' } })).data;
    const plain = (await s.call('POST', '/projects/RF/batches', { prompt: 'c' })).data;
    expect((await get(after.id)).waiting_reason).toMatch(/^Waiting for #/);
    expect((await get(plain.id)).waiting_reason).toBe('Waiting for worker b');
    expect(s.ctx.notifier.sent.filter((n) => n.tag?.startsWith('worker-wait-'))).toEqual([]);
    wb = await rawWorker(s.port, b.secret, { live: [first.id] });
    await waitFor(() => wb.starts().some((m) => m.spec!.session_id === plain.id), 'back');
    wb.close();
  });

  it('#8 moving a started session pushes its branch on the old worker first', async () => {
    const wb = await rawWorker(s.port, b.secret);
    const job = (await s.call('POST', '/projects/RF/batches', { prompt: 'x' })).data;
    await waitFor(() => wb.starts().length === 1, 'started');
    const moved = await s.call('POST', `/sessions/${job.id}/move`, { worker_id: s.ctx.workers.legacy().id });
    expect(moved.status).toBe(200);
    const order = wb.got.filter((m) => m.t === 'cmd' || m.t === 'close').map((m) => m.t === 'cmd' ? m.cmd!.c : m.t);
    expect(order).toEqual(['push_branch', 'close']);
    // an ended session cannot be moved
    expect((await s.call('POST', `/sessions/${job.id}/move`, { worker_id: b.id })).status).toBe(400);
    wb.close();
  });
});

describe('review fixes in the worker', () => {
  const entry = { name: 'home', url: 'ws://127.0.0.1:1/worker', token: 't', local_repo_dirs: ['/allowed'], read_dirs: [], claude_accounts: null, github_accounts: null, releases: [] };
  const link = (slots: Slots) => new ServerLink(entry, {
    fake: false, opts: { assistantReadDirs: [] } as never, workspacesDir: '/tmp/dsp-rf-ws', first: true, slots,
    claudeAccounts: () => [], githubAccounts: [], gitEnv: () => ({}), remoteBase: 'https://github.com',
  });
  const spec = (id: number) => ({ session_id: id, kind: 'work' as const, project_key: 'R', project_name: 'R', importance_scale: [], effort_scale: [], title: 't', branch: 'b', repos: [], items: [], source: null, prompt: 'p', force_plan: false, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: null, resume: null, resume_note: null });

  it('#2 a slot is taken as soon as a start is accepted, during setup', async () => {
    const slots = new Slots(1);
    const l = link(slots);
    let release!: () => void;
    l.workspaces.prepare = () => new Promise((_, reject) => { release = () => reject(new Error('setup failed')); });
    const a = l.launch(spec(1), 'p', true);
    expect(slots.free).toBe(0); // reserved while preparing
    release();
    await a;
    expect(slots.free).toBe(1); // a failed start gives it back
  });

  it('#4 tidy and leftovers refuse folders outside this server\'s list', async () => {
    const l = link(new Slots(1));
    const repo = { id: 1, project_id: 1, github_owner: 'local', github_name: 'x', default_branch: 'main', check_command: null, local_path: '/elsewhere/x', worktree_from: null, setup_command: null };
    await expect(l.command({ c: 'tidy', session_id: 1, repos: [repo], branch: 'b', merged_repo_ids: [1], delete_merged: true, force: true })).rejects.toThrow(/outside/);
    await expect(l.command({ c: 'leftovers', session_id: 1, repos: [repo], branch: 'b', merged_repo_ids: [] })).rejects.toThrow(/outside/);
  });
});
