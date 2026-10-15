import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Workspaces } from '../src/worker/workspace.ts';
import type { StartSpec } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS, type Repo } from '../src/shared/types.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

describe('Workspaces (git)', () => {
  let remoteRoot: string;
  let ws: Workspaces;
  let repo: Repo;
  const spec = (branch: string | null, id = 1): StartSpec => ({
    session_id: id, kind: branch ? 'work' : 'planner', project_key: 'HC', project_name: 'HC', importance_scale: [], effort_scale: [],
    title: 't', branch, repos: [repo], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS, resume: null, resume_note: null,
  });

  beforeEach(() => {
    remoteRoot = mkdtempSync(join(tmpdir(), 'dsp-remote-'));
    const bare = join(remoteRoot, 'me', 'hc.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    const seed = mkdtempSync(join(tmpdir(), 'dsp-seed-'));
    git(seed, 'init', '-b', 'main');
    writeFileSync(join(seed, 'a.txt'), 'one\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'init');
    git(seed, 'push', bare, 'main');
    ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')), `file://${remoteRoot}`);
    repo = { id: 1, project_id: 1, github_owner: 'me', github_name: 'hc', default_branch: 'main', check_command: null, local_path: null, worktree_from: null, setup_command: null };
  });

  it('creates a worktree on the session branch and pushes it', async () => {
    const cwd = await ws.prepare(spec('dispatch/hc-1-x'));
    expect(git(cwd, 'branch', '--show-current')).toBe('dispatch/hc-1-x');
    writeFileSync(join(cwd, 'b.txt'), 'two\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'add b');
    await ws.pushBranch(repo, 1, 'dispatch/hc-1-x');
    expect(git(join(remoteRoot, 'me', 'hc.git'), 'branch', '--list', 'dispatch/hc-1-x')).toContain('dispatch/hc-1-x');
    // preparing again reuses the worktree
    expect(await ws.prepare(spec('dispatch/hc-1-x'))).toBe(cwd);
  });

  it('checks out an existing remote branch when a session continues work on it', async () => {
    const cwd = await ws.prepare(spec('dispatch/hc-1-x'));
    writeFileSync(join(cwd, 'b.txt'), 'two\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'add b');
    await ws.pushBranch(repo, 1, 'dispatch/hc-1-x');
    await ws.cleanup(1, [repo]);
    const again = await ws.prepare(spec('dispatch/hc-1-x', 2));
    expect(git(again, 'log', '-1', '--format=%s')).toBe('add b');
  });

  it('merges locally, runs the check and pushes the base branch', async () => {
    const cwd = await ws.prepare(spec('feat'));
    writeFileSync(join(cwd, 'b.txt'), 'two\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'add b');
    await ws.pushBranch(repo, 1, 'feat');
    const res = await ws.mergeLocal({ ...repo, check_command: 'test -f b.txt' }, 'feat', 'Merge #1');
    expect(res).toEqual({ ok: true });
    expect(git(join(remoteRoot, 'me', 'hc.git'), 'log', 'main', '-1', '--format=%s')).toBe('Merge #1');
  });

  it('reports a failing check without pushing', async () => {
    const cwd = await ws.prepare(spec('feat'));
    writeFileSync(join(cwd, 'b.txt'), 'two\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'add b');
    await ws.pushBranch(repo, 1, 'feat');
    const res = await ws.mergeLocal({ ...repo, check_command: 'exit 3' }, 'feat', 'Merge #1');
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/Check failed/);
    expect(git(join(remoteRoot, 'me', 'hc.git'), 'log', 'main', '-1', '--format=%s')).toBe('init');
  });

  it('reports conflicts and leaves the base branch alone', async () => {
    const cwd = await ws.prepare(spec('feat'));
    writeFileSync(join(cwd, 'a.txt'), 'branch\n');
    git(cwd, 'commit', '-am', 'branch edit');
    await ws.pushBranch(repo, 1, 'feat');
    const other = await ws.prepare(spec('other', 2));
    writeFileSync(join(other, 'a.txt'), 'main\n');
    git(other, 'commit', '-am', 'main edit');
    git(other, 'push', 'origin', 'HEAD:main');
    const res = await ws.mergeLocal(repo, 'feat', 'Merge #1');
    expect(res).toMatchObject({ ok: false, conflict: true });
    expect(git(join(remoteRoot, 'me', 'hc.git'), 'log', 'main', '-1', '--format=%s')).toBe('main edit');
  });

  it('gives planner sessions a detached read-only checkout of the base branch', async () => {
    const cwd = await ws.prepare(spec(null));
    expect(git(cwd, 'branch', '--show-current')).toBe('');
  });
});

describe('Workspaces edge cases', () => {
  it('reopens a cleaned-up session on its local branch without losing unpushed commits, and serializes parallel prepares', async () => {
    const remoteRoot = mkdtempSync(join(tmpdir(), 'dsp-remote-'));
    const bare = join(remoteRoot, 'me', 'hc.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    const seed = mkdtempSync(join(tmpdir(), 'dsp-seed-'));
    git(seed, 'init', '-b', 'main');
    writeFileSync(join(seed, 'a.txt'), 'one\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'init');
    git(seed, 'push', bare, 'main');
    const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')), `file://${remoteRoot}`);
    const repo: Repo = { id: 1, project_id: 1, github_owner: 'me', github_name: 'hc', default_branch: 'main', check_command: null, local_path: null, worktree_from: null, setup_command: null };
    const spec = (branch: string, id: number): StartSpec => ({
      session_id: id, kind: 'work', project_key: 'HC', project_name: 'HC', importance_scale: [], effort_scale: [],
      title: 't', branch, repos: [repo], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS, resume: null, resume_note: null,
    });
    // first use of a repo by three sessions at once: one clone, three worktrees
    const dirs = await Promise.all([ws.prepare(spec('b1', 1)), ws.prepare(spec('b2', 2)), ws.prepare(spec('b3', 3))]);
    expect(dirs.map((d) => git(d, 'branch', '--show-current'))).toEqual(['b1', 'b2', 'b3']);
    writeFileSync(join(dirs[0], 'local.txt'), 'unpushed\n');
    git(dirs[0], 'add', '.');
    git(dirs[0], 'commit', '-m', 'unpushed work');
    await ws.cleanup(1, [repo]);
    const again = await ws.prepare(spec('b1', 1));
    expect(git(again, 'log', '-1', '--format=%s')).toBe('unpushed work');
  });
});
