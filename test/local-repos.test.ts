import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Repo } from '../src/shared/types.ts';
import { Workspaces } from '../src/worker/workspace.ts';
import { startServer, startWorker, stopWorker, waitFor } from './helpers.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();

/** A local-only repo like the owner's: non-bare, main checked out, pushes update the working tree. */
function localRepo(root: string, name = 'tpl') {
  const dir = join(root, name);
  execFileSync('git', ['init', '-b', 'main', dir]);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  git(dir, 'config', 'receive.denyCurrentBranch', 'updateInstead');
  return dir;
}

describe('local repos in the worker', () => {
  it('branches, pushes into the folder, diffs, and merges into the checked-out main', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsp-local-'));
    const dir = localRepo(root);
    const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')));
    const repo: Repo = { id: 9, project_id: 1, github_owner: 'local', github_name: 'tpl', default_branch: 'main', check_command: 'test -f b.txt', local_path: dir, worktree_from: null, setup_command: null };
    const spec = { session_id: 5, kind: 'work' as const, project_key: 'L', project_name: 'L', importance_scale: [], effort_scale: [], title: 't', branch: 'dispatch/l-5-x', repos: [repo], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: null, resume: null, resume_note: null };
    const wt = await ws.prepare(spec);
    writeFileSync(join(wt, 'b.txt'), 'two\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'add b');
    await ws.pushBranch(repo, 5, 'dispatch/l-5-x');
    expect(git(dir, 'branch', '--list', 'dispatch/l-5-x')).toContain('dispatch/l-5-x'); // the branch is in the owner's repo

    expect(await ws.branchStatus(repo, 'dispatch/l-5-x')).toMatchObject({ exists: true, ahead: 1, behind: 0, merged: false, conflicts: false });
    const files = await ws.branchDiff(repo, 'dispatch/l-5-x');
    expect(files).toEqual([expect.objectContaining({ filename: 'b.txt', status: 'added', additions: 1, deletions: 0 })]);
    expect(files[0].patch).toContain('+two');

    expect(await ws.mergeLocal(repo, 'dispatch/l-5-x', 'Merge it')).toEqual({ ok: true });
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('two\n'); // working tree updated too
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Merge it');
    expect(await ws.branchStatus(repo, 'dispatch/l-5-x')).toMatchObject({ merged: true });
  });

  it('refuses to merge into a dirty checkout and says how to fix it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsp-local-'));
    const dir = localRepo(root);
    const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')));
    const repo: Repo = { id: 9, project_id: 1, github_owner: 'local', github_name: 'tpl', default_branch: 'main', check_command: null, local_path: dir, worktree_from: null, setup_command: null };
    git(dir, 'checkout', '-b', 'feat');
    writeFileSync(join(dir, 'c.txt'), 'x\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'c');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'a.txt'), 'edited, not committed\n');
    const res = await ws.mergeLocal(repo, 'feat', 'Merge feat');
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/uncommitted changes/);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('edited, not committed\n'); // untouched
    expect(existsSync(join(dir, 'c.txt'))).toBe(false);
  });
});

describe('local repos end to end on the server', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let worker: ChildProcess;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'dsp-local-'));
    s = await startServer();
    worker = startWorker(s.port, { LOCAL_REPO_DIRS: root, WORKSPACES_DIR: mkdtempSync(join(tmpdir(), 'dsp-ws-')) });
    await waitFor(() => s.ctx.hub.connected, 'worker');
    await s.call('POST', '/projects', { key: 'LOC', name: 'Local' });
  });
  afterAll(async () => {
    await stopWorker(worker);
    await s.app.close();
  });

  it('adds a local repo only inside LOCAL_REPO_DIRS and only if it is a git repo', async () => {
    const outside = localRepo(mkdtempSync(join(tmpdir(), 'dsp-out-')));
    const out = await s.call('POST', '/projects/LOC/repos', { local_path: outside });
    expect(out.status).toBe(400);
    expect(out.data.error).toMatch(/outside LOCAL_REPO_DIRS/);
    const notGit = mkdtempSync(join(root, 'plain-'));
    expect((await s.call('POST', '/projects/LOC/repos', { local_path: notGit })).data.error).toMatch(/not a git repository/);
    const dir = localRepo(root);
    const r = (await s.call('POST', '/projects/LOC/repos', { local_path: dir })).data;
    expect(r).toMatchObject({ github_owner: 'local', github_name: 'tpl', default_branch: 'main', local_path: dir, note: null });
  });

  it('shows a pushed session branch for review, with its diff, and merges it into the folder', async () => {
    const repo = (await s.call('GET', '/projects/LOC')).data.repos[0];
    const item = (await s.call('POST', '/projects/LOC/items', { title: 'Add b', status: 'in_progress' })).data; // as a started batch leaves it
    const session = s.ctx.store.createSession({
      project_id: repo.project_id, kind: 'work', title: 'Add b', status: 'idle', force_plan: false, branch: 'dispatch/loc-1-add-b',
      initial_prompt: '', source_id: null, item_ids: [item.id],
    });
    // what the agent does: commit on its branch and push it to origin (the local folder)
    git(repo.local_path, 'checkout', '-b', 'dispatch/loc-1-add-b');
    writeFileSync(join(repo.local_path, 'b.txt'), 'two\n');
    git(repo.local_path, 'add', '.');
    git(repo.local_path, 'commit', '-m', 'add b');
    git(repo.local_path, 'checkout', 'main');

    const [review] = await s.ctx.github.syncSession(session);
    expect(review).toMatchObject({ local: true, number: -session.id, state: 'open', mergeable: true, head_ref: 'dispatch/loc-1-add-b' });
    expect((await s.call('GET', `/items/${item.id}`)).data.status).toBe('in_review');
    expect(s.ctx.notifier.sent.some((n) => n.title === 'LOC: branch ready for review')).toBe(true);
    expect((await s.call('GET', '/inbox')).data.prs.map((p: { id: number }) => p.id)).toContain(review.id);

    const detail = (await s.call('GET', `/prs/${review.id}`)).data;
    expect(detail.files).toEqual([expect.objectContaining({ filename: 'b.txt', additions: 1 })]);
    expect(detail.checks).toEqual([]);

    const merged = (await s.call('POST', `/prs/${review.id}/merge`, { how: 'github' })).data; // forced to a local merge
    expect(merged).toMatchObject({ ok: true, pr: { state: 'merged' } });
    expect(readFileSync(join(repo.local_path, 'b.txt'), 'utf8')).toBe('two\n');
    expect((await s.call('GET', `/items/${item.id}`)).data.status).toBe('done');
  });
});
