// DISP-167: an orchestrator's own read-only checkouts: cleaned up, one folder per repo, each repo's
// GitHub account, and new checkouts and a new prompt when its scope changes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { withFolders } from '../src/server/repos.ts';
import type { StartSpec, WorkerToServer } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS, type Repo } from '../src/shared/types.ts';
import { orchestratorPrompt } from '../src/worker/prompts.ts';
import { Secrets } from '../src/worker/secrets.ts';
import { ServerLink, Slots } from '../src/worker/serverLink.ts';
import { waitFor } from './helpers.ts';
import { setup, type Server } from './orchestrator-helpers.ts';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

const repo = (id: number, owner: string, name: string, extra: Partial<Repo> = {}): Repo => ({
  id, project_id: id, github_owner: owner, github_name: name, default_branch: 'main', check_command: null, local_path: null, worktree_from: null, setup_command: null, ...extra,
});

describe('folders of a session with repos of the same name', () => {
  it('only colliding repos get another folder: owner-name for GitHub, name-id for hosted and local repos', () => {
    const out = withFolders([repo(1, 'acme', 'web'), repo(2, 'bolt', 'web'), repo(3, 'acme', 'api'), repo(4, 'local', 'web', { local_path: '/x/web' }), repo(5, 'x', 'docs'), repo(6, 'x', 'docs', { kind: 'hosted' })]);
    expect(out.map((r) => r.dir ?? r.github_name)).toEqual(['acme-web', 'bolt-web', 'api', 'web-4', 'x-docs', 'docs-6']);
    expect(out[2]).not.toHaveProperty('dir');
    // the same GitHub repo in two projects: owner-name collides too
    expect(withFolders([repo(1, 'acme', 'web'), repo(2, 'acme', 'web')]).map((r) => r.dir)).toEqual(['web-1', 'web-2']);
  });

  it('names differing only in case collide: one folder on a Windows or macOS worker (DISP-220)', () => {
    expect(withFolders([repo(1, 'acme', 'decks'), repo(2, 'bolt', 'Decks')]).map((r) => r.dir)).toEqual(['acme-decks', 'bolt-Decks']);
    expect(withFolders([repo(1, 'acme', 'decks'), repo(2, 'Acme', 'Decks')]).map((r) => r.dir)).toEqual(['decks-1', 'Decks-2']);
  });
});

describe("an orchestrator's checkouts on the worker", () => {
  function remote(root: string, owner: string, name: string) {
    const bare = join(root, owner, `${name}.git`);
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    const seed = mkdtempSync(join(tmpdir(), 'dsp-oc-seed-'));
    git(seed, 'init', '-b', 'main');
    writeFileSync(join(seed, 'README.md'), `${owner}/${name}\n`);
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'init');
    git(seed, 'push', bare, 'main');
  }

  it('one folder per repo, each cloned as its project account; a new scope starts it again with new checkouts; tidy removes them', async () => {
    const remoteRoot = mkdtempSync(join(tmpdir(), 'dsp-oc-remote-'));
    remote(remoteRoot, 'acme', 'web');
    remote(remoteRoot, 'bolt', 'web');
    remote(remoteRoot, 'bolt', 'api');
    const asAccount: string[] = [];
    const entry = { name: 'default', url: 'ws://127.0.0.1:1/worker', token: 'dsw_t', local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: ['personal', 'work'], releases: [], repo_env_dir: '/nonexistent' };
    const slots = new Slots(2);
    const link = new ServerLink(entry, {
      fake: true, opts: { assistantReadDirs: [] } as never,
      workspacesDir: mkdtempSync(join(tmpdir(), 'dsp-oc-ws-')), slots,
      claudeAccounts: () => [], githubAccounts: ['personal', 'work'], remoteBase: `file://${remoteRoot}`, secrets: new Secrets(),
      gitEnv: (r) => {
        asAccount.push(`${r.github_owner}/${r.github_name} as ${r.github_account}`);
        return {};
      },
    });
    const sent: WorkerToServer[] = [];
    (link as unknown as { ws: unknown }).ws = { readyState: WebSocket.OPEN, send: (d: string) => sent.push(JSON.parse(d)) };
    const onMessage = (m: unknown) => (link as unknown as { onMessage: (m: unknown) => Promise<void> }).onMessage(m);
    const ws = (link as unknown as { workspaces: { repoDir: (id: number, r: Repo) => string; sessionDir: (id: number) => string } }).workspaces;
    process.env.FAKE_DELAY_MS = '1';

    const aa = { key: 'AA', name: 'Alpha', importance_scale: ['Low', 'High'], effort_scale: ['S'], repos: ['web (folder ./acme-web)'] };
    const bb = { key: 'BB', name: 'Beta', importance_scale: ['Low', 'High'], effort_scale: ['S'], repos: ['web (folder ./bolt-web)'] };
    const spec = (repos: Repo[], projects: typeof aa[], resume: string | null): StartSpec => ({
      session_id: 9, kind: 'orchestrator', project_key: '', project_name: '', importance_scale: [], effort_scale: [], title: 'Goal', branch: null,
      repos, items: [], source: null, prompt: '[fake:env]', force_plan: false, options: { ...DEFAULT_RUN_OPTIONS, model: 'opus' }, claude_account: null,
      github_account: 'personal', resume, resume_note: null,
      orchestration: { goal: 'Goal', phase: 'plan', projects, max_children: 2, status_md: 'No plan yet.' },
    });
    const two = withFolders([repo(1, 'acme', 'web', { github_account: 'personal' }), repo(2, 'bolt', 'web', { project_id: 2, github_account: 'work' })]);
    const first = spec(two, [aa, bb], null);
    await onMessage({ t: 'start', spec: first });
    await waitFor(() => sent.some((m) => m.t === 'status' && m.status === 'idle'), 'first turn');
    expect(sent.find((m) => m.t === 'status' && m.status === 'failed')).toBeUndefined();
    // (2) two folders, and the prompt names each
    const acme = ws.repoDir(9, two[0]);
    const bolt = ws.repoDir(9, two[1]);
    expect(acme).toMatch(/sessions\/9\/acme-web$/);
    expect(bolt).toMatch(/sessions\/9\/bolt-web$/);
    expect(git(acme, 'show', 'HEAD:README.md')).toBe('acme/web');
    expect(git(bolt, 'show', 'HEAD:README.md')).toBe('bolt/web');
    const prompt = orchestratorPrompt(first);
    expect(prompt).toContain('acme/web at ./acme-web');
    expect(prompt).toContain('bolt/web at ./bolt-web');
    expect(prompt).toContain('BB (Beta): repos web (folder ./bolt-web)');
    // (3) each repo cloned and fetched as its own project's account
    expect(asAccount).toContain('acme/web as personal');
    expect(asAccount).toContain('bolt/web as work');
    expect(asAccount).not.toContain('bolt/web as personal');

    // (4) a project came into the scope: the next message starts it again on its sdk session, with a checkout of the new repo
    const runners = (link as unknown as { runners: Map<number, unknown> }).runners;
    const before = runners.get(9);
    const api = repo(3, 'bolt', 'api', { project_id: 3, github_account: 'work' });
    const cc = { key: 'CC', name: 'Gamma', importance_scale: ['Low', 'High'], effort_scale: ['S'], repos: ['api'] };
    const idles = () => sent.filter((m) => m.t === 'status' && m.status === 'idle').length;
    // all slots are taken by other sessions (the idle orchestrator holds none): the message still reaches it (DISP-175)
    slots.set('other:1', true);
    slots.set('other:2', true);
    await onMessage({ t: 'send', session_id: 9, text: '[fake:env] scope changed', spec: spec([...two, api], [aa, bb, cc], 'sdk-9') });
    await waitFor(() => idles() === 2, 'second turn');
    expect(sent.find((m) => m.t === 'refused')).toBeUndefined();
    slots.set('other:1', false);
    slots.set('other:2', false);
    expect(runners.get(9)).not.toBe(before);
    expect(sent.filter((m) => m.t === 'status' && m.status === 'running').at(-1)).toMatchObject({ sdk_session_id: 'sdk-9' });
    expect(git(ws.repoDir(9, api), 'show', 'HEAD:README.md')).toBe('bolt/api');
    // the same scope again: the same runner takes the message
    const now = runners.get(9);
    await onMessage({ t: 'send', session_id: 9, text: '[fake:env] again', spec: spec([...two, api], [aa, bb, cc], 'sdk-9') });
    await waitFor(() => idles() === 3, 'third turn');
    expect(runners.get(9)).toBe(now);

    // a project left the scope: only its checkout goes, the others stay as they are (DISP-177)
    writeFileSync(join(acme, 'marker'), 'kept');
    await onMessage({ t: 'send', session_id: 9, text: '[fake:env] scope smaller', spec: spec([two[0], api], [aa, cc], 'sdk-9') });
    await waitFor(() => idles() === 4, 'fourth turn');
    expect(existsSync(bolt)).toBe(false);
    expect(existsSync(join(acme, 'marker'))).toBe(true);
    expect(git(ws.repoDir(9, api), 'show', 'HEAD:README.md')).toBe('bolt/api');

    // a repo account this server may not use here: refused
    await onMessage({ t: 'start', spec: { ...spec([repo(4, 'acme', 'web', { github_account: 'other' })], [aa], null), session_id: 10 } });
    expect(sent.find((m) => m.t === 'status' && m.session_id === 10)).toMatchObject({ status: 'failed', error: expect.stringContaining('"other" (of web)') });

    // (1) the janitor's tidy, forced: the detached checkouts and the session folder go
    await onMessage({ t: 'close', session_id: 9 });
    const res = await link.command({ c: 'tidy', session_id: 9, repos: [...two, api], branch: null, merged_repo_ids: [], delete_merged: false, force: true });
    expect(res).toEqual([{ repo: 'web', worktree: 'removed', branch: 'none' }, { repo: 'web', worktree: 'none', branch: 'none' }, { repo: 'api', worktree: 'removed', branch: 'none' }]);
    expect(existsSync(ws.sessionDir(9))).toBe(false);
  });
});

describe('an orchestrator on the server (DISP-167)', () => {
  let s: Server | null = null;
  afterEach(() => { s?.ctx.orchestrator.stop(); return s?.app.close(); });

  it('spans repos of the same name as two folders, tidies its checkouts when it closes, and tells it what a new project brings', async () => {
    const t = await setup();
    s = t.s;
    const st = t.s.ctx.store;
    // AA and BB each get a repo named "web" (two owners)
    await t.s.call('POST', '/projects/AA/repos', { github_owner: 'acme', github_name: 'web' });
    await t.s.call('POST', '/projects/BB/repos', { github_owner: 'bolt', github_name: 'web' });
    const tidied: { session_id: number; repos: string[]; force: boolean; branch: string | null }[] = [];
    const hub = t.s.ctx.hub as unknown as { isConnected: (id: number | null) => boolean; cmd: (w: number, c: { c: string; session_id: number; repos: Repo[]; force: boolean; branch: string | null }) => Promise<unknown> };
    hub.isConnected = () => true;
    hub.cmd = async (_w, c) => {
      if (c.c === 'tidy') tidied.push({ session_id: c.session_id, repos: c.repos.map((r) => r.dir ?? r.github_name), force: c.force, branch: c.branch });
      return [];
    };
    t.s.ctx.janitor.closeDelayMs = 0;
    const id = t.start().session_id;
    const sess = st.session(id)!;
    const spec = t.s.ctx.sessions.spec(sess, 'go', null, null, null);
    expect(spec.repos.map((r) => r.dir ?? r.github_name)).toEqual(['aa', 'acme-web', 'bb', 'bolt-web']);
    // each repo carries its own project's GitHub account
    expect(spec.repos.every((r) => r.github_account === st.project(r.project_id)!.github_account)).toBe(true);
    const prompt = orchestratorPrompt(spec);
    expect(prompt).toContain('acme/web at ./acme-web');
    expect(prompt).toContain('bolt/web at ./bolt-web');

    // CC comes into the scope: the wake lists it with its repos and scales
    t.status(id, 'running');
    t.status(id, 'idle');
    t.s.ctx.orchestrator.update(id, { project_keys: ['AA', 'BB', 'CC'] });
    const woke = t.events(id).filter((e) => e.startsWith('system: (From Dispatch')).at(-1) ?? '';
    expect(woke).toContain('New in your scope');
    expect(woke).toMatch(/- CC \(Project CC\): repos cc\. Importance 1–4: 1=.*Effort index: 0=/);
    const after = t.s.ctx.sessions.spec(st.session(id)!, 'go', null, null, null);
    expect(after.repos.map((r) => r.github_name)).toContain('cc');
    expect(orchestratorPrompt(after)).toContain('- CC (Project CC): repos cc.');

    // closing it tidies every checkout of its span, forced (they are detached)
    t.s.ctx.sessions.finish(id, 'stopped');
    await waitFor(() => tidied.find((x) => x.session_id === id), 'tidy');
    expect(tidied.find((x) => x.session_id === id)).toEqual({ session_id: id, repos: ['aa', 'acme-web', 'bb', 'bolt-web', 'cc'], force: true, branch: null });
  });
});
