// Review fixes for per-user GitHub identity (DISP-63).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { safePath } from '../src/server/identity.ts';
import type { Session } from '../src/shared/types.ts';
import { fakeGithub } from './github.ts';
import { as, startMultiUser, waitFor } from './helpers.ts';

type Server = Awaited<ReturnType<typeof startMultiUser>>;

const BOB_TOKEN = 'ghp_bobsOwnToken0001';
const LEGACY = 'dsp_legacy_token_value_1234567890';
const legacy = { authorization: `Bearer ${LEGACY}` };

/** A hand-driven worker: records every message, answers every command with ok. */
async function rawWorker(port: number, token: string, githubAccounts: string[] = []) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, { headers: { 'x-worker-token': token } });
  const got: any[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    got.push(m);
    if (m.t === 'cmd') ws.send(JSON.stringify({ t: 'cmd_result', req_id: m.req_id, ok: true, data: m.cmd.c === 'merge_local' ? { ok: true } : {} }));
  });
  await new Promise((r) => ws.once('open', r));
  const facts = { os: 'linux', hostname: 'h', slots: 2, free_slots: 2, claude_accounts: [], github_accounts: githubAccounts, local_repo_dirs: [], caps: ['github_cred'] };
  ws.send(JSON.stringify({ t: 'hello', live: [], facts }));
  return { got, cmds: (c: string) => got.filter((m) => m.t === 'cmd' && m.cmd.c === c).map((m) => m.cmd), close: () => ws.close() };
}

/** GitHub with one open PR #5 on me/gh. */
function github(s: Server) {
  let merged = false;
  const pr = () => ({ number: 5, html_url: 'https://github.com/me/gh/pull/5', title: 'PR', state: merged ? 'closed' : 'open', merged_at: merged ? 'now' : null, mergeable: true, mergeable_state: 'clean', head: { ref: 'b', sha: 'abc' }, base: { ref: 'main' }, body: '' });
  return fakeGithub(s.ctx, {
    pulls: {
      list: async () => ({ data: [pr()] }),
      get: async () => ({ data: pr() }),
      create: async () => ({ data: pr() }),
      merge: async () => { merged = true; return { data: {} }; },
      listFiles: async () => ({ data: [] }),
    },
    git: { deleteRef: async () => ({ data: {} }) },
    checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
    repos: {
      compareCommits: async () => ({ data: { behind_by: 0 } }),
      get: async ({ owner, repo }: { owner: string; repo: string }) => ({ data: { owner: { login: owner }, name: repo, default_branch: 'trunk', description: null, private: true, html_url: `https://github.com/${owner}/${repo}` } }),
    },
    paginate: async (fn: (a: unknown) => Promise<{ data: unknown }>, args: unknown) => (await fn(args)).data,
  });
}

describe('review fixes (DISP-63)', () => {
  let s: Server;
  const closers: (() => void)[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    closers.splice(0).forEach((c) => c());
    await s?.app.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const setup = async (env: Record<string, string> = {}) => {
    s = await startMultiUser(env);
    s.ctx.identities.profile = async (token) => {
      if (token !== BOB_TOKEN) throw new Error('GitHub did not accept this token.');
      return { id: 42, login: 'bob-gh', name: 'Bob Builder', email: 'bob@example.com', scopes: 'repo' };
    };
    await s.call('POST', '/projects', { key: 'GH', name: 'GitHub project' }, as('alice'));
    await s.call('POST', '/projects/GH/repos', { github_owner: 'me', github_name: 'gh' }, as('alice'));
    return s;
  };
  const bobsWorker = async () => {
    const r = await s.call('POST', '/workers', { name: 'bobs' }, as('bob'));
    const w = await rawWorker(s.port, r.data.secret);
    closers.push(w.close);
    await waitFor(() => s.ctx.hub.isConnected(r.data.worker.id), "bob's worker");
    return { id: r.data.worker.id as number, ...w };
  };
  const connectBob = () => s.call('PUT', '/me/github', { token: BOB_TOKEN }, as('bob'));
  const projectId = () => s.ctx.store.projectByKey('GH')!.id;
  const repo = () => s.ctx.store.repos(projectId())[0];

  describe('1. proxy mode without DISPATCH_OWNER or AUTH_USERS', () => {
    it('the first person signed in through the proxy becomes the install owner, also after a restart', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dsp-adopt-'));
      dirs.push(dir);
      const cfg = () => loadConfig({ WORKER_TOKEN: 'w', AUTH_MODE: 'proxy', TRUSTED_PROXIES: '127.0.0.1', WEB_DIST: '/nonexistent', DATA_DIR: dir });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const a = await buildApp(cfg(), { dbFile: join(dir, 'dispatch.db') });
      expect(warn.mock.calls.flat().join(' ')).toMatch(/DISPATCH_OWNER/);
      expect(a.ctx.users.installOwner).toBe('owner');
      const me = (await a.app.inject({ method: 'GET', url: '/api/me', headers: as('carol') })).json();
      expect(me).toMatchObject({ user: 'carol', is_owner: true, install_owner: 'carol' });
      expect(a.ctx.users.installOwner).toBe('carol');
      expect(a.ctx.workers.legacy().owner).toBe('carol');
      expect(a.ctx.store.db.setting('install_owner')).toBe('carol');
      expect(a.ctx.users.list().map((u) => u.name)).not.toContain('owner');
      // only carol manages the install
      const bob = await a.app.inject({ method: 'POST', url: '/api/projects', headers: as('bob'), payload: { key: 'BO', name: 'Bob' } });
      expect(bob.statusCode).toBe(403);
      expect(bob.json().error).toBe('Only the install owner (carol) can change this.');
      expect((await a.app.inject({ method: 'POST', url: '/api/projects', headers: as('carol'), payload: { key: 'CA', name: 'Carol' } })).statusCode).toBe(200);
      // carol, not connected, uses the env accounts as the install owner does
      await a.app.inject({ method: 'POST', url: '/api/projects/CA/repos', headers: as('carol'), payload: { github_owner: 'me', github_name: 'ca' } });
      expect(a.ctx.sessions.identity!('carol', a.ctx.store.projectByKey('CA')!)).toMatchObject({ source: 'owner-env' });
      await a.app.close();

      const b = await buildApp(cfg(), { dbFile: join(dir, 'dispatch.db') });
      try {
        expect(b.ctx.users.installOwner).toBe('carol');
        expect((await b.app.inject({ method: 'GET', url: '/api/me', headers: as('bob') })).json()).toMatchObject({ user: 'bob', is_owner: false, install_owner: 'carol' });
        expect(b.ctx.users.installOwner).toBe('carol');
      } finally {
        await b.app.close();
      }
    });
  });

  describe('3. where OAuth comes back to', () => {
    it('only a path in Dispatch', () => {
      for (const bad of ['/\t/evil.com', decodeURIComponent('/%09/evil.com'), '/\n/evil.com', '//evil', '/\\evil', 'https://evil', ' /x', '', undefined, 'settings']) {
        expect(safePath(bad), JSON.stringify(bad)).toBeNull();
      }
      expect(safePath('/p/GH?tab=1#x')).toBe('/p/GH?tab=1#x');
      expect(safePath('/settings')).toBe('/settings');
    });

    it('"Sign in again" also stays in Dispatch', async () => {
      s = await startMultiUser();
      for (const to of ['/\t/evil.com', '//evil.com', '/\\evil.com']) {
        const r = await s.app.inject({ method: 'GET', url: `/signin?to=${encodeURIComponent(to)}` });
        expect(r.headers.location, JSON.stringify(to)).toBe('/');
      }
      expect((await s.app.inject({ method: 'GET', url: '/signin?to=%2Fp%2FGH' })).headers.location).toBe('/p/GH');
    });
  });

  describe('4. the legacy API token and schedules', () => {
    it('makes, changes, runs and removes schedules as the install owner', async () => {
      await setup({ GITHUB_TOKEN: 'ghp_shared' });
      s.ctx.store.db.setSetting('api_token', LEGACY);
      const made = await s.call('POST', '/projects/GH/schedules', { name: 'Nightly', at_time: '02:00' }, legacy);
      expect(made.status).toBe(200);
      expect(made.data.owner).toBe('alice');
      expect((await s.call('PATCH', `/schedules/${made.data.id}`, { at_time: '03:00' }, legacy)).status).toBe(200);
      const run = await s.call('POST', `/schedules/${made.data.id}/run`, undefined, legacy);
      expect(run.data?.error ?? '').not.toMatch(/only they can/);
      expect((await s.call('DELETE', `/schedules/${made.data.id}`, undefined, legacy)).status).toBe(200);
    });
  });

  describe("5. a session with no user, on a worker with its own GitHub account", () => {
    it('opens and merges its PR with the shared account', async () => {
      await setup();
      const w = await rawWorker(s.port, 'test-token', ['personal']); // the legacy worker
      closers.push(w.close);
      await waitFor(() => s.ctx.hub.facts(s.ctx.workers.legacy().id), 'legacy worker');
      const gh = github(s);
      s.ctx.store.db.setSetting('api_token', LEGACY);
      const job = await s.call('POST', '/projects/GH/batches', { prompt: 'work' }, legacy);
      expect(job.status).toBe(200);
      const pr = await s.call('POST', `/sessions/${job.data.id}/prs`, { repo_id: repo().id }, legacy);
      expect(pr.status).toBe(200);
      expect((await s.call('POST', `/prs/${pr.data.id}/merge`, { how: 'github', method: 'squash' }, legacy)).status).toBe(200);
      expect(gh.by('shared')).toEqual(expect.arrayContaining(['pulls.create', 'pulls.merge']));
    });
  });

  describe("6. checking for PRs of someone else's session", () => {
    it('needs the right to drive it', async () => {
      await setup();
      const mine = s.ctx.store.createSession({
        project_id: projectId(), kind: 'work', title: "alice's", status: 'idle', force_plan: false, branch: 'dispatch/gh-1', initial_prompt: '', source_id: null,
        item_ids: [], worker_id: s.ctx.workers.legacy().id, started_by: 'alice',
      });
      github(s);
      const sync = vi.spyOn(s.ctx.github, 'syncSession');
      const bob = await s.call('POST', `/sessions/${mine.id}/sync-prs`, undefined, as('bob'));
      expect(bob.status).toBe(403);
      expect(bob.data.error).toBe("Started by alice: you can read it, not act on it.");
      expect(sync).not.toHaveBeenCalled();
      expect((await s.call('POST', `/sessions/${mine.id}/sync-prs`, undefined, as('alice'))).status).toBe(200);
    });
  });

  describe("7. the assistant's repo check", () => {
    const chat = (by: string): Session => s.ctx.store.createSession({
      project_id: null, kind: 'assistant', title: 'chat', status: 'idle', force_plan: false, branch: null, initial_prompt: '', source_id: null,
      item_ids: [], worker_id: s.ctx.workers.legacy().id, started_by: by,
    });
    const inspect = (c: Session, extra: Record<string, unknown> = {}) => s.ctx.sessions.assistantRpc!(c, 'inspect_github_repo', { repo: 'me/other', ...extra });

    it("uses the chat starter's own token, never the env account", async () => {
      await setup({ GITHUB_TOKEN: 'ghp_shared' });
      const gh = github(s);
      await connectBob();
      const r = await inspect(chat('bob'));
      expect(r).toMatchObject({ verified: true, default_branch: 'trunk' });
      expect(await inspect(chat('bob'), { project_key: 'GH' })).toMatchObject({ verified: true });
      expect(gh.by(BOB_TOKEN)).toEqual(['repos.get', 'repos.get']);
      expect(gh.by('shared')).toEqual([]);
    });

    it('is refused for someone not connected, and asks GitHub nothing', async () => {
      await setup({ GITHUB_TOKEN: 'ghp_shared' });
      const gh = github(s);
      const r = await inspect(chat('bob'));
      expect(r).toMatchObject({ verified: false });
      expect((r as { note: string }).note).toMatch(/bob has not connected GitHub/);
      expect(gh.calls).toEqual([]);
      // the install owner still uses the env accounts
      expect(await inspect(chat('alice'))).toMatchObject({ verified: true });
      expect(gh.by('shared')).toEqual(['repos.get']);
    });
  });

  describe('8. disconnecting GitHub', () => {
    it("interrupts that person's running sessions that act as them", async () => {
      await setup();
      const w = await bobsWorker();
      await connectBob();
      const make = (by: string, worker: number) => {
        const x = s.ctx.store.createSession({
          project_id: projectId(), kind: 'work', title: `${by}'s`, status: 'running', force_plan: false, branch: `dispatch/gh-${by}`, initial_prompt: '', source_id: null,
          item_ids: [], worker_id: worker, started_by: by,
        });
        return s.ctx.store.updateSession(x.id, { github_login: by === 'bob' ? 'bob-gh' : null });
      };
      const bobs = make('bob', w.id);
      const idle = s.ctx.store.updateSession(make('bob', w.id).id, { status: 'idle' });
      const alices = make('alice', w.id);
      expect((await s.call('DELETE', '/me/github', undefined, as('bob'))).status).toBe(200);
      await waitFor(() => w.got.some((m) => m.t === 'interrupt'), 'interrupt');
      const interrupted = w.got.filter((m) => m.t === 'interrupt').map((m) => m.session_id);
      expect(interrupted).toEqual([bobs.id]);
      expect(interrupted).not.toContain(idle.id);
      expect(interrupted).not.toContain(alices.id);
    });
  });

  describe('9. deploying after a merge', () => {
    it("sends the starter's credential with the deploy", async () => {
      await setup();
      const w = await bobsWorker();
      github(s);
      await connectBob();
      s.ctx.store.updateRepo(repo().id, { deploy_command: './deploy.sh' });
      const job = (await s.call('POST', '/projects/GH/batches', { prompt: 'work' }, as('bob'))).data;
      await waitFor(() => w.got.some((m) => m.t === 'start' && m.spec.session_id === job.id), 'start');
      const pr = await s.call('POST', `/sessions/${job.id}/prs`, { repo_id: repo().id }, as('bob'));
      expect((await s.call('POST', `/prs/${pr.data.id}/merge`, { how: 'github', method: 'squash' }, as('bob'))).status).toBe(200);
      const deploy = await waitFor(() => w.got.find((m) => m.t === 'deploy'), 'deploy');
      expect(deploy.github).toEqual({ token: BOB_TOKEN, login: 'bob-gh', git_name: 'Bob Builder', git_email: 'bob@example.com' });
    });
  });

  describe('10. where "connect GitHub" leads', () => {
    it('a session with no user and no shared account: Settings, for the install owner', async () => {
      await setup({ GITHUB_OAUTH_CLIENT_ID: 'cid', GITHUB_OAUTH_CLIENT_SECRET: 'cs' });
      s.ctx.store.db.setSetting('api_token', LEGACY);
      const r = await s.call('POST', '/projects/GH/batches', { prompt: 'work' }, legacy);
      expect(r.data).toMatchObject({ code: 'github_shared_missing', connect_url: '/settings' });
    });

    it('back to the page the person is on, when it is a path in Dispatch', async () => {
      await setup({ GITHUB_OAUTH_CLIENT_ID: 'cid', GITHUB_OAUTH_CLIENT_SECRET: 'cs' });
      await bobsWorker();
      const from = (path: string) => s.call('POST', '/projects/GH/batches', { prompt: 'work' }, { ...as('bob'), 'x-dispatch-path': path });
      expect((await from('/i/GH-3?tab=talk')).data.connect_url).toBe(`/api/github/oauth/start?to=${encodeURIComponent('/i/GH-3?tab=talk')}`);
      expect((await from('//evil.example.com')).data.connect_url).toBe(`/api/github/oauth/start?to=${encodeURIComponent('/p/GH')}`);
    });
  });
});

describe('2. a changed secret key is not for ever', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const open = (dir: string, key: string) => buildApp(loadConfig({ WORKER_TOKEN: 'w', DISABLE_AUTH: '1', WEB_DIST: '/nonexistent', DATA_DIR: dir, DISPATCH_SECRET_KEY: key }), { dbFile: join(dir, 'dispatch.db') });

  it('key A, then key B (cannot read), then key A again: the token works again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsp-key-'));
    dirs.push(dir);
    const A = 'a'.repeat(64);
    const B = 'b'.repeat(64);
    const a = await open(dir, A);
    a.ctx.identities.profile = async () => ({ id: 1, login: 'me-gh', name: 'Me', email: 'me@example.com', scopes: 'repo' });
    await a.ctx.identities.connect('local', 'ghp_mine', 'pat');
    await a.app.close();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = await open(dir, B);
    expect(b.ctx.identities.get('local')).toEqual({ error: 'Dispatch cannot read this token any more (its key changed). Connect again.' });
    expect(b.ctx.identities.info('local')!.last_error).toMatch(/Connect again/);
    expect(b.ctx.identities.listConnected()).toEqual([]);
    await b.app.close();

    const again = await open(dir, A);
    try {
      expect(again.ctx.identities.get('local')).toMatchObject({ token: 'ghp_mine' });
      expect(again.ctx.identities.info('local')!.last_error).toBeNull();
      expect(again.ctx.identities.listConnected()).toEqual([{ user: 'local', login: 'me-gh' }]);
      // an older Dispatch wrote the "key changed" error down: the token still works once it reads
      again.ctx.store.db.run("UPDATE github_identities SET last_error = 'Dispatch cannot read this token any more (its key changed). Connect again.'");
      expect(again.ctx.identities.get('local')).toMatchObject({ token: 'ghp_mine' });
    } finally {
      await again.app.close();
    }
  });
});
