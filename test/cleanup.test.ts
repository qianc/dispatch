import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Repo } from '../src/shared/types.ts';
import { Workspaces } from '../src/worker/workspace.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dsp-tidy-'));
  const dir = join(root, 'tpl');
  execFileSync('git', ['init', '-b', 'main', dir]);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, '.gitignore'), '.venv/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')));
  const repo: Repo = { id: 1, project_id: 1, github_owner: 'local', github_name: 'tpl', default_branch: 'main', check_command: null, local_path: dir, worktree_from: null, setup_command: null };
  const session = async (id: number, branch: string | null) => {
    const spec = { session_id: id, kind: (branch ? 'work' : 'discuss') as 'work', project_key: 'T', project_name: 'T', importance_scale: [], effort_scale: [], title: 't', branch, repos: [repo], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: null, resume: null, resume_note: null };
    return ws.prepare(spec);
  };
  const commit = (wt: string, file: string) => {
    writeFileSync(join(wt, file), 'x\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', file);
  };
  const branches = () => git(dir, 'branch', '--list', 'dispatch/*').split('\n').map((b) => b.replace(/^[*+ ]+/, '').trim()).filter(Boolean);
  return { dir, ws, repo, session, commit, branches };
}

describe('tidying what finished sessions leave on disk', () => {
  it('a merged session: worktree and branch go, setup leftovers do not keep it', async () => {
    const t = setup();
    const wt = await t.session(5, 'dispatch/t-5-x');
    t.commit(wt, 'b.txt');
    writeFileSync(join(wt, 'notes.tmp'), 'untracked, from a test run');
    git(t.dir, 'merge', '--no-ff', '-m', 'merge', 'dispatch/t-5-x');
    expect(await t.ws.leftovers(5, [t.repo], 'dispatch/t-5-x')).toEqual([expect.objectContaining({ worktree: true, dirty: false, untracked: true, branch: 'dispatch/t-5-x', merged: true })]);
    const res = await t.ws.tidy(5, [t.repo], 'dispatch/t-5-x', { deleteMerged: true, force: false });
    expect(res).toEqual([{ repo: 'tpl', worktree: 'removed', branch: 'deleted' }]);
    expect(existsSync(wt)).toBe(false);
    expect(t.branches()).toEqual([]);
    expect(git(t.dir, 'worktree', 'list')).not.toContain('/sessions/5/');
  });

  it('unmerged work stays: the branch always, the worktree while it has new or changed files', async () => {
    const t = setup();
    const wt = await t.session(6, 'dispatch/t-6-y');
    t.commit(wt, 'c.txt');
    writeFileSync(join(wt, 'draft.md'), 'not committed yet');
    expect(await t.ws.tidy(6, [t.repo], 'dispatch/t-6-y', { deleteMerged: true, force: false })).toEqual([{ repo: 'tpl', worktree: 'kept (uncommitted changes)', branch: 'kept (not merged)' }]);
    expect(existsSync(join(wt, 'draft.md'))).toBe(true);
    // a squash-merged PR: not in the history, but merged (the server says so)
    const res = await t.ws.tidy(6, [t.repo], 'dispatch/t-6-y', { deleteMerged: true, force: false, mergedHint: [1] });
    expect(res).toEqual([{ repo: 'tpl', worktree: 'removed', branch: 'deleted' }]);
  });

  it('changed tracked files keep a worktree even when merged, unless forced', async () => {
    const t = setup();
    const wt = await t.session(7, 'dispatch/t-7-z');
    t.commit(wt, 'd.txt');
    git(t.dir, 'merge', '--no-ff', '-m', 'merge', 'dispatch/t-7-z');
    writeFileSync(join(wt, 'a.txt'), 'edited after the merge\n');
    expect((await t.ws.tidy(7, [t.repo], 'dispatch/t-7-z', { deleteMerged: true, force: false }))[0]).toEqual({ repo: 'tpl', worktree: 'kept (uncommitted changes)', branch: 'kept' });
    expect(t.branches()).toEqual(['dispatch/t-7-z']); // the branch stays with its worktree
    expect((await t.ws.tidy(7, [t.repo], 'dispatch/t-7-z', { deleteMerged: true, force: true }))[0]).toEqual({ repo: 'tpl', worktree: 'removed', branch: 'deleted' });
  });

  it('a chat checkout goes; a stopped session keeps its branch', async () => {
    const t = setup();
    const chat = await t.session(8, null);
    expect(await t.ws.tidy(8, [t.repo], null, { deleteMerged: false, force: true })).toEqual([{ repo: 'tpl', worktree: 'removed', branch: 'none' }]);
    expect(existsSync(chat)).toBe(false);
    const wt = await t.session(9, 'dispatch/t-9-w');
    t.commit(wt, 'e.txt');
    expect(await t.ws.tidy(9, [t.repo], 'dispatch/t-9-w', { deleteMerged: false, force: false })).toEqual([{ repo: 'tpl', worktree: 'removed', branch: 'kept (not merged)' }]);
    expect(t.branches()).toEqual(['dispatch/t-9-w']);
  });
});

describe('the janitor on the server', () => {
  it('cleans up a merged session when it is completed, and offers older leftovers in the inbox', async () => {
    const { startServer, startWorker, stopWorker, waitFor } = await import('./helpers.ts');
    const root = mkdtempSync(join(tmpdir(), 'dsp-jan-'));
    const wsDir = mkdtempSync(join(tmpdir(), 'dsp-jan-ws-'));
    const dir = join(root, 'tpl');
    execFileSync('git', ['init', '-b', 'main', dir]);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'init');
    git(dir, 'config', 'receive.denyCurrentBranch', 'updateInstead');
    const s = await startServer();
    s.ctx.janitor.closeDelayMs = 0;
    const worker = startWorker(s.port, { LOCAL_REPO_DIRS: root, WORKSPACES_DIR: wsDir });
    try {
      await waitFor(() => s.ctx.hub.connected, 'worker');
      await s.call('POST', '/projects', { key: 'JAN', name: 'Janitor' });
      const repo = (await s.call('POST', '/projects/JAN/repos', { local_path: dir })).data as Repo;
      const ws = new Workspaces(wsDir); // the worker's folders, to set up what a session leaves
      const make = async (title: string) => {
        const sess = s.ctx.store.createSession({ project_id: repo.project_id, kind: 'work', title, status: 'idle', force_plan: false, branch: `dispatch/jan-${title}`, initial_prompt: '', source_id: null, item_ids: [] });
        const spec = { session_id: sess.id, kind: 'work' as const, project_key: 'JAN', project_name: 'J', importance_scale: [], effort_scale: [], title, branch: sess.branch, repos: [repo], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: null, resume: null, resume_note: null };
        const wt = await ws.prepare(spec);
        writeFileSync(join(wt, `${title}.txt`), 'x\n');
        git(wt, 'add', '.');
        git(wt, 'commit', '-m', title);
        git(dir, 'merge', '--no-ff', '-m', `merge ${title}`, sess.branch!);
        return { sess, wt };
      };
      const branches = () => git(dir, 'branch', '--list', 'dispatch/*');

      // completing it tidies at once
      const a = await make('a');
      await s.call('POST', `/sessions/${a.sess.id}/finish`, { status: 'completed' });
      await waitFor(() => !existsSync(a.wt) && !branches().includes('jan-a'), 'session a tidied');
      // the event is written once the worker's answer is back, a moment after the folder is gone
      const texts = async () => (await s.call('GET', `/sessions/${a.sess.id}`)).data.events.map((e: { body: { text?: string } }) => e.body.text);
      await waitFor(async () => (await texts()).includes('Cleaned up. tpl: worktree removed; tpl: branch deleted.'), 'cleanup event');

      // one finished before this existed: found by the check, offered, cleaned on request
      const b = await make('b');
      s.ctx.store.updateSession(b.sess.id, { status: 'completed' });
      const offer = (await s.call('POST', '/cleanup/check')).data;
      expect(offer).toMatchObject({ worktrees: 1, branches: 1, sessions: [expect.objectContaining({ id: b.sess.id, title: 'b' })] });
      expect((await s.call('GET', '/inbox')).data.cleanup).toMatchObject({ branches: 1 });
      const res = (await s.call('POST', '/cleanup')).data;
      expect(res.left).toBeNull();
      expect(existsSync(b.wt)).toBe(false);
      expect(branches()).toBe('');
      expect((await s.call('GET', '/inbox')).data.cleanup).toBeNull();
    } finally {
      await stopWorker(worker);
      await s.app.close();
    }
  }, 40_000);
});
