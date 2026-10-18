import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Repo } from '../src/shared/types.ts';
import { startServer } from './helpers.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();

/**
 * A server with a hosted repo (one commit on main), a work session on it, and the session's branch
 * pushed into the server's repo, as a worker would. `gh` is a folder standing in for github.com.
 */
async function setup(opts: { upstream?: boolean; check?: string } = {}) {
  const gh = mkdtempSync(join(tmpdir(), 'dsp-hrgh-'));
  const upstream = join(gh, 'me', 'app.git');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', upstream]);
  const s = await startServer({ DATA_DIR: mkdtempSync(join(tmpdir(), 'dsp-hrd-')), GITHUB_GIT_BASE: gh });
  await s.call('POST', '/projects', { key: 'HV', name: 'Hosted review' });
  const seed = mkdtempSync(join(tmpdir(), 'dsp-hrs-'));
  git(seed, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'one');
  const p = s.ctx.store.projectByKey('HV')!;
  let repo: Repo = s.ctx.store.addRepo(p.id, { github_owner: 'hosted', github_name: 'app', default_branch: 'main', check_command: opts.check ?? null, kind: 'hosted', upstream_owner: opts.upstream ? 'me' : null, upstream_name: opts.upstream ? 'app' : null });
  await s.ctx.hosted.importFrom(repo, seed, {});
  repo = s.ctx.store.repo(repo.id)!;
  const item = (await s.call('POST', '/projects/HV/items', { title: 'Add b' })).data;
  const session = s.ctx.store.createSession({
    project_id: p.id, kind: 'work', title: 'Add b', status: 'idle', force_plan: false, branch: 'dispatch/hv-1-add-b',
    initial_prompt: '', source_id: null, item_ids: [item.id], options: DEFAULT_RUN_OPTIONS,
  });
  // the worker's push of the session branch
  const w = mkdtempSync(join(tmpdir(), 'dsp-hrw-'));
  git(w, 'clone', '--quiet', s.ctx.hosted.dir(repo), '.');
  git(w, 'checkout', '--quiet', '-b', session.branch!);
  writeFileSync(join(w, 'b.txt'), 'two\n');
  git(w, 'add', '.');
  git(w, 'commit', '--quiet', '-m', 'Add b (HV-1)');
  git(w, 'push', '--quiet', 'origin', session.branch!);
  return { s, repo, session, item, upstream, w };
}

describe('review and merge of hosted repos in Dispatch', () => {
  it('shows the pushed branch for review and its diff, with no worker online', async () => {
    const { s, session } = await setup();
    try {
      const [row] = await s.ctx.github.syncSession(session);
      expect(row).toMatchObject({ number: -session.id, state: 'open', local: true, mergeable: true, head_ref: session.branch });
      const detail = (await s.call('GET', `/prs/${row.id}`)).data;
      expect(detail.files.map((f: { filename: string }) => f.filename)).toEqual(['b.txt']);
      expect(detail.base_ref).toBe('main');
      expect(s.ctx.hub.connected).toBe(false);
    } finally {
      await s.app.close();
    }
  });

  it('merges on the server: the default branch gets the work, the items are done', async () => {
    const { s, repo, session, item } = await setup();
    try {
      const [row] = await s.ctx.github.syncSession(session);
      const r = await s.call('POST', `/prs/${row.id}/merge`, { how: 'local', method: 'squash' });
      expect(r.status).toBe(200);
      expect(r.data).toMatchObject({ ok: true, pr: { state: 'merged' } });
      expect((await s.ctx.hosted.readFile(repo, 'b.txt')).toString()).toBe('two\n');
      expect((await s.call('GET', `/items/${item.id}`)).data.status).toBe('done');
    } finally {
      await s.app.close();
    }
  });

  it('with a check command, the merge goes to the session worker (which runs the check)', async () => {
    const { s, session } = await setup({ check: 'npm test' });
    try {
      const [row] = await s.ctx.github.syncSession(session);
      const asked: string[] = [];
      s.ctx.hub.cmd = (async (_w: unknown, cmd: { c: string }) => { asked.push(cmd.c); return { ok: false, output: 'Check failed (npm test)' }; }) as typeof s.ctx.hub.cmd;
      const r = await s.call('POST', `/prs/${row.id}/merge`, { how: 'local', method: 'merge' });
      expect(asked).toEqual(['merge_local']);
      expect(r.data).toMatchObject({ ok: false, output: 'Check failed (npm test)' });
    } finally {
      await s.app.close();
    }
  });

  it('pushes the merged default branch to the upstream; a failed push is told once', async () => {
    const { s, repo, session, upstream } = await setup({ upstream: true });
    try {
      const [row] = await s.ctx.github.syncSession(session);
      await s.call('POST', `/prs/${row.id}/merge`, { how: 'local', method: 'merge' });
      expect(git(upstream, 'rev-parse', 'refs/heads/main')).toBe(git(s.ctx.hosted.dir(repo), 'rev-parse', 'refs/heads/main'));
      // the upstream disappears: the next merge is still done here, and the owner hears about the push
      execFileSync('rm', ['-rf', upstream]);
      const s2 = s.ctx.store.createSession({ project_id: repo.project_id, kind: 'work', title: 'More', status: 'idle', force_plan: false, branch: 'dispatch/hv-2-more', initial_prompt: '', source_id: null, item_ids: [], options: DEFAULT_RUN_OPTIONS });
      const w = mkdtempSync(join(tmpdir(), 'dsp-hrw2-'));
      git(w, 'clone', '--quiet', s.ctx.hosted.dir(repo), '.');
      git(w, 'checkout', '--quiet', '-b', s2.branch!);
      writeFileSync(join(w, 'c.txt'), 'c\n');
      git(w, 'add', '.');
      git(w, 'commit', '--quiet', '-m', 'c');
      git(w, 'push', '--quiet', 'origin', s2.branch!);
      const [row2] = await s.ctx.github.syncSession(s2);
      const r = await s.call('POST', `/prs/${row2.id}/merge`, { how: 'local', method: 'merge' });
      expect(r.data).toMatchObject({ ok: true });
      expect((await s.ctx.hosted.readFile(repo, 'c.txt')).toString()).toBe('c\n');
      expect(s.ctx.notifier.sent.filter((n) => n.title.includes('not pushed to GitHub'))).toHaveLength(1);
    } finally {
      await s.app.close();
    }
  });

  it('opens a PR on the upstream instead; merged there, it comes back into the hosted repo', async () => {
    const { s, repo, session, upstream } = await setup({ upstream: true });
    try {
      // the upstream starts like the hosted repo
      await s.ctx.hosted.pushUpstream(repo, upstream, ['refs/heads/main'], {});
      let merged = false;
      const created: unknown[] = [];
      const pr = () => ({ number: 12, html_url: 'https://github.com/me/app/pull/12', title: 'Add b', state: merged ? 'closed' : 'open', merged_at: merged ? 'now' : null, mergeable: true, mergeable_state: 'clean', head: { ref: session.branch, sha: 'x' }, base: { ref: 'main' }, body: '' });
      Object.defineProperty(s.ctx.github, 'octo', { value: {
        pulls: {
          create: async (a: unknown) => { created.push(a); return { data: pr() }; },
          get: async () => ({ data: pr() }),
          list: async () => ({ data: created.length ? [pr()] : [] }),
        },
        checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
        repos: { compareCommits: async () => ({ data: { behind_by: 0 } }) },
      } });
      const [row] = await s.ctx.github.syncSession(session);
      const r = await s.call('POST', `/prs/${row.id}/github-pr`);
      expect(r.status).toBe(200);
      expect(created).toEqual([expect.objectContaining({ owner: 'me', repo: 'app', head: session.branch, base: 'main' })]);
      expect(git(upstream, 'branch', '--list')).toContain(session.branch);
      expect(r.data).toMatchObject({ number: 12, local: false });
      expect(s.ctx.store.pr(row.id)!.state).toBe('closed'); // the review in Dispatch gave way to the PR

      // merged on GitHub: simulate GitHub's merge in the upstream, then sync
      const u = mkdtempSync(join(tmpdir(), 'dsp-hru-'));
      git(u, 'clone', '--quiet', upstream, '.');
      git(u, 'merge', '--quiet', '--no-ff', '-m', 'Merge PR 12', `origin/${session.branch}`);
      git(u, 'push', '--quiet', 'origin', 'main');
      merged = true;
      await s.ctx.github.syncSession(s.ctx.store.session(session.id)!);
      expect((await s.ctx.hosted.readFile(repo, 'b.txt')).toString()).toBe('two\n');
      expect(s.ctx.store.prs({ session_id: session.id }).find((p) => p.number === 12)?.state).toBe('merged');
    } finally {
      await s.app.close();
    }
  });
});

describe('hosted repos elsewhere in the app', () => {
  it('repo file links read from the server, and merged branches are deleted there', async () => {
    const { s, repo, session } = await setup();
    try {
      const r = await fetch(`${s.base}/api/projects/HV/file?path=a.txt`);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('one\n');
      const [row] = await s.ctx.github.syncSession(session);
      await s.call('POST', `/prs/${row.id}/merge`, { how: 'local', method: 'merge' });
      expect(await s.ctx.github.deleteRemoteBranch(repo, session.branch!)).toBe(true);
      expect(await s.ctx.hosted.branchStatus(repo, session.branch!)).toMatchObject({ exists: false });
    } finally {
      await s.app.close();
    }
  });
});
