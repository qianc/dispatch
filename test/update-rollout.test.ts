import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import type { SelfUpdateAnswer } from '../src/shared/protocol.ts';
import type { UpdateInfo, UpdateRow } from '../src/shared/types.ts';
import { UPDATE_HOLD } from '../src/server/updates.ts';
import { Refusal } from '../src/update/apply.ts';
import type { LauncherLink } from '../src/update/ipc.ts';
import { OWNER, startServer, waitFor } from './helpers.ts';
import { fakeSource } from './update-source.ts';

const sha = (c: string) => c.repeat(40);
const A = sha('a'), B = sha('b');

interface Msg { t: string; req_id?: string; update_id?: number; sha?: string; prev?: string | null; spec?: { session_id: number }; cmd?: { c: string; sha?: string; update_id?: number } }

/** A hand-driven worker that runs `version` of Dispatch: records what the server sends, sends what the test says. */
async function rawWorker(port: number, token: string, version?: { sha: string | null; updatable: boolean; why?: string; server_update?: boolean }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, { headers: { 'x-worker-token': token } });
  const got: Msg[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once('open', r));
  const facts = { os: 'linux', hostname: 'h', slots: 4, free_slots: 4, claude_accounts: [], github_accounts: [], local_repo_dirs: [], releases: [], ...(version ? { version } : {}) };
  ws.send(JSON.stringify({ t: 'hello', live: [], facts }));
  const send = (m: Record<string, unknown>) => ws.send(JSON.stringify(m));
  const asks = () => got.filter((m) => m.t === 'cmd' && m.cmd!.c === 'self_update');
  return {
    got, send, asks,
    starts: () => got.filter((m) => m.t === 'start').map((m) => m.spec!.session_id),
    /** answer the newest question "update yourself" */
    answer: (a: SelfUpdateAnswer) => send({ t: 'cmd_result', req_id: asks().at(-1)!.req_id, ok: true, data: a }),
    close: () => new Promise<void>((r) => {
      if (ws.readyState === WebSocket.CLOSED) return r();
      ws.once('close', () => r());
      ws.close();
    }),
  };
}

type Worker = Awaited<ReturnType<typeof rawWorker>>;

describe('the rollout of an update: the server first, then the workers, each in wait mode (DISP-112)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let b: { id: number; secret: string };
  let defaultId: number;
  /** what the launcher was asked */
  let asked: { req: { sha: string; from: string | null }; ctx: unknown }[];
  let open: Worker[];

  const info = async () => (await s.call<UpdateInfo>('GET', '/update')).data;
  const log = async () => (await info()).log;
  const notices = () => s.ctx.notifier.sent.map((n) => n.title);
  const session = async (id: number) => (await s.call('GET', `/sessions/${id}`)).data.session;
  const worker = async (token: string, version?: Parameters<typeof rawWorker>[2]) => {
    const w = await rawWorker(s.port, token, version);
    open.push(w);
    return w;
  };
  const online = (n: number) => waitFor(() => s.ctx.hub.connectedIds().length === n, `${n} workers online`);
  /** a session on the default worker, as far as its first turn */
  const work = async (w: Worker, prompt = 'do it') => {
    const job = (await s.call('POST', '/projects/UP/batches', { prompt })).data;
    await waitFor(() => w.starts().includes(job.id), 'the start');
    w.send({ t: 'status', session_id: job.id, status: 'running', sdk_session_id: `sdk-${job.id}` });
    await waitFor(async () => (await session(job.id)).sdk_session_id, 'the session runs');
    return job.id as number;
  };
  const status = async (w: Worker, id: number, st: string, more: Record<string, unknown> = {}) => {
    w.send({ t: 'status', session_id: id, status: st, ...more });
    await waitFor(async () => (await session(id)).status === st && (!more.limit || (await session(id)).limit_wait), `session ${id} ${st}`);
  };
  /** the launcher, as a server started by src/launch.ts has it */
  const withLauncher = () => {
    s.ctx.updates.launcher = { available: true, why: null, request: (req, ctx) => void asked.push({ req, ctx }), onResult() {}, ready() {} } satisfies LauncherLink;
  };
  /** auto-update on, and a look: the release branch is `branch`, the server runs `at` */
  const autoOn = async (at: string, branch = [A, B]) => {
    s.ctx.version.sha = at;
    s.ctx.updates.source = fakeSource(branch);
    await s.call('POST', '/update/check');
    expect((await s.call('PUT', '/update/settings', { auto: true })).status).toBe(200);
  };

  beforeEach(async () => {
    s = await startServer({ UPDATE_REPO: 'you/dispatch' });
    await s.call('POST', '/projects', { key: 'UP', name: 'Updates' });
    await s.call('POST', '/projects/UP/repos', { github_owner: 'me', github_name: 'up' });
    const made = s.ctx.workers.create('b', 'second worker', OWNER);
    b = { id: made.worker.id, secret: made.secret };
    defaultId = s.ctx.workers.legacy().id;
    asked = [];
    open = [];
    // the commit is one of the release branch: the real check needs a checkout and the network
    s.ctx.updates.verify = async (req) => ({ sha: req.sha }) as unknown as Awaited<ReturnType<typeof s.ctx.updates.verify>>;
  });
  afterEach(async () => {
    await Promise.all(open.map((w) => w.close()));
    await s.app.close();
  });

  describe('the server', () => {
    it('waits while a session works, and updates when its turn has ended', async () => {
      withLauncher();
      const w = await worker('test-token', { sha: A, updatable: false });
      await autoOn(A);
      expect((await info()).target).toEqual({ sha: B, tag: null });
      const id = await work(w);

      // a session works: nothing is asked of the launcher, and nothing is logged
      await s.ctx.updates.tick();
      expect(asked).toEqual([]);
      expect(await log()).toEqual([]);
      expect((await info()).waiting).toEqual([`The server updates to ${B.slice(0, 7)} when it is idle. Now: session #${id} is working.`]);
      expect(s.ctx.sessions.hold).toBeNull();

      // the turn ends: the session waits for its owner, and that is wait mode
      await status(w, id, 'idle');
      await waitFor(() => s.ctx.updates.serverGate().length === 0, 'wait mode');
      await s.ctx.updates.tick();
      expect(asked).toEqual([{ req: { sha: B, from: A }, ctx: { update_id: 1 } }]);
      expect(await log()).toMatchObject([{ id: 1, target: 'server', worker_id: null, triggered_by: 'auto', from_sha: A, to_sha: B, state: 'running', ended_at: null }]);
      expect((await info()).waiting).toEqual([]);
      // one update at a time
      await s.ctx.updates.tick();
      expect(asked).toHaveLength(1);

      // what comes in now waits for the new version
      expect(s.ctx.sessions.hold).toBe(UPDATE_HOLD);
      const late = (await s.call('POST', '/projects/UP/batches', { prompt: 'later' })).data;
      expect((await session(late.id))).toMatchObject({ status: 'queued', waiting_reason: UPDATE_HOLD });
      await s.call('POST', `/sessions/${id}/messages`, { text: 'one more thing' });
      expect(await session(id)).toMatchObject({ status: 'queued', pending_prompt: 'one more thing' });
      expect(w.got.filter((m) => m.t === 'send')).toEqual([]);
    });

    it('a failed update that was rolled back is logged, told, and not tried again by itself', async () => {
      withLauncher();
      const w = await worker('test-token', { sha: A, updatable: false });
      await autoOn(A);
      await s.ctx.updates.tick();
      expect(asked).toHaveLength(1);
      const waits = (await s.call('POST', '/projects/UP/batches', { prompt: 'waits' })).data;
      expect((await session(waits.id)).status).toBe('queued');

      // the launcher put the old version back
      s.ctx.updates.onLauncherResult({ ok: false, rolled_back: true, from: A, to: B, error: 'The new version did not start.', log_tail: 'Error: boom' }, { update_id: 1 });
      const [row] = await log();
      expect(row).toMatchObject({ state: 'rolled_back', from_sha: A, to_sha: B });
      expect(row.detail).toContain('The new version did not start.');
      expect(row.detail).toContain('Error: boom');
      expect(row.ended_at).not.toBeNull();
      expect(notices()).toContain('Dispatch: the update failed');
      expect(s.ctx.notifier.sent.at(-1)!.body).toContain(`is back on ${A.slice(0, 7)}`);
      // work goes on, on the old version
      expect(s.ctx.sessions.hold).toBeNull();
      await waitFor(() => w.starts().includes(waits.id), 'the queued session starts');
      await status(w, waits.id, 'idle');
      await waitFor(() => s.ctx.updates.serverGate().length === 0, 'wait mode');

      // auto-update does not try that version again
      await s.ctx.updates.tick();
      expect(asked).toHaveLength(1);
      expect((await info()).waiting).toEqual([`The update of the server to ${B.slice(0, 7)} failed. "Update now" tries it again.`]);
      // a result that comes twice changes nothing
      s.ctx.updates.onLauncherResult({ ok: true, rolled_back: false, from: A, to: B }, { update_id: 1 });
      expect((await log())[0].state).toBe('rolled_back');

      // "Update now" does
      expect((await s.call('POST', '/update/start', {})).status).toBe(200);
      expect((await info()).rollout).toEqual({ sha: B, tag: null, by: OWNER, from: A });
      await s.ctx.updates.tick();
      expect(asked).toHaveLength(2);
      expect((await log())[0]).toMatchObject({ id: 2, triggered_by: OWNER, state: 'running' });
      // and when that fails too, the update by hand is over
      s.ctx.updates.onLauncherResult({ ok: false, rolled_back: false, from: A, to: B, error: 'npm ci failed' }, { update_id: 2 });
      expect((await log())[0]).toMatchObject({ id: 2, state: 'failed' });
      expect((await info()).rollout).toBeNull();
    });

    it('the result in the new version ends the update', async () => {
      withLauncher();
      await autoOn(A);
      await s.ctx.updates.tick();
      // the new version runs (in real use: a new process, with the same database)
      s.ctx.version.sha = B;
      // a result for another commit is not this update's
      s.ctx.updates.onLauncherResult({ ok: true, rolled_back: false, from: A, to: sha('c') }, { update_id: 1 });
      expect((await log())[0].state).toBe('running');
      s.ctx.updates.onLauncherResult({ ok: true, rolled_back: false, from: A, to: B }, { update_id: 1 });
      expect((await log())[0]).toMatchObject({ state: 'ok', detail: null });
      expect(notices()).toContain('Dispatch: updated');
      expect(s.ctx.sessions.hold).toBeNull();
    });

    it('a session that only waits for its usage limit does not hold the update back; a merge check does', async () => {
      withLauncher();
      const w = await worker('test-token', { sha: A, updatable: false });
      await autoOn(A);
      const id = await work(w);
      await status(w, id, 'running', { limit: { resets_at: '2026-11-19T10:00:00Z' } });
      expect(s.ctx.updates.serverGate()).toEqual([]);
      // a command a worker runs for the server (a merge, a push) would be cut off
      const cmd = s.ctx.hub.cmd(defaultId, { c: 'make_title', goal: 'g', projects: [], account: null }, 60_000).catch(() => null);
      expect(s.ctx.updates.serverGate()).toEqual(['a worker runs a command for the server']);
      await s.ctx.updates.tick();
      expect(asked).toEqual([]);
      const sent = await waitFor(() => w.got.find((m) => m.t === 'cmd'), 'the command');
      w.send({ t: 'cmd_result', req_id: sent.req_id, ok: true, data: { title: 't' } });
      await cmd;
      await s.ctx.updates.tick();
      expect(asked).toHaveLength(1);
    });

    it('nothing happens with auto-update off, until "Update now"; "Cancel" stops it before its step', async () => {
      withLauncher();
      const w = await worker('test-token', { sha: A, updatable: false });
      s.ctx.version.sha = A;
      s.ctx.updates.source = fakeSource([A, B]);
      // nothing known yet: nothing to update to
      expect((await s.call('POST', '/update/start', {})).status).toBe(409);
      await s.call('POST', '/update/check');
      await s.ctx.updates.tick();
      expect(asked).toEqual([]);

      const id = await work(w);
      expect((await s.call('POST', '/update/start', {})).status).toBe(200);
      await s.ctx.updates.tick();
      expect((await info()).waiting).toHaveLength(1);
      expect((await s.call('POST', '/update/cancel', {})).status).toBe(200);
      expect(await info()).toMatchObject({ rollout: null, waiting: [] });
      await status(w, id, 'idle');
      await waitFor(() => s.ctx.updates.serverGate().length === 0, 'wait mode');
      await s.ctx.updates.tick();
      expect(asked).toEqual([]);
    });

    it('a commit the checkout refuses fails the update; one it already has is no update', async () => {
      withLauncher();
      await autoOn(A);
      s.ctx.updates.verify = async () => {
        throw new Refusal('refused', 'The checkout has changed files (x.ts). Commit or undo them first.');
      };
      await s.ctx.updates.tick();
      expect(asked).toEqual([]);
      expect((await log())[0]).toMatchObject({ state: 'failed', detail: 'The checkout has changed files (x.ts). Commit or undo them first.' });
      expect(s.ctx.sessions.hold).toBeNull();

      await s.call('POST', '/update/start', {});
      s.ctx.updates.verify = async () => {
        throw new Refusal('ahead', 'This version already runs.');
      };
      await s.ctx.updates.tick();
      expect(asked).toEqual([]);
      expect(await log()).toHaveLength(1);
      expect(await info()).toMatchObject({ rollout: null });
      expect(s.ctx.sessions.hold).toBeNull();
    });

    it('says why it cannot update: no launcher, and no worker with an update command', async () => {
      await autoOn(A);
      await s.ctx.updates.tick();
      const i = await info();
      expect(i.mode).toBe('none');
      expect(i.mode_why).toContain('node src/launch.ts server');
      expect(i.mode_why).toContain('server_update_command');
      expect(i.waiting).toEqual([`The server cannot be updated. ${i.mode_why}`]);
      expect(i.log).toEqual([]);
    });

    it('an image is updated by a worker that has an update command: the server sends only the commit', async () => {
      const w = await worker('test-token', { sha: A, updatable: false, server_update: true });
      const other = await worker(b.secret, { sha: A, updatable: false });
      await online(2);
      await autoOn(A);
      expect((await info()).mode).toBe('worker');
      await s.ctx.updates.tick();
      await waitFor(() => w.got.some((m) => m.t === 'server_update'), 'the update message');
      expect(w.got.find((m) => m.t === 'server_update')).toEqual({ t: 'server_update', update_id: 1, sha: B, prev: A });
      expect(other.got.filter((m) => m.t === 'server_update')).toEqual([]);
      expect((await log())[0]).toMatchObject({ target: 'server', worker_id: defaultId, worker_name: 'default', state: 'running' });
      expect(s.ctx.sessions.hold).toBe(UPDATE_HOLD);

      // only the worker that was asked can say how it ended
      other.send({ t: 'update_result', update_id: 1, target: 'server', ok: true, rolled_back: false, from: A, to: B });
      await new Promise((r) => setTimeout(r, 100));
      expect((await log())[0].state).toBe('running');
      w.send({ t: 'update_result', update_id: 1, target: 'server', ok: false, rolled_back: true, from: A, to: B, error: 'The server did not come back on bbbbbbb.' });
      await waitFor(async () => (await log())[0].state === 'rolled_back', 'the result');
      expect((await log())[0].detail).toBe('The server did not come back on bbbbbbb.');
      expect(s.ctx.sessions.hold).toBeNull();
      expect(notices()).toContain('Dispatch: the update failed');
    });

    it('only a worker of the install owner updates the server: the command of another user\'s worker is not used', async () => {
      const guest = s.ctx.workers.create('guest', 'of another user', 'guest');
      const w = await worker(guest.secret, { sha: A, updatable: false, server_update: true });
      await online(1);
      await autoOn(A);
      const i = await info();
      expect(i.mode).toBe('none');
      expect(i.mode_why).toContain(`no connected worker of ${OWNER} has a command`);
      await s.ctx.updates.tick();
      expect(w.got.filter((m) => m.t === 'server_update')).toEqual([]);
      expect(await log()).toEqual([]);
      expect(s.ctx.sessions.hold).toBeNull();
      // "Update now" starts nothing that would wait for ever, and says why
      const r = await s.call('POST', '/update/start', {});
      expect(r.status).toBe(409);
      expect(r.data.error).toBe(`The server cannot be updated. ${i.mode_why}`);
      expect((await info()).rollout).toBeNull();
    });

    it('a worker that says the update worked is believed only when the server runs the commit', async () => {
      const w = await worker('test-token', { sha: A, updatable: false, server_update: true });
      await online(1);
      await autoOn(A);
      await s.ctx.updates.tick();
      await waitFor(() => w.got.some((m) => m.t === 'server_update'), 'the update message');
      // the server starts again while the worker's command still runs: only the worker's result ends the update
      s.ctx.updates.graceMs = 0;
      s.ctx.updates.reconcile();
      await new Promise((r) => setTimeout(r, 50));
      expect((await log())[0].state).toBe('running');
      expect(s.ctx.sessions.hold).toBe(UPDATE_HOLD);

      w.send({ t: 'update_result', update_id: 1, target: 'server', ok: true, rolled_back: false, from: A, to: B });
      await waitFor(async () => (await log())[0].state === 'failed', 'the result');
      expect((await log())[0].detail).toBe(`Worker default says the update worked, but the server runs ${A.slice(0, 7)}, not ${B.slice(0, 7)}.`);
      expect(notices()).not.toContain('Dispatch: updated');
      expect(notices()).toContain('Dispatch: the update failed');
      // and that commit is not tried again by itself
      await s.ctx.updates.tick();
      expect(w.got.filter((m) => m.t === 'server_update')).toHaveLength(1);
    });

    it('an update by a worker with no result: at the time limit, the commit that runs says how it ended', async () => {
      const w = await worker('test-token', { sha: A, updatable: false, server_update: true });
      await online(1);
      await autoOn(A);
      await s.ctx.updates.tick();
      await waitFor(() => w.got.some((m) => m.t === 'server_update'), 'the update message');
      // the new version runs, and the worker never said so
      s.ctx.version.sha = B;
      s.ctx.updates.serverTimeoutMs = 1;
      await new Promise((r) => setTimeout(r, 20));
      await s.ctx.updates.tick();
      expect((await log())[0]).toMatchObject({ state: 'ok', detail: `No result of the update came within 0 minutes. The server runs ${B.slice(0, 7)}.` });
      expect(s.ctx.sessions.hold).toBeNull();
    });

    it('an update started by hand is dropped when another commit was deployed meanwhile', async () => {
      const C = sha('c');
      withLauncher();
      const w = await worker('test-token', { sha: A, updatable: false });
      s.ctx.version.sha = A;
      s.ctx.updates.source = fakeSource([A, B, C], [{ name: 'v1.1.0', sha: B }]);
      await s.call('POST', '/update/check');
      const id = await work(w);
      expect((await s.call('POST', '/update/start', { target: 'tag' })).status).toBe(200);
      expect((await info()).rollout).toEqual({ sha: B, tag: 'v1.1.0', by: OWNER, from: A });
      await s.ctx.updates.tick();
      expect((await info()).waiting).toEqual([`The server updates to v1.1.0 when it is idle. Now: session #${id} is working.`]);

      // someone deploys the newest commit by hand: v1.1.0 is behind it now, and no update goes back
      s.ctx.version.sha = C;
      await status(w, id, 'idle');
      await waitFor(() => s.ctx.updates.serverGate().length === 0, 'wait mode');
      await s.ctx.updates.tick();
      expect(asked).toEqual([]);
      expect(await info()).toMatchObject({ rollout: null, waiting: [], log: [] });
    });

    it('a chat that runs holds the update back like any other session', async () => {
      withLauncher();
      await worker('test-token', { sha: A, updatable: true });
      await online(1);
      await autoOn(A);
      const chat = (kind: 'assistant' | 'discuss', st: 'running' | 'waiting_input') => s.ctx.store.createSession({
        started_by: OWNER, worker_id: defaultId, project_id: null, kind, title: 'A chat', status: st, force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [],
      });
      const a = chat('assistant', 'running');
      expect(s.ctx.updates.serverGate()).toEqual([`session #${a.id} is working`]);
      expect(s.ctx.updates.workerGate(defaultId)).toEqual([`session #${a.id} is working`]);
      await s.ctx.updates.tick();
      expect(asked).toEqual([]);
      s.ctx.store.updateSession(a.id, { status: 'idle' });
      // one that waits for an answer holds only its worker back
      const d = chat('discuss', 'waiting_input');
      expect(s.ctx.updates.serverGate()).toEqual([]);
      expect(s.ctx.updates.workerGate(defaultId)).toEqual([`session #${d.id} waits for an answer`]);
    });

    it('Retry after a sign-in starts no turn while the server is about to stop', async () => {
      const w = await worker('test-token');
      const id = await work(w);
      await status(w, id, 'idle');
      s.ctx.sessions.hold = UPDATE_HOLD;
      await expect(s.ctx.sessions.retryLogin(id)).rejects.toThrow('Dispatch is updating. Press Retry in a moment.');
      expect(w.got.filter((m) => m.t === 'cmd' && m.cmd!.c === 'check_login')).toEqual([]);
      s.ctx.sessions.hold = null;
    });

    it('at its start, an update with no result ends by the commit that runs', async () => {
      withLauncher();
      await autoOn(A);
      await s.ctx.updates.tick();
      s.ctx.updates.graceMs = 0;
      // the old version runs again, and its launcher said nothing
      s.ctx.updates.reconcile();
      await waitFor(async () => (await log())[0].state === 'failed', 'the update ends');
      expect((await log())[0].detail).toBe(`The server runs ${A.slice(0, 7)}, not ${B.slice(0, 7)}, and no result of the update came.`);

      await s.call('POST', '/update/start', {});
      await s.ctx.updates.tick();
      expect((await log())[0]).toMatchObject({ id: 2, state: 'running' });
      // the new version runs
      s.ctx.version.sha = B;
      s.ctx.updates.reconcile();
      await waitFor(async () => (await log())[0].state === 'ok', 'the update ends');
    });

    it('an update with no result at all fails after its time limit', async () => {
      withLauncher();
      await autoOn(A);
      await s.ctx.updates.tick();
      s.ctx.updates.serverTimeoutMs = 1;
      await new Promise((r) => setTimeout(r, 20));
      await s.ctx.updates.tick();
      expect((await log())[0]).toMatchObject({ state: 'failed', detail: 'No result of the update came within 0 minutes.' });
      expect(s.ctx.sessions.hold).toBeNull();
    });
  });

  describe('the workers', () => {
    const updatable = { sha: A, updatable: true };
    /** the next step, which waits for a worker's answer */
    const step = () => s.ctx.updates.tick();
    const statuses = async () => Object.fromEntries((await info()).workers.map((w) => [w.name, w.status]));

    it('update one at a time: the second is asked only when the first is back', async () => {
      const wa = await worker('test-token', updatable);
      const wb = await worker(b.secret, updatable);
      await online(2);
      // the server runs the new version already
      await autoOn(B);
      expect(await statuses()).toEqual({ default: 'behind', b: 'behind' });

      let t = step();
      await waitFor(() => wa.asks().length === 1, 'the first worker is asked');
      expect(wa.asks()[0].cmd).toEqual({ c: 'self_update', sha: B, update_id: 1 });
      wa.answer({ state: 'started' });
      await t;
      expect(wb.asks()).toEqual([]);
      expect(await log()).toMatchObject([{ id: 1, target: 'worker', worker_id: defaultId, worker_name: 'default', triggered_by: 'auto', from_sha: A, to_sha: B, state: 'running' }]);
      expect(await statuses()).toEqual({ default: 'updating', b: 'behind' });

      // while it updates, no other worker is asked, and its sessions wait for it
      await step();
      expect(wb.asks()).toEqual([]);
      const job = (await s.call('POST', '/projects/UP/batches', { prompt: 'for the default worker' })).data;
      expect(await session(job.id)).toMatchObject({ status: 'queued', waiting_reason: 'Waiting for worker default (updating)' });
      expect(wa.starts()).toEqual([]);

      // it is back, on the new version
      await wa.close();
      await online(1);
      const wa2 = await worker('test-token', { sha: B, updatable: true });
      await waitFor(async () => (await log())[0].state === 'ok', 'the first update ends');
      await waitFor(() => wa2.starts().includes(job.id), 'its session starts');
      await status(wa2, job.id, 'idle');
      expect(notices()).not.toContain('Dispatch: worker default did not update');

      // now the second
      t = step();
      await waitFor(() => wb.asks().length === 1, 'the second worker is asked');
      expect(wa2.asks()).toEqual([]);
      wb.answer({ state: 'started' });
      await t;
      expect(await statuses()).toEqual({ default: 'current', b: 'updating' });
      // its own result also ends the update
      wb.send({ t: 'update_result', update_id: 2, target: 'worker', ok: true, rolled_back: false, from: A, to: B });
      await waitFor(async () => (await log())[0].state === 'ok', 'the second update ends');
    });

    it('a worker that works, or has an open question, is not asked; one whose sessions wait at a turn end is', async () => {
      const wa = await worker('test-token', updatable);
      await online(1);
      await autoOn(B);
      const id = await work(wa);
      await step();
      expect(wa.asks()).toEqual([]);
      expect((await info()).waiting).toEqual([`Worker default updates when it is idle. Now: session #${id} is working.`]);

      await status(wa, id, 'waiting_input');
      await step();
      expect(wa.asks()).toEqual([]);
      expect((await info()).waiting).toEqual([`Worker default updates when it is idle. Now: session #${id} waits for an answer.`]);
      expect(await log()).toEqual([]);

      await status(wa, id, 'idle');
      const t = step();
      await waitFor(() => wa.asks().length === 1, 'the worker is asked');
      // the worker has the last word: it knows what it does for other servers
      wa.answer({ state: 'busy', reasons: ['it works for another server'] });
      await t;
      expect(await log()).toEqual([]);
      expect((await info()).waiting).toEqual(['Worker default updates when it is idle. Now: it works for another server.']);
      expect(await statuses()).toMatchObject({ default: 'behind' });
    });

    it('a worker that fails keeps its version, is told, and the next one goes on', async () => {
      const wa = await worker('test-token', updatable);
      const wb = await worker(b.secret, updatable);
      await online(2);
      await autoOn(B);
      let t = step();
      await waitFor(() => wa.asks().length === 1, 'the first worker is asked');
      wa.answer({ state: 'started' });
      await t;
      // it rolled back, and says so
      wa.send({ t: 'update_result', update_id: 1, target: 'worker', ok: false, rolled_back: true, from: A, to: B, error: 'npm ci failed (exit 1)', log_tail: 'npm ERR!' });
      await waitFor(async () => (await log())[0].state === 'rolled_back', 'the result');
      expect((await log())[0].detail).toBe('npm ci failed (exit 1)\n\nLast output:\nnpm ERR!');
      expect(notices()).toContain('Dispatch: worker default did not update');
      expect(s.ctx.notifier.sent.at(-1)!.body).toBe(`It stays on ${A.slice(0, 7)}. npm ci failed (exit 1)`);
      expect(await statuses()).toEqual({ default: 'failed', b: 'behind' });
      // it takes work again
      const id = await work(wa);
      await status(wa, id, 'idle');

      // the next worker; the failed one is not asked again
      t = step();
      await waitFor(() => wb.asks().length === 1, 'the second worker is asked');
      wb.answer({ state: 'refused', reason: 'The checkout is on branch dev, not on the release branch main.' });
      await t;
      expect(wa.asks()).toHaveLength(1);
      expect((await log())[0]).toMatchObject({ id: 2, worker_name: 'b', state: 'failed', detail: 'The checkout is on branch dev, not on the release branch main.' });
      await step();
      expect(wa.asks()).toHaveLength(1);
      expect(wb.asks()).toHaveLength(1);

      // "Update now" tries both again, one at a time
      expect((await s.call('POST', '/update/start', {})).status).toBe(200);
      expect((await info()).rollout).toEqual({ sha: B, tag: null, by: OWNER, from: B });
      t = step();
      await waitFor(() => wa.asks().length === 2, 'the first worker is asked again');
      wa.answer({ state: 'ahead' });
      await waitFor(() => wb.asks().length === 2, 'the second worker is asked again');
      wb.answer({ state: 'ahead' });
      await t;
      // both say they have that commit or a newer one: nothing is left to do
      expect(await statuses()).toEqual({ default: 'newer', b: 'newer' });
      expect((await info()).rollout).toBeNull();
      expect(await log()).toHaveLength(2);
    });

    it('a worker that is not back in time did not update', async () => {
      const wa = await worker('test-token', updatable);
      await online(1);
      await autoOn(B);
      const t = step();
      await waitFor(() => wa.asks().length === 1, 'the worker is asked');
      wa.answer({ state: 'started' });
      await t;
      await wa.close();
      await online(0);
      s.ctx.updates.workerTimeoutMs = 1;
      await new Promise((r) => setTimeout(r, 20));
      await step();
      expect((await log())[0]).toMatchObject({ state: 'failed', detail: `Worker default was not back on ${B.slice(0, 7)} within 0 minutes.` });
      expect(notices()).toContain('Dispatch: worker default did not update');
      // what waited for it is not held any more by the update
      const job = (await s.call('POST', '/projects/UP/batches', { prompt: 'x' })).data;
      expect((await session(job.id)).waiting_reason).toBe('Waiting for worker default');
    });

    it('a worker whose link breaks before it answers: its hello on the new version ends the update', async () => {
      const wa = await worker('test-token', updatable);
      await online(1);
      await autoOn(B);
      const t = step();
      await waitFor(() => wa.asks().length === 1, 'the worker is asked');
      await wa.close();
      await t;
      expect((await log())[0]).toMatchObject({ state: 'running', worker_name: 'default' });
      await worker('test-token', { sha: B, updatable: true });
      await waitFor(async () => (await log())[0].state === 'ok', 'the update ends');
    });

    it('a worker whose link breaks before it answers and that is back on its old commit was only asked: it is asked again', async () => {
      const wa = await worker('test-token', updatable);
      await online(1);
      await autoOn(B);
      const t = step();
      await waitFor(() => wa.asks().length === 1, 'the worker is asked');
      await wa.close();
      await t;
      expect(await log()).toHaveLength(1);
      const wa2 = await worker('test-token', updatable);
      await waitFor(async () => (await log()).length === 0, 'the question is dropped');
      expect(notices()).not.toContain('Dispatch: worker default did not update');
      const t2 = step();
      await waitFor(() => wa2.asks().length === 1, 'the worker is asked again');
      wa2.answer({ state: 'started' });
      await t2;
      expect((await log())[0]).toMatchObject({ state: 'running', worker_name: 'default' });
      // this time it stopped for the update: back on its old commit, the update is not dropped
      await wa2.close();
      await online(0);
      await worker('test-token', updatable);
      await online(1);
      await new Promise((r) => setTimeout(r, 50));
      expect((await log())[0]).toMatchObject({ state: 'running' });
    });

    it('a worker that got work after its answer says "not now": nothing is logged, and it is asked again', async () => {
      const wa = await worker('test-token', updatable);
      await online(1);
      await autoOn(B);
      let t = step();
      await waitFor(() => wa.asks().length === 1, 'the worker is asked');
      wa.answer({ state: 'started' });
      await t;
      expect(await statuses()).toMatchObject({ default: 'updating' });
      wa.send({ t: 'update_result', update_id: 1, target: 'worker', ok: false, rolled_back: false, from: A, to: B, not_now: true, error: 'Work came in before the worker stopped.' });
      await waitFor(async () => (await log()).length === 0, 'the question is dropped');
      expect(notices()).not.toContain('Dispatch: worker default did not update');
      expect(await statuses()).toMatchObject({ default: 'behind' });
      // its sessions do not wait for an update any more
      const id = await work(wa);
      await status(wa, id, 'idle');
      t = step();
      await waitFor(() => wa.asks().length === 2, 'the worker is asked again');
      wa.answer({ state: 'busy', reasons: ['session 1 is working'] });
      await t;
    });

    it('a worker that was back on the new version and then did not hold: its result overrules the hello', async () => {
      const wa = await worker('test-token', updatable);
      await online(1);
      await autoOn(B);
      const t = step();
      await waitFor(() => wa.asks().length === 1, 'the worker is asked');
      wa.answer({ state: 'started' });
      await t;
      await wa.close();
      await online(0);
      const wa2 = await worker('test-token', { sha: B, updatable: true });
      await waitFor(async () => (await log())[0].state === 'ok', 'the hello on the new version');
      // it stops soon after its start: its launcher puts the old version back, and that one says so
      await wa2.close();
      await online(0);
      const wa3 = await worker('test-token', updatable);
      wa3.send({ t: 'update_result', update_id: 1, target: 'worker', ok: false, rolled_back: true, from: A, to: B, error: 'The worker stopped soon after its start.' });
      await waitFor(async () => (await log())[0].state === 'rolled_back', 'the result');
      expect((await log())[0].detail).toBe('The worker stopped soon after its start.');
      expect(notices()).toContain('Dispatch: worker default did not update');
      expect(await statuses()).toMatchObject({ default: 'failed' });
      // and it is not asked again by itself
      await step();
      expect(wa3.asks()).toEqual([]);
    });

    it('workers that cannot update themselves, or run the same version, are left alone', async () => {
      const wa = await worker('test-token', { sha: A, updatable: false, why: 'It was not started through the launcher (node src/launch.ts server|worker).' });
      const wb = await worker(b.secret, { sha: B, updatable: true });
      await online(2);
      await autoOn(B);
      await step();
      expect(wa.asks()).toEqual([]);
      expect(wb.asks()).toEqual([]);
      expect((await info()).workers).toEqual([
        { id: defaultId, name: 'default', connected: true, sha: A, updatable: false, why: 'It was not started through the launcher (node src/launch.ts server|worker).', status: 'behind' },
        { id: b.id, name: 'b', connected: true, sha: B, updatable: true, why: null, status: 'current' },
      ]);
      // nothing to update: "Update now" says so
      expect((await s.call('POST', '/update/start', {})).status).toBe(409);
    });

    it('workers take only a commit of the release branch: a server off it updates none', async () => {
      const wa = await worker('test-token', updatable);
      await online(1);
      await autoOn(sha('e'));
      await step();
      expect(wa.asks()).toEqual([]);
      expect((await info()).waiting).toEqual([`Workers are not updated: the server's commit (${'e'.repeat(7)}) is not known as one of main.`]);
    });

    it('with the server behind and not updatable, the workers still follow the commit the server runs', async () => {
      // the release branch: a, b, c. The server runs b and cannot update itself; the worker runs a.
      const wa = await worker('test-token', updatable);
      await online(1);
      await autoOn(B, [A, B, sha('c')]);
      const t = step();
      await waitFor(() => wa.asks().length === 1, 'the worker is asked');
      expect(wa.asks()[0].cmd).toMatchObject({ sha: B });
      wa.answer({ state: 'started' });
      await t;
      expect((await log())[0]).toMatchObject({ target: 'worker', to_sha: B });
    });
  });

  it('a server that just started after its update takes no worker until the launcher has seen it hold', async () => {
    const fresh = await startServer({ DISPATCH_SETTLE_MS: '600' });
    try {
      const early = new WebSocket(`ws://127.0.0.1:${fresh.port}/worker`, { headers: { 'x-worker-token': 'test-token' } });
      expect(await new Promise((r) => early.once('close', (code) => r(code)))).toBe(1013);
      // and no step of a rollout starts
      fresh.ctx.updates.launcher = { available: true, why: null, request: (req, ctx) => void asked.push({ req, ctx }), onResult() {}, ready() {} };
      fresh.ctx.updates.verify = s.ctx.updates.verify;
      fresh.ctx.version.sha = A;
      fresh.ctx.updates.source = fakeSource([A, B]);
      await fresh.ctx.updates.check();
      fresh.ctx.updates.setSettings({ auto: true });
      await fresh.ctx.updates.tick();
      expect(asked).toEqual([]);
      await new Promise((r) => setTimeout(r, 650));
      const late = await rawWorker(fresh.port, 'test-token');
      await waitFor(() => fresh.ctx.hub.connectedIds().length === 1, 'the worker is taken');
      await fresh.ctx.updates.tick();
      expect(asked).toHaveLength(1);
      await late.close();
    } finally {
      await fresh.app.close();
    }
  });

  it('a server that stops for its own update keeps a copy of its database; any other stop keeps none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-update-'));
    const dbFile = join(dir, 'dispatch.db');
    const boot = async () => {
      const cfg = loadConfig({ WORKER_TOKEN: 'test-token', DISABLE_AUTH: '1', WEB_DIST: '/nonexistent', DATA_DIR: dir, UPDATE_REPO: 'you/dispatch', UPDATE_POLL_MINUTES: '0' });
      const { app, ctx } = await buildApp(cfg, { dbFile });
      ctx.version.sha = A;
      ctx.updates.source = fakeSource([A, B]);
      ctx.updates.verify = s.ctx.updates.verify;
      ctx.updates.launcher = { available: true, why: null, request: (req, c) => void asked.push({ req, ctx: c }), onResult() {}, ready() {} };
      return { app, ctx };
    };
    try {
      let srv = await boot();
      await srv.app.close();
      expect(existsSync(`${dbFile}.pre-update`)).toBe(false);

      srv = await boot();
      await srv.ctx.updates.check();
      srv.ctx.updates.setSettings({ auto: true });
      await srv.ctx.updates.tick();
      expect(asked).toHaveLength(1);
      // the launcher stops the server
      await srv.app.close();
      expect(existsSync(`${dbFile}.pre-update`)).toBe(true);
      expect(JSON.parse(readFileSync(`${dbFile}.pre-update.json`, 'utf8'))).toMatchObject({ from: A, to: B });

      // the version that runs next has the update in its log, still running; its result drops the copy
      srv = await boot();
      expect(srv.ctx.updates.ownUpdate()).toMatchObject({ from_sha: A, to_sha: B, state: 'running' });
      srv.ctx.updates.onLauncherResult({ ok: false, rolled_back: true, from: A, to: B, error: 'It did not start.' }, { update_id: srv.ctx.updates.ownUpdate()!.id });
      expect(existsSync(`${dbFile}.pre-update`)).toBe(false);
      expect(srv.ctx.updates.rows()[0]).toMatchObject({ state: 'rolled_back' });
      await srv.app.close();
      expect(existsSync(`${dbFile}.pre-update`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an update that waits starts when the session ends its turn, not at the next tick', async () => {
    withLauncher();
    const w = await worker('test-token');
    await online(1);
    await autoOn(A);
    const id = await work(w);
    await s.ctx.updates.tick();
    expect(asked).toEqual([]);
    // the timed look is far away: only the session's own change can start the update
    s.ctx.updates.tickMs = 3_600_000;
    s.ctx.updates.start();
    await status(w, id, 'idle');
    await waitFor(() => asked.length, 'the update, soon after the turn');
    expect(asked[0].req).toEqual({ sha: B, from: A });
  });

  it('a row of the log has all an owner needs: who, from, to, how it ended', async () => {
    withLauncher();
    await autoOn(A, [A, B]);
    s.ctx.updates.source = fakeSource([A, B], [{ name: 'v1.1.0', sha: B }]);
    await s.call('POST', '/update/check');
    await s.call('POST', '/update/start', { target: 'tag' });
    await s.ctx.updates.tick();
    s.ctx.updates.onLauncherResult({ ok: true, rolled_back: false, from: A, to: B }, { update_id: 1 });
    const row: UpdateRow = (await log())[0];
    expect(row).toMatchObject({ target: 'server', triggered_by: OWNER, from_sha: A, to_sha: B, to_tag: 'v1.1.0', state: 'ok' });
    expect(Date.parse(row.ended_at!)).toBeGreaterThanOrEqual(Date.parse(row.created_at));
  });
});
