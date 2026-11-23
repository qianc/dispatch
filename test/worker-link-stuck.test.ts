// DISP-239 #26, DISP-248 #87, #88, #89: the worker's side of sessions that stayed running for good.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerToServer } from '../src/shared/protocol.ts';
import type { Repo } from '../src/shared/types.ts';
import { ServerLink, Slots } from '../src/worker/serverLink.ts';
import { Workspaces } from '../src/worker/workspace.ts';
import { waitFor } from './helpers.ts';

describe('the worker link', () => {
  let wss: WebSocketServer | null = null;
  let link: ServerLink | null = null;
  afterEach(async () => {
    link?.closeAll();
    link = null;
    for (const c of wss?.clients ?? []) c.terminate();
    await new Promise((r) => (wss ? wss.close(r) : r(null)));
    wss = null;
  });

  const serve = async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss!.once('listening', r));
    return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/worker`;
  };
  const make = (url: string) => new ServerLink(
    { name: 'home', url, token: 't', local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: null, releases: [], repo_env_dir: '/nonexistent' },
    { fake: true, opts: { assistantReadDirs: [] } as never, workspacesDir: mkdtempSync(join(tmpdir(), 'dsp-stuck-')), slots: new Slots(2), claudeAccounts: () => [], githubAccounts: [], gitEnv: () => ({}), remoteBase: 'https://github.com' },
  );

  it('#26: the hello names the questions its runners still wait on', async () => {
    const url = await serve();
    const hellos: Extract<WorkerToServer, { t: 'hello' }>[] = [];
    wss!.on('connection', (ws) => ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as WorkerToServer;
      if (m.t === 'hello') hellos.push(m);
    }));
    link = make(url);
    const runners = (link as unknown as { runners: Map<number, unknown> }).runners;
    runners.set(5, { waitingOn: () => ['loc-1'], activity: () => 'waits for an answer', close: () => undefined });
    link.connect(50);
    await waitFor(() => hellos.length === 1, 'hello');
    expect(hellos[0]).toMatchObject({ live: [5], waiting: ['loc-1'] });
  });

  it('#88: screenshots stay out of the outbox while the server is away', () => {
    link = make('ws://127.0.0.1:1/worker');
    link.send({ t: 'event', session_id: 5, body: { kind: 'tool_result', tool_use_id: 'x', is_error: false, text: 'shot' }, images: [{ media_type: 'image/png', data: 'A'.repeat(1000) }] });
    expect((link as unknown as { outbox: WorkerToServer[] }).outbox).toEqual([{ t: 'event', session_id: 5, body: { kind: 'tool_result', tool_use_id: 'x', is_error: false, text: 'shot' } }]);
  });

  it('#87: a link that drops at once backs off instead of starting over at 1 s', async () => {
    const url = await serve();
    const at: number[] = [];
    wss!.on('connection', (ws) => (at.push(Date.now()), ws.close(1011)));
    link = make(url);
    link.connect(50);
    // 50, 100, 200, 400 ms apart; starting over on each open would wait 1 s every time
    await waitFor(() => at.length >= 4, 'four tries', 2000);
    expect(at[3] - at[2]).toBeGreaterThan(at[2] - at[1]);
  });

  it('#87: a link the server replaced (another worker with this token) waits long', async () => {
    const url = await serve();
    let n = 0;
    wss!.on('connection', (ws) => (n++, ws.close(4000, 'replaced by a new worker connection')));
    link = make(url);
    link.replacedMs = 60_000;
    link.connect(50);
    await waitFor(() => n === 1, 'first connection');
    await new Promise((r) => setTimeout(r, 1500));
    expect(n).toBe(1);
  });
});

describe('#89: isAttached when the owner\'s repo is itself a linked worktree', () => {
  it('compares the git dir both share, not paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsp-attached-'));
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    const main = join(root, 'main');
    execFileSync('git', ['init', '-q', main]);
    git(main, 'commit', '-q', '--allow-empty', '-m', 'x');
    // the owner works in a linked worktree of their repo, and set that as the local path
    git(main, 'worktree', 'add', '-q', '-b', 'side', join(root, 'owner'));
    git(join(root, 'owner'), 'worktree', 'add', '-q', '-b', 'session', join(root, 'wt'));
    git(root, 'clone', '-q', main, join(root, 'clone'));
    git(join(root, 'clone'), 'worktree', 'add', '-q', '-b', 'other', join(root, 'clone-wt'));
    const repo = { local_path: join(root, 'owner') } as Repo;
    expect(Workspaces.isAttached(join(root, 'wt'), repo)).toBe(true);
    expect(Workspaces.isAttached(join(root, 'clone-wt'), repo)).toBe(false);
    expect(Workspaces.isAttached(join(root, 'missing'), repo)).toBe(false);
  });
});
