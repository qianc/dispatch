import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostedGit } from '../src/server/hosted.ts';
import type { Repo } from '../src/shared/types.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();
const repo = (id: number, extra: Partial<Repo> = {}): Repo => ({ id, project_id: 1, github_owner: 'hosted', github_name: `r${id}`, default_branch: 'main', check_command: null, local_path: null, worktree_from: null, setup_command: null, kind: 'hosted', worker_id: null, ...extra });

/** A clone of the hosted repo where a test makes commits and pushes them. */
function workClone(h: HostedGit, r: Repo) {
  const dir = mkdtempSync(join(tmpdir(), 'dsp-hw-'));
  git(dir, 'clone', '--quiet', h.dir(r), '.');
  return dir;
}
const commit = (dir: string, file: string, text: string, msg = file) => {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', msg);
};

describe('hosted repos on the server', () => {
  it('a new repo has a first, empty commit on its default branch, so sessions have a base', async () => {
    const h = new HostedGit(mkdtempSync(join(tmpdir(), 'dsp-hd0-')));
    const r = repo(9, { default_branch: 'trunk' });
    await h.create(r, 'trunk');
    expect(git(h.dir(r), 'log', '--format=%s', 'trunk')).toBe('Start');
    expect(git(h.dir(r), 'ls-tree', '-r', 'trunk')).toBe('');
    const w = workClone(h, r);
    expect(git(w, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trunk');
  });

  it('creates an empty repo, then shows, diffs and merges a pushed branch', async () => {
    const h = new HostedGit(mkdtempSync(join(tmpdir(), 'dsp-hd-')));
    const r = repo(1);
    await h.create(r, 'main');
    const w = workClone(h, r);
    commit(w, 'a.txt', 'one\n');
    git(w, 'push', '--quiet', 'origin', 'main');
    git(w, 'checkout', '--quiet', '-b', 'dispatch/x-1');
    commit(w, 'b.txt', 'two\n');
    git(w, 'push', '--quiet', 'origin', 'dispatch/x-1');

    expect(await h.branchStatus(r, 'dispatch/x-1')).toMatchObject({ exists: true, ahead: 1, behind: 0, merged: false, conflicts: false });
    expect(await h.branchStatus(r, 'nope')).toMatchObject({ exists: false });
    expect((await h.branchDiff(r, 'dispatch/x-1')).map((f) => [f.filename, f.status, f.additions])).toEqual([['b.txt', 'added', 1]]);
    expect((await h.readFile(r, 'a.txt')).toString()).toBe('one\n');

    const m = await h.merge(r, 'dispatch/x-1', 'Merge x-1', 'merge');
    expect(m.ok).toBe(true);
    expect((await h.readFile(r, 'b.txt')).toString()).toBe('two\n');
    expect(await h.branchStatus(r, 'dispatch/x-1')).toMatchObject({ merged: true });
    expect(await h.deleteBranch(r, 'dispatch/x-1')).toBe(true);
    expect(await h.branchStatus(r, 'dispatch/x-1')).toMatchObject({ exists: false });
  });

  it('a squash merge makes one commit; a conflict leaves the default branch where it was', async () => {
    const h = new HostedGit(mkdtempSync(join(tmpdir(), 'dsp-hd-')));
    const r = repo(2);
    await h.create(r, 'main');
    const w = workClone(h, r);
    commit(w, 'a.txt', 'one\n');
    git(w, 'push', '--quiet', 'origin', 'main');
    git(w, 'checkout', '--quiet', '-b', 'feat');
    commit(w, 'a.txt', 'feature\n');
    commit(w, 'c.txt', 'c\n');
    git(w, 'push', '--quiet', 'origin', 'feat');
    git(w, 'checkout', '--quiet', 'main');
    git(w, 'checkout', '--quiet', '-b', 'other');
    commit(w, 'a.txt', 'other\n');
    git(w, 'push', '--quiet', 'origin', 'other');

    const before = git(h.dir(r), 'rev-parse', 'refs/heads/main');
    const sq = await h.merge(r, 'feat', 'Squash feat', 'squash');
    expect(sq.ok).toBe(true);
    const after = git(h.dir(r), 'rev-parse', 'refs/heads/main');
    expect(git(h.dir(r), 'rev-list', '--count', `${before}..${after}`)).toBe('1');
    expect(git(h.dir(r), 'log', '-1', '--format=%s', 'main')).toBe('Squash feat');

    const bad = await h.merge(r, 'other', 'Merge other', 'merge');
    expect(bad).toMatchObject({ ok: false, conflict: true });
    expect(git(h.dir(r), 'rev-parse', 'refs/heads/main')).toBe(after);
    expect(await h.branchStatus(r, 'other')).toMatchObject({ conflicts: true });
  });

  it('pushes to and fast-forwards from an upstream, and refuses a diverged one', async () => {
    const h = new HostedGit(mkdtempSync(join(tmpdir(), 'dsp-hd-')));
    const up = mkdtempSync(join(tmpdir(), 'dsp-up-'));
    git(up, 'init', '--quiet', '--bare', '-b', 'main');
    const r = repo(3, { upstream_owner: 'me', upstream_name: 'up' });
    await h.create(r, 'main');
    const w = workClone(h, r);
    commit(w, 'a.txt', 'one\n');
    git(w, 'push', '--quiet', 'origin', 'main');

    const url = up; // a path stands in for https://github.com/me/up.git
    expect((await h.pushUpstream(r, url, ['refs/heads/main'], {})).ok).toBe(true);
    expect(git(up, 'rev-parse', 'refs/heads/main')).toBe(git(h.dir(r), 'rev-parse', 'refs/heads/main'));

    // the upstream moves on (a PR merged there): the hosted repo follows
    const u = mkdtempSync(join(tmpdir(), 'dsp-uw-'));
    git(u, 'clone', '--quiet', up, '.');
    commit(u, 'd.txt', 'from github\n');
    git(u, 'push', '--quiet', 'origin', 'main');
    expect((await h.fetchUpstreamDefault(r, url, {})).ok).toBe(true);
    expect((await h.readFile(r, 'd.txt')).toString()).toBe('from github\n');

    // both moved: not a fast-forward, nothing overwritten
    commit(u, 'e.txt', 'e\n');
    git(u, 'push', '--quiet', 'origin', 'main');
    commit(w, 'f.txt', 'f\n');
    git(w, 'pull', '--quiet', '--rebase', 'origin', 'main');
    git(w, 'push', '--quiet', 'origin', 'main');
    const mine = git(h.dir(r), 'rev-parse', 'refs/heads/main');
    const res = await h.fetchUpstreamDefault(r, url, {});
    expect(res.ok).toBe(false);
    expect(git(h.dir(r), 'rev-parse', 'refs/heads/main')).toBe(mine);
  });

  it('imports an existing repo', async () => {
    const src = mkdtempSync(join(tmpdir(), 'dsp-src-'));
    git(src, 'init', '--quiet', '-b', 'trunk');
    commit(src, 'x.txt', 'x\n');
    const h = new HostedGit(mkdtempSync(join(tmpdir(), 'dsp-hd-')));
    const r = repo(4, { default_branch: 'trunk' });
    await h.importFrom(r, src, {});
    expect((await h.readFile(r, 'x.txt')).toString()).toBe('x\n');
    expect(git(h.dir(r), 'symbolic-ref', 'HEAD')).toBe('refs/heads/trunk');
  });
});

describe('making hosted repos', () => {
  it('creates an empty one, imports one from GitHub, links and unlinks an upstream, and keeps the data on delete', async () => {
    const { startServer } = await import('./helpers.ts');
    const { existsSync, readdirSync } = await import('node:fs');
    // a folder stands in for github.com: <base>/<owner>/<name>.git
    const gh = mkdtempSync(join(tmpdir(), 'dsp-ghbase-'));
    const src = join(gh, 'me', 'old.git');
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', src]);
    const w = mkdtempSync(join(tmpdir(), 'dsp-srcw-'));
    git(w, 'clone', '--quiet', src, '.');
    git(w, 'checkout', '--quiet', '-b', 'main');
    commit(w, 'readme.md', '# old\n');
    git(w, 'push', '--quiet', 'origin', 'main');

    const data = mkdtempSync(join(tmpdir(), 'dsp-hdata-'));
    const s = await startServer({ DATA_DIR: data, GITHUB_GIT_BASE: gh });
    try {
      await s.call('POST', '/projects', { key: 'HR', name: 'Hosted' });
      const blank = await s.call('POST', '/projects/HR/repos', { hosted: { name: 'app' } });
      expect(blank.status).toBe(200);
      expect(blank.data).toMatchObject({ kind: 'hosted', github_owner: 'hosted', github_name: 'app', default_branch: 'main', upstream_owner: null });
      expect(s.ctx.hosted.exists(blank.data)).toBe(true);

      const imported = await s.call('POST', '/projects/HR/repos', { hosted: { name: 'old', import: 'me/old', upstream: 'me/old' } });
      expect(imported.status).toBe(200);
      expect(imported.data).toMatchObject({ kind: 'hosted', upstream_owner: 'me', upstream_name: 'old' });
      expect((await s.ctx.hosted.readFile(s.ctx.store.repo(imported.data.id)!, 'readme.md')).toString()).toBe('# old\n');

      expect((await s.call('PATCH', `/repos/${blank.data.id}`, { upstream: 'me/new' })).data).toMatchObject({ upstream_owner: 'me', upstream_name: 'new' });
      expect((await s.call('PATCH', `/repos/${blank.data.id}`, { upstream: null })).data).toMatchObject({ upstream_owner: null });
      expect((await s.call('PATCH', `/repos/${blank.data.id}`, { upstream: 'not a repo' })).status).toBe(400);
      expect((await s.call('POST', '/projects/HR/repos', { hosted: { name: 'bad/name' } })).status).toBe(400);

      expect((await s.call('DELETE', `/repos/${blank.data.id}`)).status).toBe(200);
      expect(existsSync(s.ctx.hosted.dir(blank.data))).toBe(false);
      expect(readdirSync(join(data, 'git')).some((f) => f.startsWith(`r${blank.data.id}.deleted-`))).toBe(true);
    } finally {
      await s.app.close();
    }
  });
});
