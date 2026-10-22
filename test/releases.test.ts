import { execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchesRepo } from '../src/server/releases.ts';
import type { ReleaseCapability, Repo } from '../src/shared/types.ts';
import { releasePrompt } from '../src/worker/prompts.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import { startServer, startWorker, stopWorker, waitFor } from './helpers.ts';

type Msg = { t: string; req_id?: string; cmd?: { c: string }; spec?: { session_id: number; kind: string; branch: string | null; repos: Repo[]; release?: { version: string } } };

/** A hand-driven worker that answers release_version with `version`. */
async function rawWorker(port: number, token: string, releases: ReleaseCapability[] | undefined, version: { tag?: string | null; file?: string | null } | Error = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, { headers: { 'x-worker-token': token } });
  const got: Msg[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as Msg;
    got.push(m);
    if (m.t === 'cmd' && m.cmd?.c === 'release_version') {
      ws.send(JSON.stringify(version instanceof Error ? { t: 'cmd_result', req_id: m.req_id, ok: false, error: version.message } : { t: 'cmd_result', req_id: m.req_id, ok: true, data: version }));
    }
  });
  await new Promise((r) => ws.once('open', r));
  const facts = releases === undefined ? undefined : { os: 'linux', hostname: 'h', slots: 3, free_slots: 3, claude_accounts: [], github_accounts: [], local_repo_dirs: [], releases };
  ws.send(JSON.stringify({ t: 'hello', live: [], ...(facts ? { facts } : { claude_accounts: [] }) }));
  return { ws, got, starts: () => got.filter((m) => m.t === 'start').map((m) => m.spec!) };
}

const cap = (repo: string, over: Partial<ReleaseCapability> = {}): ReleaseCapability => ({ repo, label_prefix: 'rel:', command: './release.sh {version} --yes', notes: null, ...over });

describe('matching a worker release to a repo', () => {
  const gh = (id: number, owner: string, name: string): Repo => ({ id, project_id: 1, github_owner: owner, github_name: name, default_branch: 'main', check_command: null, local_path: null, worktree_from: null, setup_command: null, kind: 'github' });
  const local: Repo = { ...gh(3, 'local', 'tool'), kind: 'local', local_path: '/home/me/tool', worker_id: 7 };
  const hosted: Repo = { ...gh(4, 'hosted', 'srv'), kind: 'hosted' };

  it('matches owner/name, a unique repo name, or a local path on the same worker; never hosted', () => {
    const repos = [gh(1, 'me', 'app'), gh(2, 'other', 'lib'), local, hosted];
    expect(matchesRepo(cap('ME/App'), repos[0], 7, repos)).toBe(true);
    expect(matchesRepo(cap('app'), repos[0], 7, repos)).toBe(true);
    expect(matchesRepo(cap('me/lib'), repos[1], 7, repos)).toBe(false);
    expect(matchesRepo(cap('/home/me/tool/'), local, 7, repos)).toBe(true);
    expect(matchesRepo(cap('/home/me/tool'), local, 8, repos)).toBe(false);
    expect(matchesRepo(cap('tool'), local, 7, repos)).toBe(true);
    expect(matchesRepo(cap('srv'), hosted, 7, repos)).toBe(false);
    const twins = [gh(1, 'me', 'x'), gh(2, 'other', 'x')];
    expect(matchesRepo(cap('x'), twins[0], 7, twins)).toBe(false);
    expect(matchesRepo(cap('other/x'), twins[1], 7, twins)).toBe(true);
  });

  it('tells the release agent the version, label, command, items and when to label', () => {
    const text = releasePrompt({
      session_id: 1, kind: 'release', project_key: 'HC', project_name: 'Home', importance_scale: [], effort_scale: [], title: 't', branch: null,
      repos: [gh(1, 'me', 'app')], items: [{ key: 'HC-1', type: 'backlog', title: 'Dark mode', modules: [] } as never], source: null, prompt: '', force_plan: false,
      options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: null, resume: null, resume_note: null,
      release: { repo_id: 1, cap_repo: 'me/app', version: 'v1.5.0', label_prefix: 'rel:', command: './release.sh {version} --yes', notes: 'Credential is here.', last_version: 'v1.4.2' },
    }, [{ label: '.dispatch.md from /x', text: 'Changelog rules' }]);
    expect(text).toContain('`./release.sh v1.5.0 --yes`');
    expect(text).toContain('`rel:v1.5.0`');
    expect(text).toContain('last release: `v1.4.2`');
    expect(text).toContain('HC-1 · backlog · Dark mode');
    expect(text).toContain('Only after the release succeeded');
    expect(text).toContain('Credential is here.');
    expect(text).toContain('Changelog rules');
  });
});

describe('releases from the interface', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let b: { id: number; secret: string };
  const done = (title: string, type: 'backlog' | 'bug' = 'backlog', labels: string[] = []) => {
    return s.ctx.store.createItem(s.ctx.store.projectByKey('REL')!.id, { title, type, body_md: '', status: 'done', importance: 2, effort: null, source_id: null, labels });
  };
  beforeEach(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'REL', name: 'Releases' });
    await s.call('POST', '/projects/REL/repos', { github_owner: 'me', github_name: 'app' });
    const made = s.ctx.workers.create('b', 'the release machine');
    b = { id: made.worker.id, secret: made.secret };
  });
  afterEach(() => s.app.close());

  it('lists only connected workers whose config offers a release of a repo; old workers offer none', async () => {
    const old = await rawWorker(s.port, 'test-token', undefined);
    await waitFor(() => s.ctx.hub.connectedIds().length === 1, 'old worker');
    expect((await s.call('GET', '/projects/REL/releases')).data).toEqual([]);
    const wb = await rawWorker(s.port, b.secret, [cap('me/app'), cap('me/other')]);
    await waitFor(() => s.ctx.hub.connectedIds().length === 2, 'worker b');
    expect((await s.call('GET', '/projects/REL/releases')).data).toEqual([
      { worker_id: b.id, worker: 'b', repo_id: expect.any(Number), repo: 'me/app', cap_repo: 'me/app', label_prefix: 'rel:', command: './release.sh {version} --yes', notes: null },
    ]);
    wb.ws.close();
    await waitFor(() => s.ctx.hub.connectedIds().length === 1, 'b gone');
    expect((await s.call('GET', '/projects/REL/releases')).data).toEqual([]);
    old.ws.close();
  });

  it('proposes the next version from the tag, the VERSION file or the labels', async () => {
    const wb = await rawWorker(s.port, b.secret, [cap('me/app')], { tag: 'v1.4.2', file: null });
    await waitFor(() => s.ctx.hub.isConnected(b.id), 'b');
    const repo_id = s.ctx.store.repos(s.ctx.store.projectByKey('REL')!.id)[0].id;
    done('Old', 'backlog', ['rel:v1.4.2']);
    done('Fix', 'bug');
    const q = `/projects/REL/releases/proposal?worker_id=${b.id}&repo_id=${repo_id}`;
    expect((await s.call('GET', q)).data).toMatchObject({ last: { version: 'v1.4.2', from: 'tag' }, proposed: 'v1.4.3', bump: 'patch', items: [{ title: 'Fix', type: 'bug' }] });
    done('Feature');
    expect((await s.call('GET', q)).data).toMatchObject({ proposed: 'v1.5.0', bump: 'minor' });
    wb.ws.close();

    // the tags cannot be read: the labels still say where the last release was
    const wc = await rawWorker(s.port, b.secret, [cap('me/app')], new Error('no network'));
    await waitFor(() => s.ctx.hub.isConnected(b.id), 'b again');
    done('Later', 'backlog', ['rel:v2.0.0']);
    const res = (await s.call('GET', q)).data;
    expect(res).toMatchObject({ last: { version: 'v2.0.0', from: 'label' }, proposed: 'v2.1.0' });
    expect(res.warning).toMatch(/no network/);
    expect((await s.call('GET', `/projects/REL/releases/proposal?worker_id=${b.id}&repo_id=999`)).status).toBe(400);
    wc.ws.close();
  });

  it('starts a release session on the worker that offers it, after checking the version', async () => {
    const wa = await rawWorker(s.port, 'test-token', []);
    const wb = await rawWorker(s.port, b.secret, [cap('me/app')], { tag: 'v1.4.2' });
    await waitFor(() => s.ctx.hub.connectedIds().length === 2, 'both');
    const repo_id = s.ctx.store.repos(s.ctx.store.projectByKey('REL')!.id)[0].id;
    const post = (version: string, worker_id = b.id) => s.call('POST', '/projects/REL/releases', { worker_id, repo_id, version });

    expect((await post('1.5.0')).data.error).toMatch(/No done items/);
    const feat = done('Feature');
    done('Shipped', 'backlog', ['rel:v1.4.0']);
    expect((await post('1.5')).status).toBe(400);
    expect((await post('v1.4.0')).status).toBe(409);
    expect((await post('v1.5.0', s.ctx.workers.legacy().id)).status).toBe(400);

    const res = await post('1.5.0');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ kind: 'release', worker_id: b.id, branch: null, item_ids: [feat.id], release: { version: 'v1.5.0', label_prefix: 'rel:', last_version: 'v1.4.2' } });
    await waitFor(() => wb.starts().length === 1, 'start on b');
    expect(wa.starts()).toEqual([]);
    const spec = wb.starts()[0];
    expect(spec).toMatchObject({ kind: 'release', branch: null, release: { version: 'v1.5.0' } });
    expect(spec.repos.map((r) => r.github_name)).toEqual(['app']);
    expect((await post('1.6.0')).status).toBe(409); // one release of a repo at a time

    // only the release session labels, only done items, with its own version
    const sessions = s.ctx.sessions;
    const other = done('Other');
    await expect(sessions.rpc(res.data.id, 'release_items', { keys: ['REL-999'] })).rejects.toThrow(/No item/);
    const open = s.ctx.store.createItem(s.ctx.store.projectByKey('REL')!.id, { title: 'Open', type: 'bug', body_md: '', status: 'todo', importance: 2, effort: null, source_id: null, labels: [] });
    await expect(sessions.rpc(res.data.id, 'release_items', { keys: [open.key] })).rejects.toThrow(/Only done items/);
    await expect(sessions.rpc(res.data.id, 'propose', {})).rejects.toThrow(/release session cannot/);
    expect(await sessions.rpc(res.data.id, 'release_items', { keys: [feat.key, other.key] })).toEqual({ released: [feat.key, other.key], label: 'rel:v1.5.0' });
    expect(s.ctx.store.item(feat.id)!.labels).toEqual(['rel:v1.5.0']);
    const work = (await s.call('POST', '/projects/REL/batches', { prompt: 'x' })).data;
    await expect(sessions.rpc(work.id, 'release_items', { keys: [feat.key] })).rejects.toThrow(/Only a release session/);
    wa.ws.close();
    wb.ws.close();
  });
});

describe('a release end to end on a local repo', () => {
  const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();
  let s: Awaited<ReturnType<typeof startServer>>;
  let worker: ChildProcess | null = null;
  afterEach(async () => {
    if (worker) await stopWorker(worker);
    worker = null;
    await s.app.close();
  });

  const setup = async (command: string) => {
    const root = mkdtempSync(join(tmpdir(), 'dsp-rel-'));
    const dir = join(root, 'tool');
    execFileSync('git', ['init', '-b', 'main', dir]);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    writeFileSync(join(dir, '.dispatch.md'), 'Release rules\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'init');
    git(dir, 'tag', 'v1.2.0');
    s = await startServer();
    worker = startWorker(s.port, { LOCAL_REPO_DIRS: root, WORKSPACES_DIR: mkdtempSync(join(tmpdir(), 'dsp-ws-')), RELEASES: JSON.stringify([{ repo: dir, label_prefix: 'rel:', command }]) });
    await waitFor(() => s.ctx.hub.connected, 'worker');
    await s.call('POST', '/projects', { key: 'TL', name: 'Tool' });
    const repo = (await s.call('POST', '/projects/TL/repos', { local_path: dir })).data;
    const p = s.ctx.store.projectByKey('TL')!;
    const it = s.ctx.store.createItem(p.id, { title: 'New thing', type: 'backlog', body_md: '', status: 'done', importance: 2, effort: null, source_id: null, labels: [] });
    const [opt] = (await s.call('GET', '/projects/TL/releases')).data;
    expect(opt).toMatchObject({ repo_id: repo.id, repo: 'tool', cap_repo: dir });
    return { dir, it, opt };
  };

  it('reads the tag, runs the release in the checkout and labels the items', async () => {
    const { dir, it, opt } = await setup('./release.sh {version} --yes');
    const prop = (await s.call('GET', `/projects/TL/releases/proposal?worker_id=${opt.worker_id}&repo_id=${opt.repo_id}`)).data;
    expect(prop).toMatchObject({ last: { version: 'v1.2.0', from: 'tag' }, proposed: 'v1.3.0' });
    const session = (await s.call('POST', '/projects/TL/releases', { worker_id: opt.worker_id, repo_id: opt.repo_id, version: prop.proposed })).data;
    await waitFor(() => s.ctx.store.item(it.id)!.labels.includes('rel:v1.3.0'), 'labelled');
    const texts = s.ctx.store.events(session.id).map((e) => ('text' in e.body ? e.body.text : ''));
    expect(texts.some((t) => t.includes(`Releasing tool v1.3.0 in ${dir}`) && t.includes('.dispatch.md'))).toBe(true);
    expect(s.ctx.store.events(session.id).some((e) => e.body.kind === 'tool_use' && e.body.summary === './release.sh v1.3.0 --yes')).toBe(true);
    await s.call('POST', `/sessions/${session.id}/finish`, { status: 'completed', cleanup: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(git(dir, 'branch', '--show-current')).toBe('main'); // the owner's main is untouched
  });

  it('a failed release labels nothing; a dirty checkout does not start', async () => {
    const { dir, it, opt } = await setup('./release.sh {version} --fail');
    const session = (await s.call('POST', '/projects/TL/releases', { worker_id: opt.worker_id, repo_id: opt.repo_id, version: 'v1.3.0' })).data;
    await waitFor(() => s.ctx.store.events(session.id).some((e) => e.body.kind === 'assistant' && e.body.text.includes('did not label')), 'failed');
    expect(s.ctx.store.item(it.id)!.labels).toEqual([]);
    s.ctx.sessions.finish(session.id, 'completed');

    writeFileSync(join(dir, 'a.txt'), 'edited\n');
    const again = (await s.call('POST', '/projects/TL/releases', { worker_id: opt.worker_id, repo_id: opt.repo_id, version: 'v1.3.0' })).data;
    await waitFor(() => s.ctx.store.session(again.id)!.status === 'failed', 'refused start');
    expect(s.ctx.store.events(again.id).map((e) => ('text' in e.body ? e.body.text : '')).join('\n')).toMatch(/on main with no uncommitted changes/);
  });
});

describe('the release checkout of a GitHub repo', () => {
  const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();

  it('is the default branch tracking origin, kept as it is when reopened; the version comes from its tags and VERSION', async () => {
    const { Workspaces } = await import('../src/worker/workspace.ts');
    const base = mkdtempSync(join(tmpdir(), 'dsp-remote-'));
    const src = join(base, 'src');
    execFileSync('git', ['init', '-b', 'main', src]);
    writeFileSync(join(src, 'VERSION'), '1.9.0\n');
    git(src, 'add', '.');
    git(src, 'commit', '-m', 'init');
    git(src, 'tag', 'v1.8.0');
    git(src, 'tag', 'v1.10.0-rc.1');
    execFileSync('git', ['clone', '--bare', src, join(base, 'me', 'app.git')]);
    const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')), `file://${base}`);
    const repo: Repo = { id: 1, project_id: 1, github_owner: 'me', github_name: 'app', default_branch: 'main', check_command: null, local_path: null, worktree_from: null, setup_command: null, kind: 'github' };
    expect(await ws.releaseVersion(repo)).toEqual({ tag: 'v1.10.0-rc.1', file: '1.9.0' });
    const spec = { session_id: 3, kind: 'release' as const, repos: [repo] } as never;
    const wt = await ws.prepareRelease(spec);
    expect(git(wt, 'branch', '--show-current')).toBe('main');
    expect(git(wt, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/main');
    writeFileSync(join(wt, 'CHANGELOG.md'), '## v1.10.0\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'changelog');
    const head = git(wt, 'rev-parse', 'HEAD');
    await ws.prepareRelease(spec);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(head); // a reopened release keeps its commit
  });
});
