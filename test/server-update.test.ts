// DISP-112: a server that runs as an image is updated by a worker, with the worker's own command.
// What the command gets, when the old commit is put back, and that the result reaches the server
// that restarted.
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, expect, test } from 'vitest';
import type { ServerToWorker, WorkerToServer } from '../src/shared/protocol.ts';
import { ServerLink, Slots, type LinkShared } from '../src/worker/serverLink.ts';
import { runServerUpdate, runShell, type CommandRun, type ServerUpdateOptions } from '../src/worker/serverUpdate.ts';
import { waitFor } from './helpers.ts';

const A = 'a'.repeat(40), B = 'b'.repeat(40);

/** A server that is on `on`, and a command that notes its environment and does `then`. */
function fixture(then: (env: NodeJS.ProcessEnv, n: number) => Partial<CommandRun> | void, more: Partial<ServerUpdateOptions> = {}) {
  const state = { on: A as string | null };
  const runs: Record<string, string | undefined>[] = [];
  const opts: ServerUpdateOptions = {
    branch: 'main', timeoutMs: 60_000, healthMs: 60, pollMs: 5, env: { PATH: '/bin' },
    run: async (command, env) => {
      runs.push({ command, sha: env.DISPATCH_UPDATE_SHA, prev: env.DISPATCH_UPDATE_PREV, branch: env.DISPATCH_UPDATE_BRANCH, rollback: env.DISPATCH_UPDATE_ROLLBACK, path: env.PATH });
      return { code: 0, out: 'done', timed_out: false, ...then(env, runs.length) };
    },
    ...more,
  };
  const update = (sha = B, prev: string | null = A) => runServerUpdate({ command: './deploy.sh', sha, prev, serverVersion: () => state.on }, opts);
  return { state, runs, update };
}

test('the command gets the commit, and the update holds when the server comes back on it', async () => {
  const f = fixture((env) => void (f.state.on = env.DISPATCH_UPDATE_SHA!));
  const r = await f.update();
  expect(r).toMatchObject({ ok: true, rolled_back: false });
  expect(f.runs).toEqual([{ command: './deploy.sh', sha: B, prev: A, branch: 'main', rollback: undefined, path: '/bin' }]);
  expect(r.log_tail).toContain(`DISPATCH_UPDATE_SHA=${B} ./deploy.sh`);
});

test('a server that already runs the commit is left alone', async () => {
  const f = fixture(() => undefined);
  f.state.on = B;
  expect(await f.update()).toEqual({ ok: true, rolled_back: false });
  expect(f.runs).toEqual([]);
});

test('the command fails: it runs again with the commit from before, and the server is back on it', async () => {
  const f = fixture((env, n) => {
    if (n === 1) return { code: 3, out: 'no such image' };
    f.state.on = env.DISPATCH_UPDATE_SHA!;
  });
  f.state.on = null; // the first run took the server down
  const r = await f.update();
  expect(r).toMatchObject({ ok: false, rolled_back: true });
  expect(r.error).toBe('The update command failed (exit 3). The server runs aaaaaaa again.');
  expect(f.runs.map((x) => [x.sha, x.prev, x.rollback])).toEqual([[B, A, undefined], [A, B, '1']]);
  expect(r.log_tail).toContain('no such image');
  expect(r.log_tail).toContain(`DISPATCH_UPDATE_ROLLBACK=1 DISPATCH_UPDATE_SHA=${A}`);
});

test('the server never comes back on the commit: the command runs again with the commit from before', async () => {
  const f = fixture((env, n) => {
    // the new version does not start; the old one does
    f.state.on = n === 1 ? null : env.DISPATCH_UPDATE_SHA!;
  });
  const r = await f.update();
  expect(r).toMatchObject({ ok: false, rolled_back: true });
  expect(r.error).toBe('The update command ended well, but the server did not come back on bbbbbbb within 1 minute (it is not connected). The server runs aaaaaaa again.');
  expect(f.runs.map((x) => x.sha)).toEqual([B, A]);
});

test('a server that stays on the old commit is said so, and the command still runs for the way back', async () => {
  const f = fixture(() => undefined);
  const r = await f.update();
  expect(r).toMatchObject({ ok: false, rolled_back: true });
  expect(r.error).toContain('(it runs aaaaaaa)');
  expect(f.runs.map((x) => x.sha)).toEqual([B, A]);
});

test('the way back fails too: said plainly, and not as put back', async () => {
  const f = fixture((_env, n) => (n === 1 ? { code: 1 } : { code: null, timed_out: true }));
  f.state.on = null;
  const r = await f.update();
  expect(r).toMatchObject({ ok: false, rolled_back: false });
  expect(r.error).toBe('The update command failed (exit 1). The command for the way back to aaaaaaa did not end within 1 minute.');
  const g = fixture((_env, n) => (n === 1 ? { code: 1 } : {}));
  g.state.on = null;
  expect((await g.update()).error).toBe('The update command failed (exit 1). The command ran again for aaaaaaa, but the server did not come back on it.');
});

test('without the commit from before, nothing is put back', async () => {
  const f = fixture(() => ({ code: 1 }));
  const r = await f.update(B, null);
  expect(r).toMatchObject({ ok: false, rolled_back: false });
  expect(r.error).toMatch(/nothing was put back/);
  expect(f.runs).toHaveLength(1);
  expect(f.runs[0].prev).toBe('');
});

test('only a full commit id reaches the command, and only one the worker finds on the release branch', async () => {
  const f = fixture(() => undefined);
  for (const bad of ['main', 'v1.2.0', 'https://example.com/x.git', `${B}; rm -rf /`, B.slice(0, 12), '$(id)']) {
    expect(await f.update(bad)).toEqual({ ok: false, rolled_back: false, error: 'An update needs a full commit id (40 hex characters).' });
  }
  // a commit from before that is no commit id is not used either
  const g = fixture(() => ({ code: 1 }));
  expect((await g.update(B, 'x; reboot')).error).toMatch(/nothing was put back/);
  expect(g.runs).toHaveLength(1);
  const h = fixture(() => undefined, {
    verify: async (sha) => {
      throw new Error(`Commit ${sha.slice(0, 7)} is not on the release branch main of origin.`);
    },
  });
  expect(await h.update()).toEqual({ ok: false, rolled_back: false, error: 'Commit bbbbbbb is not on the release branch main of origin.' });
  expect(f.runs.length + h.runs.length).toBe(0);
});

test('the way back is also only to a commit of the release branch', async () => {
  const checked: [string, boolean | undefined][] = [];
  const f = fixture(() => ({ code: 1 }), {
    verify: async (sha, abbrev) => {
      checked.push([sha, abbrev]);
      if (sha !== B) throw new Error(`Commit ${sha.slice(0, 7)} is not on the release branch main of origin.`);
    },
  });
  // the commit from before may be the start of a commit id (an image knows its commit as it was given)
  const r = await f.update(B, A.slice(0, 12));
  expect(r).toMatchObject({ ok: false, rolled_back: false });
  expect(r.error).toBe('The update command failed (exit 1). Nothing was put back: Commit aaaaaaa is not on the release branch main of origin.');
  expect(checked).toEqual([[B, undefined], [A.slice(0, 12), true]]);
  expect(f.runs.map((x) => x.sha)).toEqual([B]);
});

test('the shell command gets the commit in its environment, and is killed at the time limit', async () => {
  const ok = await runShell('echo "to $DISPATCH_UPDATE_SHA"; exit 4', { PATH: process.env.PATH, DISPATCH_UPDATE_SHA: B }, 10_000);
  expect(ok).toEqual({ code: 4, out: `to ${B}`, timed_out: false });
  const slow = await runShell('echo start; sleep 30', { PATH: process.env.PATH }, 200);
  expect(slow.timed_out).toBe(true);
  expect(slow.out).toBe('start');
});

// --- through the link, with a server that restarts -----------------------------------------

type Got = WorkerToServer & { t: string };
let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

/** A server that says which commit it runs, and a worker's link to it. */
async function linked(command: string | undefined, serverUpdate: Partial<ServerUpdateOptions> & Pick<ServerUpdateOptions, 'run'>) {
  const state = { on: A, up: true };
  const got: Got[] = [];
  const socks = new Set<WebSocket>();
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (sock) => {
    // a server that is down takes no worker
    if (!state.up) return sock.close(1013, 'restarting');
    socks.add(sock);
    sock.on('close', () => socks.delete(sock));
    sock.on('message', (d) => {
      const m = JSON.parse(String(d)) as Got;
      got.push(m);
      if (m.t === 'hello') sock.send(JSON.stringify({ t: 'welcome', version: state.on } satisfies ServerToWorker));
    });
  });
  const slots = new Slots(2);
  const link = new ServerLink({
    name: 'home', url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/worker`, token: 't', local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: null, releases: [],
    repo_env_dir: '/nonexistent', ...(command ? { server_update_command: command } : {}),
  }, {
    fake: true, opts: { assistantReadDirs: [] } as never, workspacesDir: mkdtempSync(join(tmpdir(), 'dsp-supd-')), slots,
    claudeAccounts: () => [], githubAccounts: [], gitEnv: () => ({}), remoteBase: 'https://github.com',
    serverUpdate: { branch: 'main', timeoutMs: 60_000, healthMs: 8000, pollMs: 10, ...serverUpdate },
  } satisfies LinkShared);
  slots.links = [link];
  link.connect();
  cleanup.push(async () => {
    link.closeAll();
    for (const s of socks) s.terminate();
    await new Promise((r) => wss.close(r));
  });
  const hello = () => got.filter((m) => m.t === 'hello');
  await waitFor(() => hello().length, 'the hello');
  const send = (m: ServerToWorker) => [...socks][0].send(JSON.stringify(m));
  /** the server stops: every worker's link breaks */
  const stop = () => {
    state.up = false;
    for (const s of socks) s.terminate();
  };
  return { state, got, link, send, stop, hello };
}

test('a worker with the command says so, updates the server, and its result reaches the server that restarted', async () => {
  const ran: (string | undefined)[] = [];
  let busy: string[] = [];
  const w = await linked('./deploy.sh', {
    run: async (_command, env) => {
      ran.push(env.DISPATCH_UPDATE_SHA);
      busy = w.link.busyReasons();
      // the server goes down, and comes back on the new commit a moment later
      w.stop();
      setTimeout(() => {
        w.state.on = env.DISPATCH_UPDATE_SHA!;
        w.state.up = true;
      }, 300);
      return { code: 0, out: 'pulled', timed_out: false };
    },
  });
  expect((w.hello()[0] as Extract<WorkerToServer, { t: 'hello' }>).facts?.version).toEqual({ sha: null, updatable: false, server_update: true });
  w.send({ t: 'server_update', update_id: 7, sha: B, prev: A });
  const r = await waitFor(() => w.got.find((m) => m.t === 'update_result'), 'the result', 15_000);
  expect(r).toMatchObject({ t: 'update_result', update_id: 7, target: 'server', ok: true, rolled_back: false, from: A, to: B });
  expect(ran).toEqual([B]);
  // while the command runs the worker is at work: it does not update itself then
  expect(busy).toContain('the server is updated');
  expect(w.link.busyReasons()).toEqual([]);
  // the result came on the new connection, after the hello
  expect(w.hello()).toHaveLength(2);
}, 30_000);

test('a result that cannot be sent waits for the server, and a second request meanwhile is refused', async () => {
  let end: (r: CommandRun) => void = () => undefined;
  const w = await linked('./deploy.sh', { healthMs: 30, run: () => new Promise((r) => (end = r)) });
  w.send({ t: 'server_update', update_id: 7, sha: B, prev: null });
  await waitFor(() => w.link.busyReasons().includes('the server is updated'), 'the command to run');
  w.send({ t: 'server_update', update_id: 8, sha: B, prev: null });
  expect(await waitFor(() => w.got.find((m) => m.t === 'update_result'), 'the refusal')).toMatchObject({ update_id: 8, ok: false, error: 'This worker already runs an update of the server.' });
  // the server goes down for good while the command fails
  w.stop();
  await waitFor(() => (w.link as unknown as { ws: unknown }).ws === null, 'the link to break');
  end({ code: 1, out: 'boom', timed_out: false });
  const outbox = () => (w.link as unknown as { outbox: Got[] }).outbox;
  await waitFor(() => outbox().length, 'the result in the outbox');
  expect(outbox()[0]).toMatchObject({ t: 'update_result', update_id: 7, target: 'server', ok: false, rolled_back: false, from: null, to: B });
  // a worker that holds a result for a server is not in wait mode
  expect(w.link.busyReasons()).toEqual(['1 message for the server waits to be sent']);
  w.state.up = true;
  expect(await waitFor(() => w.got.find((m) => m.t === 'update_result' && m.update_id === 7), 'the result after the reconnect', 15_000)).toMatchObject({ ok: false, error: expect.stringMatching(/^The update command failed \(exit 1\)\./) });
}, 30_000);

test('a worker without the command does not say it can, and refuses when asked', async () => {
  const w = await linked(undefined, {
    run: async () => {
      throw new Error('never runs');
    },
  });
  expect((w.hello()[0] as Extract<WorkerToServer, { t: 'hello' }>).facts?.version).toBeUndefined();
  w.send({ t: 'server_update', update_id: 3, sha: B, prev: A });
  expect(await waitFor(() => w.got.find((m) => m.t === 'update_result'), 'the refusal')).toMatchObject({
    update_id: 3, target: 'server', ok: false, rolled_back: false, error: 'This worker has no command that updates server home (server_update_command in its config).',
  });
});
