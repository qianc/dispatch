// DISP-193 #1: an orchestrator closed while its scope restart tidies its old checkouts stays closed:
// the restart does not start a runner (and a turn) for it afterwards.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import type { StartSpec, WorkerToServer } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import { Secrets } from '../src/worker/secrets.ts';
import { ServerLink, Slots } from '../src/worker/serverLink.ts';
import { waitFor } from './helpers.ts';

it('a close during the scope restart starts no runner', async () => {
  const entry = { name: 'default', url: 'ws://127.0.0.1:1/worker', token: 'dsw_t', local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: [], releases: [], repo_env_dir: '/nonexistent' };
  const link = new ServerLink(entry, {
    fake: true, opts: { assistantReadDirs: [] } as never,
    workspacesDir: mkdtempSync(join(tmpdir(), 'dsp-osc-ws-')), slots: new Slots(2),
    claudeAccounts: () => [], githubAccounts: [], secrets: new Secrets(),
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

  // the old checkouts' tidy takes a while; the close arrives meanwhile
  let tidied!: () => void;
  priv.dropCheckouts = () => new Promise<void>((r) => (tidied = r));
  const restart = priv.onMessage({ t: 'send', session_id: 9, text: '[fake:env] scope changed', spec: spec(['AA', 'BB'], 'sdk-9') });
  await waitFor(() => tidied, 'the tidy');
  const runs = sent.filter((m) => m.t === 'status' && m.status === 'running').length;
  await priv.onMessage({ t: 'close', session_id: 9 });
  tidied();
  await restart;
  await new Promise((r) => setTimeout(r, 50));
  expect(priv.runners.has(9)).toBe(false);
  expect(sent.filter((m) => m.t === 'status' && m.status === 'running')).toHaveLength(runs);
});
