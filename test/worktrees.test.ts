import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Repo } from '../src/shared/types.ts';
import type { StartSpec } from '../src/shared/protocol.ts';
import { Workspaces } from '../src/worker/workspace.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function ownerRepo() {
  const dir = join(tmp('dsp-own-'), 'tpl');
  execFileSync('git', ['init', '-b', 'main', dir]);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  git(dir, 'config', 'receive.denyCurrentBranch', 'updateInstead');
  return dir;
}
const localRepo = (dir: string, extra: Partial<Repo> = {}): Repo => ({ id: 3, project_id: 1, github_owner: 'local', github_name: 'tpl', default_branch: 'main', check_command: null, local_path: dir, worktree_from: null, setup_command: null, ...extra });
const spec = (repo: Repo, id: number, branch: string | null = `dispatch/t-${id}`): StartSpec => ({
  session_id: id, kind: branch ? 'work' : 'planner', project_key: 'T', project_name: 'T', importance_scale: [], effort_scale: [], title: 't', branch,
  repos: [repo], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: null, resume: null, resume_note: null,
});

describe('worktrees of the owner\'s repo (local repos, default)', () => {
  it('makes a real worktree of the repo: its tools see the owner\'s checkout as main, and the branch needs no push', async () => {
    const dir = ownerRepo();
    const ws = new Workspaces(tmp('dsp-ws-'));
    const repo = localRepo(dir);
    const created: { repo: Repo; wt: string }[] = [];
    const wt = await ws.prepare(spec(repo, 1), created);
    expect(created.map((c) => c.wt)).toEqual([wt]);
    expect(Workspaces.isAttached(wt, repo)).toBe(true);
    // what run_tests.sh asks: where is the main checkout?
    expect(realpathSync(git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir'))).toBe(realpathSync(join(dir, '.git')));
    expect(git(dir, 'worktree', 'list')).toContain(wt);

    writeFileSync(join(wt, 'b.txt'), 'two\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'add b');
    expect(git(dir, 'log', '-1', '--format=%s', 'dispatch/t-1')).toBe('add b'); // already in the owner's repo
    await ws.pushBranch(repo, 1, 'dispatch/t-1'); // no-op, no remote involved
    expect(await ws.branchStatus(repo, 'dispatch/t-1')).toMatchObject({ exists: true, ahead: 1, behind: 0 });

    // the owner moves on: the branch is now behind main
    writeFileSync(join(dir, 'c.txt'), 'three\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'owner work');
    expect(await ws.branchStatus(repo, 'dispatch/t-1')).toMatchObject({ ahead: 1, behind: 1 });

    expect(await ws.mergeLocal({ ...repo, check_command: 'test -f b.txt && test -f c.txt' }, 'dispatch/t-1', 'Merge t-1')).toEqual({ ok: true });
    expect(git(dir, 'log', '-1', '--format=%s', 'main')).toBe('Merge t-1');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('two\n'); // checked-out main updated
    expect(await ws.branchStatus(repo, 'dispatch/t-1')).toMatchObject({ merged: true });
    expect((await ws.readRepoFile(repo, 'b.txt')).toString()).toBe('two\n'); // files come from the owner's current main

    await ws.cleanup(1, [repo]);
    expect(existsSync(wt)).toBe(false);
    expect(git(dir, 'worktree', 'list')).not.toContain(wt);
  });

  it('starts new sessions from the owner\'s current main, and planners get a detached checkout', async () => {
    const dir = ownerRepo();
    const ws = new Workspaces(tmp('dsp-ws-'));
    const repo = localRepo(dir);
    writeFileSync(join(dir, 'new.txt'), 'x\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'latest');
    const wt = await ws.prepare(spec(repo, 2));
    expect(git(wt, 'log', '-1', '--format=%s')).toBe('latest');
    const planner = await ws.prepare(spec(repo, 3, null));
    expect(git(planner, 'branch', '--show-current')).toBe('');
  });

  it('runs the setup command once, only for new worktrees', async () => {
    const dir = ownerRepo();
    const ws = new Workspaces(tmp('dsp-ws-'));
    const repo = localRepo(dir, { setup_command: 'echo ready > .setup-ran' });
    const created: { repo: Repo; wt: string }[] = [];
    const wt = await ws.prepare(spec(repo, 4), created);
    expect(await ws.setup(repo, wt)).toMatchObject({ ok: true });
    expect(readFileSync(join(wt, '.setup-ran'), 'utf8')).toBe('ready\n');
    const again: { repo: Repo; wt: string }[] = [];
    await ws.prepare(spec(repo, 4), again);
    expect(again).toEqual([]); // reopened session: no second setup
    expect(await ws.setup({ ...repo, setup_command: 'exit 4' }, wt)).toMatchObject({ ok: false });
  });

  it('can still use a separate clone when the repo asks for it', async () => {
    const dir = ownerRepo();
    const ws = new Workspaces(tmp('dsp-ws-'));
    const repo = localRepo(dir, { worktree_from: 'clone' });
    const wt = await ws.prepare(spec(repo, 5));
    expect(Workspaces.isAttached(wt, repo)).toBe(false);
    writeFileSync(join(wt, 'b.txt'), 'two\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'add b');
    expect(git(dir, 'branch', '--list', 'dispatch/t-5')).toBe(''); // not in the owner's repo until pushed
    await ws.pushBranch(repo, 5, 'dispatch/t-5');
    expect(git(dir, 'branch', '--list', 'dispatch/t-5')).toContain('dispatch/t-5');
  });
});

describe('clones keep their default branch current', () => {
  it('moves the clone\'s local main with the remote after each fetch', async () => {
    const remoteRoot = tmp('dsp-remote-');
    const bare = join(remoteRoot, 'me', 'hc.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    const seed = tmp('dsp-seed-');
    git(seed, 'init', '-b', 'main');
    writeFileSync(join(seed, 'a.txt'), '1\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'one');
    git(seed, 'push', bare, 'main');
    const ws = new Workspaces(tmp('dsp-ws-'), `file://${remoteRoot}`);
    const repo: Repo = { id: 1, project_id: 1, github_owner: 'me', github_name: 'hc', default_branch: 'main', check_command: null, local_path: null, worktree_from: null, setup_command: null };
    await ws.prepare(spec(repo, 1));
    writeFileSync(join(seed, 'a.txt'), '2\n');
    git(seed, 'commit', '-am', 'two');
    git(seed, 'push', bare, 'main');
    const cache = await ws.ensureCache(repo);
    expect(git(cache, 'log', '-1', '--format=%s', 'main')).toBe('two'); // not frozen at clone time
    expect(git(cache, 'rev-parse', 'main')).toBe(git(cache, 'rev-parse', 'origin/main'));
  });
});
