// The worker's link keeps order on a reconnect (DISP-141) and lets a close during setup end the
// start (DISP-146).
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, expect, it } from 'vitest';
import type { StartSpec, WorkerToServer } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS, type WorkerFacts } from '../src/shared/types.ts';
import { ServerLink, Slots } from '../src/worker/serverLink.ts';
import { waitFor } from './helpers.ts';

let wss: WebSocketServer | null = null;
let link: ServerLink | null = null;
afterEach(async () => {
  link?.closeAll();
  link = null;
  for (const c of wss?.clients ?? []) c.terminate();
  await new Promise((r) => (wss ? wss.close(r) : r(null)));
  wss = null;
});

function linkTo(url: string, fake: boolean, slots = new Slots(1)) {
  const entry = { name: 'home', url, token: 't', local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: null, releases: [], repo_env_dir: '/nonexistent' };
  return new ServerLink(entry, {
    fake, opts: { assistantReadDirs: [] } as never, workspacesDir: mkdtempSync(join(tmpdir(), 'dsp-order-')), slots,
    claudeAccounts: () => [], githubAccounts: [], gitEnv: () => ({}), remoteBase: 'https://github.com',
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const event = (n: number): WorkerToServer => ({ t: 'event', session_id: 1, body: { kind: 'system', text: `e${n}` } });

it('sends the hello and the queued outbox before a message made while the facts are gathered (DISP-141)', async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss!.once('listening', r));
  const got: WorkerToServer[] = [];
  wss.on('connection', (ws) => ws.on('message', (d) => got.push(JSON.parse(String(d)))));
  link = linkTo(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/worker`, true);
  // the link is down: these wait in the outbox
  for (let n = 1; n <= 3; n++) link.send(event(n));
  const facts = deferred<void>();
  const real = link.facts.bind(link);
  let asked = false;
  link.facts = async (): Promise<WorkerFacts> => {
    asked = true;
    await facts.promise;
    return real();
  };
  link.connect(50);
  await waitFor(() => asked, 'the facts are asked for');
  link.send(event(4)); // made while the facts are gathered
  await new Promise((r) => setTimeout(r, 100));
  expect(got).toEqual([]);
  facts.resolve();
  await waitFor(() => got.length >= 5, 'hello and four events');
  expect(got.map((m) => (m.t === 'event' ? (m.body as { text: string }).text : m.t))).toEqual(['hello', 'e1', 'e2', 'e3', 'e4']);
});

it('drops a connection paused while the facts are gathered, and says nothing on it (DISP-141)', async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss!.once('listening', r));
  const got: WorkerToServer[] = [];
  let closed = false;
  wss.on('connection', (ws) => {
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    ws.on('close', () => (closed = true));
  });
  link = linkTo(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/worker`, true);
  const facts = deferred<void>();
  const real = link.facts.bind(link);
  let asked = false;
  link.facts = async (): Promise<WorkerFacts> => {
    asked = true;
    await facts.promise;
    return real();
  };
  link.connect(50);
  await waitFor(() => asked, 'the facts are asked for');
  link.pause();
  link.send(event(1));
  facts.resolve();
  await waitFor(() => closed, 'the connection is closed');
  expect(got).toEqual([]);
});

it('starts no runner when the session is closed during its setup (DISP-146)', async () => {
  const slots = new Slots(1);
  link = linkTo('ws://127.0.0.1:1/worker', false, slots);
  const sent: WorkerToServer[] = [];
  (link as unknown as { ws: unknown }).ws = { readyState: WebSocket.OPEN, send: (d: string) => sent.push(JSON.parse(d)) };
  const repo = { id: 1, github_name: 'r', setup_command: 'npm ci' } as StartSpec['repos'][number];
  const setup = deferred<{ ok: boolean; copied: string[]; output: string }>();
  let setupStarted = false;
  const ws = link.workspaces as unknown as Record<string, unknown>;
  ws.prepare = async (_spec: StartSpec, created: { repo: typeof repo; wt: string }[]) => {
    created.push({ repo, wt: '/tmp/wt' });
    return '/tmp/wt';
  };
  ws.repoDir = () => '/tmp/wt';
  ws.prepareTree = () => {
    setupStarted = true;
    return setup.promise;
  };
  const spec: StartSpec = { session_id: 9, kind: 'work', project_key: 'OR', project_name: 'P', importance_scale: [], effort_scale: [], title: 't', branch: 'b', repos: [repo], items: [], source: null, prompt: 'go', force_plan: false, options: { ...DEFAULT_RUN_OPTIONS, model: 'opus' }, claude_account: null, github_account: null, resume: null, resume_note: null };
  const onMessage = (link as unknown as { onMessage: (m: unknown) => Promise<void> }).onMessage.bind(link);
  const started = onMessage({ t: 'start', spec });
  await waitFor(() => setupStarted, 'the setup runs');
  expect(slots.free).toBe(0);
  await onMessage({ t: 'close', session_id: 9, cleanup: false, repos: [] });
  setup.resolve({ ok: true, copied: [], output: '' });
  await started;
  expect((link as unknown as { runners: Map<number, unknown> }).runners.size).toBe(0);
  expect((link as unknown as { starting: Map<number, unknown> }).starting.size).toBe(0);
  expect(slots.free).toBe(1);
  // nothing more is said for the closed session: no "setup done", no failure
  expect(sent.filter((m) => m.t === 'event').map((m) => (m as { body: { text: string } }).body.text)).toEqual(['Setting up r: npm ci']);
  expect(sent.find((m) => m.t === 'status')).toBeUndefined();
});
