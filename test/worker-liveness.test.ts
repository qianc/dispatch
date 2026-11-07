// A worker whose server goes quiet (laptop asleep, NAT entry gone) must notice and reconnect.
// The server pings every 20 s and drops a worker that does not answer; without a check on the
// worker side its half-open socket stays "connected" forever and the worker never comes back.
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { ServerLink, Slots } from '../src/worker/serverLink.ts';
import { waitFor } from './helpers.ts';

let wss: WebSocketServer | null = null;
let link: ServerLink | null = null;
afterEach(async () => {
  link?.closeAll();
  for (const c of wss?.clients ?? []) c.terminate();
  await new Promise((r) => wss?.close(r));
});

function linkTo(url: string) {
  const entry = { name: 'home', url, token: 't', local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: null, releases: [], repo_env_dir: '/nonexistent' };
  return new ServerLink(entry, {
    fake: true, opts: { assistantReadDirs: [] } as never, workspacesDir: '/tmp/dsp-live-ws', first: true, slots: new Slots(1),
    claudeAccounts: () => [], githubAccounts: [], gitEnv: () => ({}), remoteBase: 'https://github.com',
  });
}

it('reconnects when the server sends nothing (no ping) for the silence window', async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss!.once('listening', r));
  let connections = 0;
  wss.on('connection', () => connections++); // accepts, then never pings or sends
  link = linkTo(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/worker`);
  link.silenceMs = 300;
  link.connect(50);
  await waitFor(() => connections >= 2, "a reconnect", 5000);
});

it('stays connected while the server keeps pinging', async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss!.once('listening', r));
  let connections = 0;
  wss.on('connection', (ws) => {
    connections++;
    const beat = setInterval(() => ws.ping(), 100);
    ws.on('close', () => clearInterval(beat));
  });
  link = linkTo(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/worker`);
  link.silenceMs = 300;
  link.connect(50);
  await waitFor(() => connections === 1, "the first connection", 2000);
  await new Promise((r) => setTimeout(r, 1000));
  expect(connections).toBe(1);
});
