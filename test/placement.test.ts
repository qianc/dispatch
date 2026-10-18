import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { plannerPrompt } from '../src/worker/prompts.ts';
import { startServer, waitFor } from './helpers.ts';

type Msg = { t: string; spec?: Record<string, any>; cmd?: { c: string; path?: string }; req_id?: string };

async function rawWorker(port: number, token: string, facts?: Record<string, unknown>) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, { headers: { 'x-worker-token': token } });
  const got: Msg[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as Msg;
    got.push(m);
    // answer local repo checks like a worker whose LOCAL_REPO_DIRS holds everything
    if (m.t === 'cmd' && m.cmd?.c === 'inspect_local_repo') {
      ws.send(JSON.stringify({ t: 'cmd_result', req_id: m.req_id, ok: true, data: { path: m.cmd.path, name: m.cmd.path!.split('/').pop(), default_branch: 'main', receive_deny_current_branch: 'updateInstead' } }));
    }
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', live: [], ...(facts ? { facts: { os: 'linux', hostname: 'h', slots: 3, free_slots: 3, claude_accounts: [], github_accounts: [], local_repo_dirs: [], ...facts } } : {}) }));
  const starts = () => got.filter((m) => m.t === 'start').map((m) => m.spec!);
  return { ws, got, starts, send: (m: object) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

describe('placement', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let b: { id: number; secret: string };
  const legacy = () => s.ctx.workers.legacy().id;
  beforeEach(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'PL', name: 'Place' });
    await s.call('POST', '/projects/PL/repos', { github_owner: 'me', github_name: 'pl' });
    const made = s.ctx.workers.create('b', 'Windows desktop with PowerPoint. Often asleep.');
    b = { id: made.worker.id, secret: made.secret };
  });
  afterEach(() => s.app.close());

  it('picks the worker: asked for, else the project default, else the global default', async () => {
    const p = s.ctx.store.projectByKey('PL')!;
    expect(s.ctx.sessions.workerFor(p, null)).toBe(legacy());
    expect(s.ctx.sessions.workerFor(p, b.id)).toBe(b.id);
    expect((await s.call('PATCH', '/projects/PL', { worker_id: b.id, placement_md: 'Use b for PowerPoint.' })).data).toMatchObject({ worker_id: b.id, placement_md: 'Use b for PowerPoint.' });
    expect(s.ctx.sessions.workerFor(s.ctx.store.projectByKey('PL')!, null)).toBe(b.id);
    expect((await s.call('PATCH', '/projects/PL', { worker_id: 999 })).status).toBe(400);
    // the assistant has no project: the global default
    expect(s.ctx.sessions.workerFor(null, null)).toBe(legacy());
  });

  it("a project's local repos fix its worker; another worker is refused, and so is a local repo on a second worker", async () => {
    const wa = await rawWorker(s.port, 'test-token');
    const wb = await rawWorker(s.port, b.secret);
    await waitFor(() => s.ctx.hub.connectedIds().length === 2, 'both');
    await s.call('POST', '/projects', { key: 'LO', name: 'Local' });
    const repo = await s.call('POST', '/projects/LO/repos', { local_path: '/r/one', worker_id: b.id });
    expect(repo.status).toBe(200);
    expect(repo.data).toMatchObject({ kind: 'local', worker_id: b.id });
    expect(wb.got.some((m) => m.cmd?.c === 'inspect_local_repo')).toBe(true);
    expect(wa.got.some((m) => m.cmd?.c === 'inspect_local_repo')).toBe(false);
    const second = await s.call('POST', '/projects/LO/repos', { local_path: '/r/two', worker_id: legacy() });
    expect(second.status).toBe(400);
    expect(second.data.error).toMatch(/local repos are on worker b/);
    const lo = s.ctx.store.projectByKey('LO')!;
    expect(s.ctx.sessions.workerFor(lo, null)).toBe(b.id);
    expect(() => s.ctx.sessions.workerFor(lo, legacy())).toThrow(/local repos are on worker b/);
    wa.close();
    wb.close();
  });

  it('a batch starts on the worker in its options, or named on its proposal', async () => {
    const wb = await rawWorker(s.port, b.secret);
    const byId = (await s.call('POST', '/projects/PL/batches', { prompt: 'x', options: { worker_id: b.id } })).data;
    expect(byId.worker_id).toBe(b.id);
    const byName = (await s.call('POST', '/projects/PL/batches', { prompt: 'y', worker: 'b' })).data;
    expect(byName.worker_id).toBe(b.id);
    await waitFor(() => wb.starts().length === 2, 'both on b');
    expect((await s.call('POST', '/projects/PL/batches', { prompt: 'z', worker: 'nope' })).status).toBe(400);
    wb.close();
  });

  it("refuses a start on a worker that lacks the session's Claude account", async () => {
    await rawWorker(s.port, b.secret, { claude_accounts: [{ name: 'home', label: 'Home', kind: 'machine', logged_in: true, config_dir: null }] });
    await waitFor(() => s.ctx.hub.isConnected(b.id), 'b');
    const r = await s.call('POST', '/projects/PL/batches', { prompt: 'x', options: { worker_id: b.id, claude_account: 'work' } });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/Worker b has no Claude account "work"/);
  });

  it('the planner gets the workers and the project text, and is told to name a worker', async () => {
    await s.call('PATCH', '/projects/PL', { placement_md: 'Use b only for PowerPoint work.' });
    const wa = await rawWorker(s.port, 'test-token');
    const plan = (await s.call('POST', '/projects/PL/planner', { prompt: 'next?' })).data;
    await waitFor(() => wa.starts().some((x) => x.session_id === plan.id), 'planner started');
    const spec = wa.starts().find((x) => x.session_id === plan.id)!;
    expect(spec.placement_md).toBe('Use b only for PowerPoint work.');
    expect(spec.workers).toEqual([
      expect.objectContaining({ name: 'default', connected: true }),
      expect.objectContaining({ name: 'b', description: 'Windows desktop with PowerPoint. Often asleep.', connected: false }),
    ]);
    const text = plannerPrompt(spec as never);
    expect(text).toContain('## Where work runs');
    expect(text).toContain('Use b only for PowerPoint work.');
    expect(text).toContain('- b (offline): Windows desktop with PowerPoint. Often asleep.');
    expect(text).toMatch(/set `worker`/);
    wa.close();
  });

  it('a proposal card carries the worker and the reason', async () => {
    const wa = await rawWorker(s.port, 'test-token');
    const plan = (await s.call('POST', '/projects/PL/planner', { prompt: 'next?' })).data;
    await waitFor(() => wa.starts().some((x) => x.session_id === plan.id), 'planner started');
    await s.ctx.sessions.rpc(plan.id, 'propose', { type: 'batch', title: 'Deck tests', item_ids: [], prompt: 'run them', worker: 'b', worker_reason: 'Needs PowerPoint.' });
    const ev = (await s.call('GET', `/sessions/${plan.id}`)).data.events.find((e: { body: { kind: string } }) => e.body.kind === 'proposal');
    expect(ev.body.proposal).toMatchObject({ worker: 'b', worker_reason: 'Needs PowerPoint.' });
    wa.close();
  });

  it('moves a waiting session; a started one becomes a new linked session; local repos cannot move', async () => {
    const queued = (await s.call('POST', '/projects/PL/batches', { prompt: 'q', options: { worker_id: b.id } })).data;
    const moved = await s.call('POST', `/sessions/${queued.id}/move`, { worker_id: legacy() });
    expect(moved.data).toMatchObject({ id: queued.id, worker_id: legacy() });

    const wb = await rawWorker(s.port, b.secret);
    const item = (await s.call('POST', '/projects/PL/items', { title: 'Thing' })).data;
    const job = (await s.call('POST', '/projects/PL/batches', { item_ids: [item.id], prompt: 'go', options: { worker_id: b.id } })).data;
    await waitFor(() => wb.starts().some((x) => x.session_id === job.id), 'started on b');
    const again = (await s.call('POST', `/sessions/${job.id}/move`, { worker_id: legacy() })).data;
    expect(again.id).not.toBe(job.id);
    expect(again).toMatchObject({ moved_from: job.id, worker_id: legacy(), branch: job.branch, item_ids: [item.id] });
    expect(again.initial_prompt).toContain(`Continue the work on branch ${job.branch}`);
    expect((await s.call('GET', `/sessions/${job.id}`)).data.session.status).toBe('stopped');
    expect((await s.call('GET', `/items/${item.id}`)).data.item?.status ?? (await s.call('GET', `/items/${item.id}`)).data.status).toBe('in_progress');

    await s.call('POST', '/projects', { key: 'LM', name: 'Local move' });
    await s.call('POST', '/projects/LM/repos', { local_path: '/r/x', worker_id: b.id });
    const loc = (await s.call('POST', '/projects/LM/batches', { prompt: 'l' })).data;
    await waitFor(() => wb.starts().some((x) => x.session_id === loc.id), 'local on b');
    const no = await s.call('POST', `/sessions/${loc.id}/move`, { worker_id: legacy() });
    expect(no.status).toBe(400);
    expect(no.data.error).toMatch(/local repos/);
    wb.close();
  });
});
