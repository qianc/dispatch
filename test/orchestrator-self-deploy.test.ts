// DISP-221: the last step of an orchestration that deploys Dispatch itself. The owner's deploy
// restarts the worker once no session works, which is exactly when the last step's deploy runs: the
// restart kills that deploy, and no result ever comes. The worker's hello names the deploys it still
// has; one it lost runs again, and the step ends done with its result.
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerToServer } from '../src/shared/protocol.ts';
import { ServerLink, Slots } from '../src/worker/serverLink.ts';
import { waitFor } from './helpers.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

describe('orchestrator: a self-deploy cut off by a worker restart (DISP-221)', () => {
  let t: Setup;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => { t.s.ctx.orchestrator.stop(); return t.s.app.close(); });

  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  const hello = (workerId: number, deploys: number[] | null) => t.s.ctx.hub.handlers.onHello(workerId, [], null, [], null, [], deploys);

  it('merges the only running step, the worker restarts mid-deploy and the server restarts: the step ends done with its deploy result', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    t.status(child, 'running');
    turn(p.id);
    turn(child);
    const session = t.store.session(child)!;
    const repo = t.store.repos(session.project_id!)[0];
    // the merge, and GitHub's deploy after it: the worker gets it, the step follows it
    const deploy = vi.spyOn(t.s.ctx.github, 'deploy').mockImplementation(() => void t.s.ctx.orchestrator.onDeploy(t.store.session(child)!, repo, 'running'));
    t.s.ctx.orchestrator.onDeploy(session, repo, 'running');
    const merged = t.pr(child, 'merged');
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'running', note: 'deploying' });

    // an older worker says nothing about its deploys: nothing runs again
    hello(session.worker_id!, null);
    expect(deploy).not.toHaveBeenCalled();
    // the worker restarted, its deploy killed: it runs again, once
    hello(session.worker_id!, []);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(deploy.mock.calls[0][0].id).toBe(merged.id);
    expect(t.events(child)).toContain('system: The worker restarted during the deploy: it runs again.');
    hello(session.worker_id!, []);
    expect(deploy).toHaveBeenCalledTimes(1);

    // the deploy restarts the server; the worker comes back with the result in its outbox
    t.restart();
    hello(session.worker_id!, [repo.id]);
    expect(deploy).toHaveBeenCalledTimes(1);
    t.s.ctx.sessions.onWorkerMessage(session.worker_id!, { t: 'deploy_result', session_id: child, repo_id: repo.id, ok: true, sha: 'abc1234', output: 'deployed', duration_ms: 1000 });
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'done', deploys: { [repo.id]: 'ok' } });
    expect(t.events(child).some((e) => e.startsWith('system: Deployed aa (abc1234)'))).toBe(true);
  });

  it('a deploy the worker still runs, or that ended, does not run again', async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    turn(child);
    const session = t.store.session(child)!;
    const repo = t.store.repos(session.project_id!)[0];
    const deploy = vi.spyOn(t.s.ctx.github, 'deploy').mockImplementation(() => undefined);
    t.s.ctx.orchestrator.onDeploy(session, repo, 'running');
    t.pr(child, 'merged');
    hello(session.worker_id!, [repo.id]);
    t.s.ctx.sessions.onWorkerMessage(session.worker_id!, { t: 'deploy_result', session_id: child, repo_id: repo.id, ok: true, sha: null, output: '', duration_ms: 1 });
    hello(session.worker_id!, []);
    expect(deploy).not.toHaveBeenCalled();
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'done' });
  });
});

describe("the worker's hello names its deploys (DISP-221)", () => {
  let wss: WebSocketServer | null = null;
  const links: ServerLink[] = [];
  afterEach(async () => {
    for (const l of links.splice(0)) l.closeAll();
    for (const c of wss?.clients ?? []) c.terminate();
    await new Promise((r) => (wss ? wss.close(r) : r(null)));
    wss = null;
  });

  it('a running deploy, and a result in the outbox, are in the hello; a restarted worker names none', async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss!.once('listening', r));
    const hellos: Extract<WorkerToServer, { t: 'hello' }>[] = [];
    wss.on('connection', (ws) => ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as WorkerToServer;
      if (m.t === 'hello') hellos.push(m);
    }));
    const entry = { name: 'home', url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/worker`, token: 't', local_repo_dirs: ['/tmp'], read_dirs: [], claude_accounts: null, github_accounts: null, releases: [], repo_env_dir: '/nonexistent' };
    const link = () => {
      const l = new ServerLink(entry, {
        fake: true, opts: { assistantReadDirs: [] } as never, workspacesDir: mkdtempSync(join(tmpdir(), 'dsp-deploy-hello-')), slots: new Slots(2),
        claudeAccounts: () => [], githubAccounts: [], gitEnv: () => ({}), remoteBase: 'https://github.com',
      });
      links.push(l);
      return l;
    };
    const l = link();
    let finish = () => {};
    (l as unknown as { workspaces: { deploy: unknown } }).workspaces.deploy = () => new Promise((r) => { finish = () => r({ ok: true, sha: 'abc', output: '', duration_ms: 1 }); });
    l.connect(50);
    await waitFor(() => hellos.length === 1, 'first hello');
    expect(hellos[0].deploys).toEqual([]);
    const repo = { id: 9, project_id: 1, github_owner: 'me', github_name: 'r', default_branch: 'main', local_path: '/tmp/r', deploy_command: './deploy.sh' };
    const done = (l as unknown as { onMessage: (m: unknown) => Promise<void> }).onMessage({ t: 'deploy', session_id: 7, repo, github: null });
    // the deploy restarts the server: the link drops while it runs
    for (const c of wss.clients) c.terminate();
    await waitFor(() => hellos.length === 2, 'second hello', 5000);
    expect(hellos[1].deploys).toEqual([9]);
    for (const c of wss.clients) c.terminate();
    await waitFor(() => !(l as unknown as { ws: unknown }).ws, 'link down');
    finish();
    await done;
    await waitFor(() => hellos.length === 3, 'third hello', 5000);
    expect(hellos[2].deploys).toEqual([9]);
    // a new worker process: the deploy died with the old one
    l.closeAll();
    link().connect(50);
    await waitFor(() => hellos.length === 4, 'hello of the restarted worker', 5000);
    expect(hellos[3].deploys).toEqual([]);
  });
});
