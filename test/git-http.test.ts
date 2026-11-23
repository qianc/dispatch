import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, OWNER } from './helpers.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();
/** git with a bearer token header (as the worker sends it). Async: the test server runs in this process. */
const gitAuth = (cwd: string, token: string | null, ...a: string[]) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn('git', [...(token ? ['-c', `http.extraHeader=Authorization: Bearer ${token}`] : []), ...a], { cwd, env: ENV });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });

describe('git over HTTP for workers', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let secret: string;
  let workerId: number;
  let repoId: number;
  let githubRepoId: number;
  let url: string;
  beforeAll(async () => {
    s = await startServer({ DATA_DIR: mkdtempSync(join(tmpdir(), 'dsp-gh-data-')) });
    const p = s.ctx.store.createProject({ key: 'GH', name: 'Git', description: '', default_force_plan: false, importance_scale: ['a', 'b', 'c', 'd'], effort_scale: ['S'] });
    const repo = s.ctx.store.addRepo(p.id, { github_owner: 'hosted', github_name: 'app', default_branch: 'main', check_command: null, kind: 'hosted' });
    await s.ctx.hosted.create(repo, 'main');
    repoId = repo.id;
    githubRepoId = s.ctx.store.addRepo(p.id, { github_owner: 'me', github_name: 'gh', default_branch: 'main', check_command: null }).id;
    ({ secret, worker: { id: workerId } } = s.ctx.workers.create('linux', '', OWNER));
    url = `${s.base}/git/r${repoId}.git`;
  });
  afterAll(() => s.app.close());

  it('a worker clones, pushes main and a branch, and fetches them back', async () => {
    const w = mkdtempSync(join(tmpdir(), 'dsp-gh-w-'));
    expect((await gitAuth(w, secret, 'clone', '--quiet', url, '.')).code).toBe(0);
    writeFileSync(join(w, 'a.txt'), 'one\n');
    git(w, 'add', '.');
    git(w, 'commit', '--quiet', '-m', 'one');
    // main: only while the server runs a merge on this worker (DISP-224)
    expect((await s.ctx.hosted.whileMerging({ id: repoId }, workerId, () => gitAuth(w, secret, 'push', '--quiet', 'origin', 'main'))).code).toBe(0);
    git(w, 'checkout', '--quiet', '-b', 'dispatch/gh-1-x');
    writeFileSync(join(w, 'b.txt'), 'two\n');
    git(w, 'add', '.');
    git(w, 'commit', '--quiet', '-m', 'two');
    expect((await gitAuth(w, secret, 'push', '--quiet', 'origin', 'dispatch/gh-1-x')).code).toBe(0);
    expect(git(s.ctx.hosted.dir({ id: repoId }), 'branch', '--list')).toContain('dispatch/gh-1-x');

    const again = mkdtempSync(join(tmpdir(), 'dsp-gh-w2-'));
    expect((await gitAuth(again, s.ctx.workers.legacy() ? 'test-token' : secret, 'clone', '--quiet', url, '.')).code).toBe(0); // the legacy worker too
    expect(git(again, 'log', '--oneline', '-1')).toContain('one');
  });

  it('refuses a fast-forward of the default branch from a worker with no merge job for the repo (DISP-224)', async () => {
    const bare = s.ctx.hosted.dir({ id: repoId });
    const w = mkdtempSync(join(tmpdir(), 'dsp-gh-ff-'));
    expect((await gitAuth(w, secret, 'clone', '--quiet', url, '.')).code).toBe(0);
    writeFileSync(join(w, 'sneak.txt'), 'unreviewed\n');
    git(w, 'add', '.');
    git(w, 'commit', '--quiet', '-m', 'sneak');
    const before = git(bare, 'rev-parse', 'refs/heads/main');
    // any signed-in person can make a worker and use its token
    const other = s.ctx.workers.create('stranger', '', OWNER);
    for (const token of [secret, other.secret]) {
      const r = await gitAuth(w, token, 'push', '--quiet', 'origin', 'HEAD:main');
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/changes only through a merge in Dispatch/);
    }
    // a merge job on another worker, or for another repo, does not open it either
    const viaOther = await s.ctx.hosted.whileMerging({ id: repoId }, other.worker.id, () => gitAuth(w, secret, 'push', '--quiet', 'origin', 'HEAD:main'));
    expect(viaOther.code).not.toBe(0);
    const otherRepo = await s.ctx.hosted.whileMerging({ id: repoId + 1000 }, workerId, () => gitAuth(w, secret, 'push', '--quiet', 'origin', 'HEAD:main'));
    expect(otherRepo.code).not.toBe(0);
    expect(git(bare, 'rev-parse', 'refs/heads/main')).toBe(before);
    // once the merge is over, the window is closed again
    expect(s.ctx.hosted.mayPushDefault({ id: repoId }, workerId)).toBe(false);
    // a session branch is still free to push
    expect((await gitAuth(w, secret, 'push', '--quiet', 'origin', 'HEAD:dispatch/gh-2-y')).code).toBe(0);
  });

  it('refuses no token, a wrong token and a personal token', async () => {
    const personal = s.ctx.access.createToken('skills', ['read', 'tracker', 'sessions', 'admin'], null, s.ctx.cfg.installOwner).secret;
    for (const token of [null, 'dsw_wrong', personal]) {
      const d = mkdtempSync(join(tmpdir(), 'dsp-gh-x-'));
      const r = await gitAuth(d, token, 'clone', '--quiet', url, '.');
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/401|Authentication|could not read/i);
    }
    expect((await fetch(`${url}/info/refs?service=git-upload-pack`)).status).toBe(401);
  });

  it('only reaches hosted repos that exist, by their own path', async () => {
    const h = { authorization: `Bearer ${secret}` };
    expect((await fetch(`${s.base}/git/r999.git/info/refs?service=git-upload-pack`, { headers: h })).status).toBe(404);
    expect((await fetch(`${s.base}/git/r${githubRepoId}.git/info/refs?service=git-upload-pack`, { headers: h })).status).toBe(404);
    expect((await fetch(`${s.base}/git/r${repoId}.git/..%2F..%2Fdispatch.db`, { headers: h })).status).toBe(404);
    expect((await fetch(`${s.base}/git/r${repoId}.git/config`, { headers: h })).status).toBe(404);
  });
});
