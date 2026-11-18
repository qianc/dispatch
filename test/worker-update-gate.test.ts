// DISP-112: a worker updates itself only in wait mode. What counts as work, and what the worker
// answers a server that asks.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { SelfUpdateAnswer, StartSpec, WorkerToServer } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS, type WorkerVersion } from '../src/shared/types.ts';
import { Refusal, type ApplyResult } from '../src/update/apply.ts';
import type { LauncherLink } from '../src/update/ipc.ts';
import { ClaudeRunner } from '../src/worker/runner.ts';
import { ServerLink, Slots } from '../src/worker/serverLink.ts';
import { UpdateGate, type GateDeps } from '../src/worker/updateGate.ts';
import { waitFor } from './helpers.ts';

const A = 'a'.repeat(40), B = 'b'.repeat(40);

const spec = (id: number, more: Partial<StartSpec> = {}): StartSpec => ({
  session_id: id, kind: 'work', project_key: 'GH', project_name: 'P', importance_scale: [], effort_scale: [], title: 't', branch: 'b', repos: [], items: [], source: null,
  prompt: 'go', force_plan: false, options: { ...DEFAULT_RUN_OPTIONS, model: 'opus' as const }, claude_account: null, github_account: null, resume: null, resume_note: null, ...more,
});

type Raw = { onMessage: (m: unknown) => Promise<void>; ws: unknown; outbox: WorkerToServer[]; stopped: boolean; paused: boolean };

/** A worker with a link per server name, a launcher that notes what it is asked, and a check of the commit that passes. */
function worker(names = ['home'], more: Partial<GateDeps> = {}, makeTitle?: () => Promise<string>) {
  const slots = new Slots(2);
  const version: WorkerVersion = { sha: A, updatable: true };
  const asked: { req: { sha: string; from: string | null }; ctx: unknown }[] = [];
  let result: (r: ApplyResult, ctx: unknown) => void = () => undefined;
  const launcher: LauncherLink = { available: true, why: null, request: (req, ctx) => void asked.push({ req, ctx }), onResult: (fn) => void (result = fn), ready: () => undefined };
  const verified: string[] = [];
  const sent: Record<string, WorkerToServer[]> = {};
  /** the servers the worker hung up on */
  const hungUp: string[] = [];
  const links: ServerLink[] = names.map((name) => {
    const link = new ServerLink({ name, url: 'ws://127.0.0.1:1/worker', token: 't', local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: null, releases: [], repo_env_dir: '/nonexistent' }, {
      fake: true, opts: { assistantReadDirs: [] } as never, workspacesDir: mkdtempSync(join(tmpdir(), 'dsp-gate-')), slots,
      claudeAccounts: () => [], githubAccounts: [], gitEnv: () => ({}), remoteBase: 'https://github.com', version, makeTitle,
      selfUpdate: (from, sha, id) => gate.selfUpdate(from, sha, id),
    });
    sent[name] = [];
    (link as unknown as Raw).ws = { readyState: WebSocket.OPEN, send: (d: string) => sent[name].push(JSON.parse(d)), close: () => void hungUp.push(name) };
    made.push(link);
    return link;
  });
  slots.links = links;
  const gate = new UpdateGate({
    links: () => links, slots, launcher, version, dir: '/nonexistent', branch: 'main', delayMs: 1,
    verify: async (req) => {
      verified.push(req.sha);
      return { head: A, attached: true, moves: true };
    },
    ...more,
  });
  const msg = (m: unknown, name = names[0]) => (links[names.indexOf(name)] as unknown as Raw).onMessage(m);
  /** what the server gets when it asks */
  const ask = async (sha = B, name = names[0], id = 5): Promise<SelfUpdateAnswer> => {
    await msg({ t: 'cmd', req_id: `r${id}`, cmd: { c: 'self_update', sha, update_id: id } }, name);
    const r = sent[name].findLast((m) => m.t === 'cmd_result' && m.req_id === `r${id}`) as { ok: boolean; data: SelfUpdateAnswer };
    expect(r.ok).toBe(true);
    return r.data;
  };
  return { slots, links, gate, asked, sent, hungUp, verified, msg, ask, launcher, result: (r: ApplyResult, ctx: unknown) => result(r, ctx) };
}

const made: ServerLink[] = [];
const connected = (l: ServerLink) => (l as unknown as Raw).ws !== null;

beforeEach(() => {
  process.env.FAKE_DELAY_MS = '40';
});

afterEach(() => {
  // a link that was told to connect again (after a refused update) must not go on trying
  for (const l of made.splice(0)) (l as unknown as Raw).stopped = true;
});

test('in wait mode the worker takes the update: no slot is free from then, it hangs up on its servers, and the launcher is asked', async () => {
  const w = worker(['home', 'office'], { delayMs: 150 });
  expect(await w.ask()).toEqual({ state: 'started' });
  expect(w.verified).toEqual([B]);
  expect(w.slots.free).toBe(0);
  expect(w.sent.home).toContainEqual({ t: 'slots', free: 0 });
  expect(w.sent.office).toContainEqual({ t: 'slots', free: 0 });
  // a start that comes before it stopped is not taken
  await w.msg({ t: 'start', spec: spec(9) });
  expect(w.sent.home.at(-1)).toEqual({ t: 'refused', session_id: 9, reason: 'busy' });
  // a second server that asks meanwhile
  expect(await w.ask(B, 'office', 6)).toEqual({ state: 'busy', reasons: ['it is updating already'] });
  expect(w.asked).toEqual([]);
  await waitFor(() => w.asked.length, 'the request to the launcher');
  // only the commit goes to the launcher, with which server asked
  expect(w.asked).toEqual([{ req: { sha: B, from: A }, ctx: { server: 'home', update_id: 5 } }]);
  // no server reaches the worker from here: nothing can start that the stop would cut off
  expect(w.hungUp).toEqual(['home', 'office']);
  expect(w.links.map(connected)).toEqual([false, false]);
  expect(w.links.map((l) => (l as unknown as Raw).paused)).toEqual([true, true]);
  // the launcher refused (another update holds the checkout): the same process connects again and takes work.
  // Its result waits for the server that asked.
  w.result({ ok: false, from: A, to: B, rolled_back: false, error: 'Another update is running in this checkout.' }, { server: 'home', update_id: 5 });
  expect(w.links.map((l) => (l as unknown as Raw).paused)).toEqual([false, false]);
  expect(w.slots.free).toBe(2);
  expect((w.links[0] as unknown as Raw).outbox).toEqual([{ t: 'update_result', update_id: 5, target: 'worker', ok: false, rolled_back: false, from: A, to: B, error: 'Another update is running in this checkout.' }]);
  expect((w.links[1] as unknown as Raw).outbox).toEqual([]);
});

test('work that comes in between the answer and the stop: the worker does not stop, and says "not now"', async () => {
  const w = worker(['home', 'office'], { delayMs: 100 });
  expect(await w.ask()).toEqual({ state: 'started' });
  // a chat takes no slot, so the closed slots do not refuse it
  await w.msg({ t: 'start', spec: spec(4, { kind: 'assistant', branch: null }) }, 'office');
  await waitFor(() => w.sent.home.find((m) => m.t === 'update_result'), 'the worker to say it did not stop');
  expect(w.sent.home.find((m) => m.t === 'update_result')).toEqual({ t: 'update_result', update_id: 5, target: 'worker', ok: false, rolled_back: false, from: A, to: B, not_now: true, error: 'Work came in before the worker stopped.' });
  expect(w.asked).toEqual([]);
  expect(w.hungUp).toEqual([]);
  expect(w.slots.free).toBe(2);
  expect(w.sent.home.findLast((m) => m.t === 'slots')).toEqual({ t: 'slots', free: 2 });
  expect(w.links.map(connected)).toEqual([true, true]);
});

test('a session that works, or waits for an answer, holds the update back; one at the end of its turn does not', async () => {
  const w = worker();
  await w.msg({ t: 'start', spec: spec(7) });
  expect(await w.ask()).toEqual({ state: 'busy', reasons: ['session 7 is working'] });
  // the fake session asks its first question
  const q = await waitFor(() => w.sent.home.find((m) => m.t === 'input_request'), 'the question') as Extract<WorkerToServer, { t: 'input_request' }>;
  expect(await w.ask()).toEqual({ state: 'busy', reasons: ['session 7 waits for an answer'] });
  expect(w.verified).toEqual([]);
  expect(w.slots.free).toBe(1);
  await w.msg({ t: 'answer', session_id: 7, local_id: q.local_id, answer: { kind: 'question', answers: { q: 'Small fix' } } });
  expect((await w.ask()).state).toBe('busy');
  await waitFor(() => w.sent.home.find((m) => m.t === 'status' && m.status === 'idle'), 'the end of the turn');
  // its runner still lives (the session is idle): nothing is cut off
  expect(await w.ask()).toEqual({ state: 'started' });
  expect(w.asked).toEqual([]);
  await waitFor(() => w.asked.length, 'the request to the launcher');
});

test('work for another server holds it back too, and is told only as that', async () => {
  const w = worker(['home', 'office']);
  await w.msg({ t: 'start', spec: spec(3) }, 'office');
  expect(await w.ask(B, 'home')).toEqual({ state: 'busy', reasons: ['it works for another server'] });
  expect(await w.ask(B, 'office', 6)).toEqual({ state: 'busy', reasons: ['session 3 is working'] });
});

test('a command that runs, and a result that waits for its server, hold it back', async () => {
  let done: (title: string) => void = () => undefined;
  const w = worker(['home'], {}, () => new Promise<string>((r) => (done = r)));
  const cmd = w.msg({ t: 'cmd', req_id: 'c1', cmd: { c: 'make_title', goal: 'g', projects: [], account: null } });
  expect(await w.ask()).toEqual({ state: 'busy', reasons: ['a command runs (make_title)'] });
  done('A title');
  await cmd;
  expect(w.links[0].busyReasons()).toEqual([]);
  // the server is away: what the worker has for it is only in memory
  (w.links[0] as unknown as Raw).ws = null;
  w.links[0].send({ t: 'deploy_result', session_id: 1, repo_id: 1, ok: true, sha: null, output: '', duration_ms: 1 });
  expect(w.links[0].busyReasons()).toEqual(['1 message for the server waits to be sent']);
});

test('a commit that is not one of the release branch is refused, and the worker takes work again', async () => {
  const w = worker(['home'], { verify: async () => { throw new Refusal('refused', 'This commit is not on origin/main.'); } });
  expect(await w.ask()).toEqual({ state: 'refused', reason: 'This commit is not on origin/main.' });
  expect(w.slots.free).toBe(2);
  expect(w.sent.home.filter((m) => m.t === 'slots')).toEqual([{ t: 'slots', free: 0 }, { t: 'slots', free: 2 }]);
  expect(w.asked).toEqual([]);
  // the commit it runs, or an older one: nothing to do
  const past = worker(['home'], { verify: async () => { throw new Refusal('ahead', 'The checkout is already past this commit.'); } });
  expect(await past.ask()).toEqual({ state: 'ahead' });
  expect(await past.ask(A)).toEqual({ state: 'ahead' });
  expect(past.slots.free).toBe(2);
});

test('a worker without a launcher says why it cannot', async () => {
  const w = worker(['home'], { launcher: { available: false, why: 'It was not started through the launcher.', request: () => { throw new Error('never'); }, onResult: () => undefined, ready: () => undefined } });
  expect(await w.ask()).toEqual({ state: 'refused', reason: 'It was not started through the launcher.' });
});

test('a chat that starts while the commit is checked holds the update back after all', async () => {
  const w: ReturnType<typeof worker> = worker(['home'], {
    verify: async () => {
      // chats take no slot, so the closed slots do not stop one
      await w.msg({ t: 'start', spec: spec(4, { kind: 'assistant', branch: null }) });
      return { head: A, attached: true, moves: true };
    },
  });
  expect(await w.ask()).toEqual({ state: 'busy', reasons: ['session 4 is working'] });
  expect(w.slots.free).toBe(2);
  expect(w.asked).toEqual([]);
});

test('how the update ended goes to the server that asked, also when it is not there yet', async () => {
  const w = worker(['home', 'office']);
  expect(await w.ask(B, 'office', 8)).toEqual({ state: 'started' });
  // the launcher refused before it stopped anything: the same process hears it
  w.result({ ok: false, from: A, to: B, rolled_back: false, error: 'Another update is running in this checkout.' }, { server: 'office', update_id: 8 });
  expect(w.sent.office.at(-1)).toEqual({ t: 'update_result', update_id: 8, target: 'worker', ok: false, rolled_back: false, from: A, to: B, error: 'Another update is running in this checkout.' });
  expect(w.slots.free).toBe(2);
  expect(w.sent.home.find((m) => m.t === 'update_result')).toBeUndefined();
  // the new version's process: its links are not up yet when the launcher tells the result
  const next = worker(['home']);
  (next.links[0] as unknown as Raw).ws = null;
  next.result({ ok: true, from: A, to: B, rolled_back: false, log_tail: 'runs bbbbbbb' }, { server: 'home', update_id: 5 });
  expect((next.links[0] as unknown as Raw).outbox).toEqual([{ t: 'update_result', update_id: 5, target: 'worker', ok: true, rolled_back: false, from: A, to: B, log_tail: 'runs bbbbbbb' }]);
  // a result for a server this worker no longer serves is dropped
  next.result({ ok: true, from: A, to: B, rolled_back: false }, { server: 'gone', update_id: 1 });
  expect((next.links[0] as unknown as Raw).outbox).toHaveLength(1);
});

test('what a Claude session does, as the gate sees it', () => {
  const r = new ClaudeRunner(spec(1), { emit: () => undefined, rpc: async () => null, cwd: '/tmp', onClosed: () => undefined }, { assistantReadDirs: [] } as never);
  const state = r as unknown as { betweenTurns: boolean; bgTasks: number; bgIdleTimer: NodeJS.Timeout | null; wakeAt: number; waiting: Map<string, unknown>; limitTimer: NodeJS.Timeout | null; closed: boolean };
  expect(r.activity()).toBe('is working');
  state.betweenTurns = true;
  expect(r.activity()).toBeNull();
  state.waiting.set('q', () => undefined);
  expect(r.activity()).toBe('waits for an answer');
  state.waiting.clear();
  state.bgTasks = 1;
  expect(r.activity()).toBe('has background tasks running');
  state.bgTasks = 0;
  // the tasks ended: Claude starts a turn on that news in a moment
  state.bgIdleTimer = setTimeout(() => undefined, 0);
  expect(r.activity()).toBe('has background tasks that just ended');
  clearTimeout(state.bgIdleTimer);
  state.bgIdleTimer = null;
  state.wakeAt = Date.now() + 60_000;
  expect(r.activity()).toBe('has a wake-up set');
  // its time came: the turn it starts shows a moment later
  state.wakeAt = Date.now() - 1000;
  expect(r.activity()).toBe('has a wake-up set');
  state.wakeAt = Date.now() - 61_000;
  expect(r.activity()).toBeNull();
  // the wait for the usage limit: the session waits again after a restart
  state.limitTimer = setTimeout(() => undefined, 0);
  expect(r.activity()).toBeNull();
  clearTimeout(state.limitTimer);
  state.limitTimer = null;
  state.betweenTurns = false;
  state.closed = true;
  expect(r.activity()).toBeNull();
});
