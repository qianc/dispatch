import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Repo } from '../src/shared/types.ts';
import { ServerLink, Slots } from '../src/worker/serverLink.ts';
import { workPrompt } from '../src/worker/prompts.ts';
import { startServer, waitFor } from './helpers.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();
const gitAsync = (cwd: string, ...a: string[]) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn('git', a, { cwd, env: ENV });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });

async function hostedServer(extraEnv: Record<string, string> = {}) {
  const s = await startServer({ DATA_DIR: mkdtempSync(join(tmpdir(), 'dsp-p2r-')), ...extraEnv });
  await s.call('POST', '/projects', { key: 'PR2', name: 'Phase 2 review' });
  const repo = (await s.call('POST', '/projects/PR2/repos', { hosted: { name: 'app' } })).data as Repo;
  const secret = s.ctx.workers.create('linux', '').secret;
  const url = `${s.base}/git/r${repo.id}.git`;
  const w = mkdtempSync(join(tmpdir(), 'dsp-p2w-'));
  const auth = ['-c', `http.extraHeader=Authorization: Bearer ${secret}`];
  expect((await gitAsync(w, ...auth, 'clone', '--quiet', url, '.')).code).toBe(0);
  writeFileSync(join(w, 'a.txt'), 'one\n');
  git(w, 'add', '.');
  git(w, 'commit', '--quiet', '-m', 'one');
  expect((await gitAsync(w, ...auth, 'push', '--quiet', 'origin', 'main')).code).toBe(0);
  return { s, repo, secret, url, w, auth };
}

describe('phase 2 review fixes', () => {
  it('#1 a git request that fails mid-body does not take the server down', async () => {
    const { s, url, secret } = await hostedServer();
    try {
      // a broken gzip body: git gives up while the body still streams in
      const body = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), randomBytes(64 * 1024 * 1024)]);
      const r = await fetch(`${url}/git-upload-pack`, {
        method: 'POST', body, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/x-git-upload-pack-request', 'content-encoding': 'gzip' },
      }).catch(() => null);
      expect(r === null || r.status >= 400 || r.status === 200).toBe(true);
      await new Promise((res) => setTimeout(res, 300));
      expect((await s.call('GET', '/me')).status).toBe(200); // still alive
    } finally {
      await s.app.close();
    }
  });

  it('#2 a clone of a large repo streams (and works)', async () => {
    const { s, url, w, auth } = await hostedServer();
    try {
      writeFileSync(join(w, 'big.bin'), randomBytes(6 * 1024 * 1024));
      git(w, 'add', '.');
      git(w, 'commit', '--quiet', '-m', 'big');
      expect((await gitAsync(w, ...auth, 'push', '--quiet', 'origin', 'main')).code).toBe(0);
      const c = mkdtempSync(join(tmpdir(), 'dsp-p2c-'));
      expect((await gitAsync(c, ...auth, 'clone', '--quiet', url, '.')).code).toBe(0);
      expect(git(c, 'log', '--oneline', '-1')).toContain('big');
    } finally {
      await s.app.close();
    }
  });

  it('#3 later commits on a branch whose review moved to GitHub reach the GitHub PR', async () => {
    const gh = mkdtempSync(join(tmpdir(), 'dsp-p2gh-'));
    const upstream = join(gh, 'me', 'app.git');
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', upstream]);
    const { s, repo, w, auth } = await hostedServer({ GITHUB_GIT_BASE: gh });
    try {
      await s.call('PATCH', `/repos/${repo.id}`, { upstream: 'me/app' });
      const r = s.ctx.store.repo(repo.id)!;
      await s.ctx.hosted.pushUpstream(r, upstream, ['refs/heads/main'], {});
      const p = s.ctx.store.projectByKey('PR2')!;
      const session = s.ctx.store.createSession({ project_id: p.id, kind: 'work', title: 'T', status: 'idle', force_plan: false, branch: 'dispatch/pr2-1-t', initial_prompt: '', source_id: null, item_ids: [], options: DEFAULT_RUN_OPTIONS });
      git(w, 'checkout', '--quiet', '-b', session.branch!);
      writeFileSync(join(w, 'b.txt'), 'b\n');
      git(w, 'add', '.');
      git(w, 'commit', '--quiet', '-m', 'b');
      expect((await gitAsync(w, ...auth, 'push', '--quiet', 'origin', session.branch!)).code).toBe(0);
      let created = 0;
      const ghPr = () => ({ number: 5, html_url: 'u', title: 'T', state: 'open', merged_at: null, mergeable: true, mergeable_state: 'clean', head: { ref: session.branch, sha: 'old' }, base: { ref: 'main' }, body: '' });
      Object.defineProperty(s.ctx.github, 'octo', { value: {
        pulls: { create: async () => { created++; return { data: ghPr() }; }, get: async () => ({ data: ghPr() }), list: async () => ({ data: created ? [ghPr()] : [] }) },
        checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
        repos: { compareCommits: async () => ({ data: { behind_by: 0 } }) },
      } });
      const [row] = await s.ctx.github.syncSession(session);
      await s.call('POST', `/prs/${row.id}/github-pr`);
      // a review fix, pushed to Dispatch's repo as always
      writeFileSync(join(w, 'c.txt'), 'c\n');
      git(w, 'add', '.');
      git(w, 'commit', '--quiet', '-m', 'review fix');
      expect((await gitAsync(w, ...auth, 'push', '--quiet', 'origin', session.branch!)).code).toBe(0);
      await s.ctx.github.syncSession(s.ctx.store.session(session.id)!);
      expect(git(upstream, 'log', '--format=%s', '-1', session.branch!)).toBe('review fix');
    } finally {
      await s.app.close();
    }
  });

  it('#4 the default branch cannot be force-pushed or deleted, and ref changes are logged', async () => {
    const { s, repo, w, auth } = await hostedServer();
    try {
      git(w, 'commit', '--quiet', '--amend', '-m', 'rewritten');
      const force = await gitAsync(w, ...auth, 'push', '--quiet', '--force', 'origin', 'main');
      expect(force.code).not.toBe(0);
      const del = await gitAsync(w, ...auth, 'push', '--quiet', 'origin', ':main');
      expect(del.code).not.toBe(0);
      // other branches: normal, also deleting them
      git(w, 'checkout', '--quiet', '-b', 'topic');
      expect((await gitAsync(w, ...auth, 'push', '--quiet', 'origin', 'topic')).code).toBe(0);
      expect((await gitAsync(w, ...auth, 'push', '--quiet', 'origin', ':topic')).code).toBe(0);
      expect(git(s.ctx.hosted.dir(repo), 'config', 'core.logAllRefUpdates')).toBe('always');
    } finally {
      await s.app.close();
    }
  });

  it('#5 agents get no worker token: they commit, and the worker pushes the branch at the end of the turn', async () => {
    const { s, repo, secret } = await hostedServer();
    try {
      const entry = { name: 'default', url: `ws://127.0.0.1:${s.port}/worker`, token: secret, local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: null, releases: [] };
      const link = new ServerLink(entry, {
        fake: false, opts: { assistantReadDirs: [], sessionEnv: () => ({ A: '1' }) } as never, workspacesDir: mkdtempSync(join(tmpdir(), 'dsp-p2l-')), first: true, slots: new Slots(1),
        claudeAccounts: () => [], githubAccounts: [], gitEnv: () => ({}), remoteBase: 'https://github.com',
      });
      const spec = { session_id: 3, kind: 'work' as const, project_key: 'PR2', project_name: 'P', importance_scale: [], effort_scale: [], title: 't', branch: 'dispatch/pr2-3-t', repos: [repo], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: null, resume: null, resume_note: null };
      const env = (link as unknown as { opts: { sessionEnv: (x: unknown) => Record<string, string> } }).opts.sessionEnv(spec);
      expect(JSON.stringify(env)).not.toContain(secret);
      expect(workPrompt(spec)).toMatch(/Repos hosted by Dispatch: commit your work and stop; do not push/);
      // the agent's commit in its worktree, then the turn ends
      const wt = await link.workspaces.prepare(spec);
      writeFileSync(join(wt, 'x.txt'), 'x\n');
      git(wt, 'add', '.');
      git(wt, 'commit', '--quiet', '-m', 'x');
      await link.pushHostedBranches(spec);
      await waitFor(async () => (await s.ctx.hosted.branchStatus(repo, spec.branch)).exists, 'branch on the server');
    } finally {
      await s.app.close();
    }
  });

  it('#6 an imported repo keeps its own default branch, and changing it moves HEAD', async () => {
    const gh = mkdtempSync(join(tmpdir(), 'dsp-p2gh6-'));
    const src = join(gh, 'me', 'old.git');
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'master', src]);
    const t = mkdtempSync(join(tmpdir(), 'dsp-p2t-'));
    git(t, 'clone', '--quiet', src, '.');
    git(t, 'checkout', '--quiet', '-b', 'master');
    writeFileSync(join(t, 'r.md'), 'r\n');
    git(t, 'add', '.');
    git(t, 'commit', '--quiet', '-m', 'r');
    git(t, 'push', '--quiet', 'origin', 'master');
    const s = await startServer({ DATA_DIR: mkdtempSync(join(tmpdir(), 'dsp-p2r6-')), GITHUB_GIT_BASE: gh });
    try {
      await s.call('POST', '/projects', { key: 'IM', name: 'Import' });
      const repo = (await s.call('POST', '/projects/IM/repos', { hosted: { name: 'old', import: 'me/old' } })).data as Repo;
      expect(repo.default_branch).toBe('master');
      expect(git(s.ctx.hosted.dir(repo), 'symbolic-ref', 'HEAD')).toBe('refs/heads/master');
      git(s.ctx.hosted.dir(repo), 'branch', 'trunk', 'master');
      await s.call('PATCH', `/repos/${repo.id}`, { default_branch: 'trunk' });
      expect(git(s.ctx.hosted.dir(repo), 'symbolic-ref', 'HEAD')).toBe('refs/heads/trunk');
    } finally {
      await s.app.close();
    }
  });
});
