// DISP-44: each worker's env files per repo are copied into every worktree Dispatch makes (session,
// merge, deploy), and the setup command runs there before the check or the deploy.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/worker/config.ts';
import { Workspaces } from '../src/worker/workspace.ts';
import type { StartSpec } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS, type Repo } from '../src/shared/types.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

describe('env overlay (DISP-44)', () => {
  let remoteRoot: string;
  let envDir: string;
  let ws: Workspaces;
  let repo: Repo;
  const spec = (branch: string, id = 1): StartSpec => ({
    session_id: id, kind: 'work', project_key: 'HC', project_name: 'HC', importance_scale: [], effort_scale: [],
    title: 't', branch, repos: [repo], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: null, resume: null, resume_note: null,
  });

  beforeEach(() => {
    remoteRoot = mkdtempSync(join(tmpdir(), 'dsp-remote-'));
    const bare = join(remoteRoot, 'me', 'hc.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    const seed = mkdtempSync(join(tmpdir(), 'dsp-seed-'));
    git(seed, 'init', '-b', 'main');
    writeFileSync(join(seed, 'a.txt'), 'one\n');
    writeFileSync(join(seed, '.gitignore'), '.env\nconf/local.json\n.venv/\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'init');
    git(seed, 'push', bare, 'main');
    envDir = mkdtempSync(join(tmpdir(), 'dsp-env-'));
    mkdirSync(join(envDir, 'me', 'hc', 'conf'), { recursive: true });
    writeFileSync(join(envDir, 'me', 'hc', '.env'), 'SECRET=worker-a\n');
    writeFileSync(join(envDir, 'me', 'hc', 'conf', 'local.json'), '{}\n');
    ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')), `file://${remoteRoot}`, () => ({}), null, envDir);
    repo = { id: 1, project_id: 1, github_owner: 'me', github_name: 'hc', default_branch: 'main', check_command: null, local_path: null, worktree_from: null, setup_command: null };
  });

  it('copies ignored env files into a new worktree and lists the repos that have them', async () => {
    const created: { repo: Repo; wt: string }[] = [];
    const cwd = await ws.prepare(spec('feat'), created);
    const res = await ws.prepareTree(repo, created[0].wt);
    expect(res).toMatchObject({ ok: true, copied: ['.env', join('conf', 'local.json')] });
    expect(readFileSync(join(cwd, '.env'), 'utf8')).toBe('SECRET=worker-a\n');
    expect(git(cwd, 'status', '--porcelain')).toBe('');
    expect(await ws.overlays()).toEqual(['me/hc']);
  });

  it('refuses a file git would track, and says so', async () => {
    writeFileSync(join(envDir, 'me', 'hc', 'tracked.txt'), 'oops\n');
    const created: { repo: Repo; wt: string }[] = [];
    const cwd = await ws.prepare(spec('feat'), created);
    const res = await ws.prepareTree(repo, cwd);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('tracked.txt');
    expect(existsSync(join(cwd, 'tracked.txt'))).toBe(false);
    expect(existsSync(join(cwd, '.env'))).toBe(true);
  });

  it('runs the setup command with DISPATCH_REPO_ENV_DIR, after the env files are in place', async () => {
    const r = { ...repo, setup_command: 'cat .env > setup.out && echo "$DISPATCH_REPO_ENV_DIR" >> setup.out' };
    const cwd = await ws.prepare({ ...spec('feat'), repos: [r] });
    expect((await ws.prepareTree(r, cwd)).ok).toBe(true);
    expect(readFileSync(join(cwd, 'setup.out'), 'utf8')).toBe(`SECRET=worker-a\n${join(envDir, 'me', 'hc')}\n`);
  });

  it('sets up the merge checkout before the check runs', async () => {
    const r = { ...repo, setup_command: 'mkdir -p .venv && touch .venv/ready', check_command: 'test -f .venv/ready && grep -q worker-a .env' };
    const cwd = await ws.prepare({ ...spec('feat'), repos: [r] });
    writeFileSync(join(cwd, 'b.txt'), 'two\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'add b');
    await ws.pushBranch(r, 1, 'feat');
    expect(await ws.mergeLocal(r, 'feat', 'Merge #1')).toMatchObject({ ok: true, check: { ok: true } });
    const failing = { ...r, setup_command: 'exit 4' };
    const res = await ws.mergeLocal(failing, 'feat', 'Merge #2');
    expect(res.ok).toBe(false);
    expect(res.output).toContain('Could not set up the merge checkout');
  });

  it('sets up a fresh deploy checkout before the deploy runs', async () => {
    const r = { ...repo, setup_command: 'touch ready', deploy_command: 'test -f ready && cat .env' };
    const res = await ws.deploy(r);
    expect(res).toMatchObject({ ok: true, output: 'SECRET=worker-a' });
  });

  it('has no overlay for a repo without a folder, and sets no env var', async () => {
    const other = { ...repo, github_name: 'other' };
    expect(ws.overlayDir(other)).toBeNull();
    expect(await ws.prepareTree(other, mkdtempSync(join(tmpdir(), 'dsp-x-')))).toEqual({ ok: true, output: '', copied: [] });
  });
});

describe('repo_env_dir in the worker config (DISP-44)', () => {
  it('defaults to ~/.config/dispatch/repo-env, and REPO_ENV_DIR or the config file can set it', () => {
    const base = { WORKER_TOKEN: 't', HOME: '/home/u' };
    expect(loadWorkerConfig(base).servers[0].repo_env_dir).toBe('/home/u/.config/dispatch/repo-env');
    expect(loadWorkerConfig({ ...base, REPO_ENV_DIR: '~/envs' }).servers[0].repo_env_dir).toBe('/home/u/envs');
    const file = join(mkdtempSync(join(tmpdir(), 'dsp-cfg-')), 'worker.json');
    writeFileSync(file, JSON.stringify({ repo_env_dir: '/srv/env', servers: [{ name: 'a', url: 'ws://x', token: 't' }, { name: 'b', url: 'ws://y', token: 't', repo_env_dir: '~/b-env' }] }));
    const cfg = loadWorkerConfig({ WORKER_CONFIG: file, HOME: '/home/u' });
    expect(cfg.servers.map((s) => s.repo_env_dir)).toEqual(['/srv/env', '/home/u/b-env']);
  });
});
