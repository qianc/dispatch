import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Repo } from '../src/shared/types.ts';
import { serverAppUrl } from '../src/worker/config.ts';
import { Workspaces } from '../src/worker/workspace.ts';
import { workPrompt } from '../src/worker/prompts.ts';
import { startServer, OWNER } from './helpers.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();

describe('a worker on a hosted repo', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let repo: Repo;
  let secret: string;
  let workerId: number;
  beforeAll(async () => {
    s = await startServer({ DATA_DIR: mkdtempSync(join(tmpdir(), 'dsp-hwk-')) });
    const p = s.ctx.store.createProject({ key: 'HW', name: 'Hosted work', description: '', default_force_plan: false, importance_scale: ['a', 'b', 'c', 'd'], effort_scale: ['S'] });
    repo = s.ctx.store.addRepo(p.id, { github_owner: 'hosted', github_name: 'app', default_branch: 'main', check_command: null, kind: 'hosted' });
    // the repo has a first commit on main (made on the server's side)
    const seed = mkdtempSync(join(tmpdir(), 'dsp-hseed-'));
    git(seed, 'init', '--quiet', '-b', 'main');
    writeFileSync(join(seed, 'a.txt'), 'one\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '--quiet', '-m', 'one');
    await s.ctx.hosted.importFrom(repo, seed, {});
    ({ secret, worker: { id: workerId } } = s.ctx.workers.create('linux', '', OWNER));
  });
  afterAll(() => s.app.close());

  it('prepares a session worktree from the server, and pushes the branch back to it', async () => {
    const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-hws-')), 'https://github.com', () => ({}), { base: `${serverAppUrl(`ws://127.0.0.1:${s.port}/worker`)}/git`, token: secret });
    const spec = { session_id: 7, kind: 'work' as const, project_key: 'HW', project_name: 'HW', importance_scale: [], effort_scale: [], title: 't', branch: 'dispatch/hw-7-x', repos: [repo], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: null, resume: null, resume_note: null };
    const wt = await ws.prepare(spec);
    expect(git(wt, 'log', '--oneline', '-1')).toContain('one');
    writeFileSync(join(wt, 'b.txt'), 'two\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '--quiet', '-m', 'two');
    await ws.pushBranch(repo, 7, 'dispatch/hw-7-x');
    expect(await s.ctx.hosted.branchStatus(repo, 'dispatch/hw-7-x')).toMatchObject({ exists: true, ahead: 1 });
    // the token never ends up in the clone's config
    expect(git(ws.cacheDir(repo), 'config', '--list')).not.toContain(secret);
  });

  it('a merge on the worker (a repo with a check command) runs the check and pushes the result to the server', async () => {
    const checked = { ...repo, check_command: 'test -f b.txt' };
    const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-hwm-')), 'https://github.com', () => ({}), { base: `${serverAppUrl(`ws://127.0.0.1:${s.port}/worker`)}/git`, token: secret });
    const head = git(s.ctx.hosted.dir(repo), 'rev-parse', 'refs/heads/dispatch/hw-7-x');
    // no merge job on the server for this worker: its push of main is refused (DISP-224)
    const refused = await ws.mergeLocal(checked, 'dispatch/hw-7-x', 'Merge dispatch/hw-7-x');
    expect(refused).toMatchObject({ ok: false });
    expect(refused.output).toMatch(/changes only through a merge in Dispatch/);
    // the server's merge job (as github.ts runs it): the branch from the test above is merged, at the commit looked at
    const res = await s.ctx.hosted.whileMerging(repo, workerId, () => ws.mergeLocal(checked, 'dispatch/hw-7-x', 'Merge dispatch/hw-7-x', undefined, [], undefined, head));
    expect(res).toMatchObject({ ok: true });
    expect((await s.ctx.hosted.readFile(repo, 'b.txt')).toString()).toBe('two\n');
    expect(await s.ctx.hosted.branchStatus(repo, 'dispatch/hw-7-x')).toMatchObject({ merged: true });
  });

  it('a merge on the worker refuses a branch that moved on since it was looked at (DISP-232)', async () => {
    const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-hwv-')), 'https://github.com', () => ({}), { base: `${serverAppUrl(`ws://127.0.0.1:${s.port}/worker`)}/git`, token: secret });
    const spec = { session_id: 8, kind: 'work' as const, project_key: 'HW', project_name: 'HW', importance_scale: [], effort_scale: [], title: 't', branch: 'dispatch/hw-8-y', repos: [repo], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: null, resume: null, resume_note: null };
    const wt = await ws.prepare(spec);
    writeFileSync(join(wt, 'c.txt'), 'reviewed\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '--quiet', '-m', 'reviewed');
    await ws.pushBranch(repo, 8, 'dispatch/hw-8-y');
    const reviewed = git(s.ctx.hosted.dir(repo), 'rev-parse', 'refs/heads/dispatch/hw-8-y');
    // the next turn pushes another commit before the merge
    writeFileSync(join(wt, 'c.txt'), 'not reviewed\n');
    git(wt, 'commit', '--quiet', '-am', 'later');
    await ws.pushBranch(repo, 8, 'dispatch/hw-8-y');
    const main = git(s.ctx.hosted.dir(repo), 'rev-parse', 'refs/heads/main');
    const res = await s.ctx.hosted.whileMerging(repo, workerId, () => ws.mergeLocal({ ...repo, check_command: 'true' }, 'dispatch/hw-8-y', 'Merge', undefined, [], undefined, reviewed));
    expect(res).toMatchObject({ ok: false, moved: true });
    expect(git(s.ctx.hosted.dir(repo), 'rev-parse', 'refs/heads/main')).toBe(main);
  });

  it('tells the agent to commit, not to push or open a PR', () => {
    const text = workPrompt({ session_id: 1, kind: 'work', project_key: 'HW', project_name: 'HW', importance_scale: [], effort_scale: [], title: 't', branch: 'dispatch/hw-1-x', repos: [repo], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: null, resume: null, resume_note: null });
    expect(text).toContain('app (hosted by Dispatch');
    expect(text).toMatch(/Repos hosted by Dispatch: commit your work and stop; do not push/);
  });
});
