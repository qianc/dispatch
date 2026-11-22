// DISP-193 #1: an orchestrator closed while its scope restart tidies its old checkouts stays closed:
// the restart does not start a runner (and a turn) for it afterwards. DISP-220: messages during the
// tidy keep their order, and a close and a new start during it get none of the old text.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import type { StartSpec, WorkerToServer } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import { FakeRunner } from '../src/worker/fakeRunner.ts';
import { Secrets } from '../src/worker/secrets.ts';
import { ServerLink, Slots } from '../src/worker/serverLink.ts';
import { waitFor } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

/** An orchestrator after its first turn, whose next scope restart waits in its tidy until `tidied()`. */
async function restarting() {
  const entry = { name: 'default', url: 'ws://127.0.0.1:1/worker', token: 'dsw_t', local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: [], releases: [], repo_env_dir: '/nonexistent' };
  const link = new ServerLink(entry, {
    fake: true, opts: { assistantReadDirs: [] } as never,
    workspacesDir: mkdtempSync(join(tmpdir(), 'dsp-osc-ws-')), slots: new Slots(2),
    claudeAccounts: () => [], githubAccounts: [], remoteBase: 'file:///nonexistent', secrets: new Secrets(), gitEnv: () => ({}),
  });
  const sent: WorkerToServer[] = [];
  const priv = link as unknown as {
    ws: unknown; runners: Map<number, unknown>;
    onMessage: (m: unknown) => Promise<void>;
    dropCheckouts: (...a: unknown[]) => Promise<void>;
  };
  priv.ws = { readyState: WebSocket.OPEN, send: (d: string) => sent.push(JSON.parse(d)) };
  process.env.FAKE_DELAY_MS = '1';
  const project = (key: string) => ({ key, name: key, importance_scale: ['Low'], effort_scale: ['S'], repos: [] });
  const spec = (keys: string[], resume: string | null): StartSpec => ({
    session_id: 9, kind: 'orchestrator', project_key: '', project_name: '', importance_scale: [], effort_scale: [], title: 'Goal', branch: null,
    repos: [], items: [], source: null, prompt: '[fake:env]', force_plan: false, options: { ...DEFAULT_RUN_OPTIONS, model: 'opus' }, claude_account: null,
    github_account: null, resume, resume_note: null,
    orchestration: { goal: 'Goal', phase: 'plan', projects: keys.map(project), max_children: 2, status_md: 'No plan yet.' },
  });
  await priv.onMessage({ t: 'start', spec: spec(['AA'], null) });
  await waitFor(() => sent.some((m) => m.t === 'status' && m.status === 'idle'), 'first turn');

  // what each runner is given, in order
  const given: string[] = [];
  vi.spyOn(FakeRunner.prototype, 'start').mockImplementation((t: string) => void given.push(`start: ${t}`));
  vi.spyOn(FakeRunner.prototype, 'push').mockImplementation((t: string) => void given.push(`push: ${t}`));
  // the old checkouts' tidy takes a while
  let tidied!: () => void;
  priv.dropCheckouts = () => new Promise<void>((r) => (tidied = r));
  const send = (text: string) => priv.onMessage({ t: 'send', session_id: 9, text, spec: spec(['AA', 'BB'], 'sdk-9') });
  const restart = send('scope changed');
  await waitFor(() => tidied, 'the tidy');
  return { priv, sent, given, spec, send, restart, tidied };
}

it('a close during the scope restart starts no runner', async () => {
  const { priv, sent, restart, tidied } = await restarting();
  const runs = sent.filter((m) => m.t === 'status' && m.status === 'running').length;
  await priv.onMessage({ t: 'close', session_id: 9 });
  tidied();
  await restart;
  await new Promise((r) => setTimeout(r, 50));
  expect(priv.runners.has(9)).toBe(false);
  expect(sent.filter((m) => m.t === 'status' && m.status === 'running')).toHaveLength(runs);
});

it('a message during the scope restart comes after the one that restarted it (DISP-220)', async () => {
  const { priv, given, send, restart, tidied } = await restarting();
  await send('second');
  expect(given).toEqual([]);
  tidied();
  await restart;
  await waitFor(() => given.length === 2, 'both messages');
  expect(given).toEqual(['start: scope changed', 'push: second']);
  expect(priv.runners.has(9)).toBe(true);
});

it('a close and a new start during the scope restart: the new session gets none of the old text (DISP-220)', async () => {
  const { priv, given, spec, restart, tidied } = await restarting();
  await priv.onMessage({ t: 'close', session_id: 9 });
  await priv.onMessage({ t: 'start', spec: { ...spec(['AA', 'BB'], null), prompt: 'new start' } });
  await waitFor(() => given.length === 1, 'the new start');
  tidied();
  await restart;
  await new Promise((r) => setTimeout(r, 50));
  expect(given).toEqual(['start: new start']);
});
