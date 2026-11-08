import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Octokit } from '@octokit/rest';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHub } from '../src/server/github.ts';
import type { StartSpec } from '../src/shared/protocol.ts';
import { fakeGithub } from './github.ts';
import { as, startMultiUser, waitFor } from './helpers.ts';

type Server = Awaited<ReturnType<typeof startMultiUser>>;

const BOB_TOKEN = 'ghp_bobsOwnToken0001';
const LEGACY = 'dsp_legacy_token_value_1234567890';
const WRITES = ['pulls.create', 'pulls.merge', 'git.deleteRef'];

/** A hand-driven worker: records starts and commands, answers every command with ok. */
async function rawWorker(port: number, token: string, caps: string[] | null = ['github_cred']) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, { headers: { 'x-worker-token': token } });
  const got: any[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    got.push(m);
    if (m.t === 'cmd') ws.send(JSON.stringify({ t: 'cmd_result', req_id: m.req_id, ok: true, data: m.cmd.c === 'merge_local' ? { ok: true } : {} }));
  });
  await new Promise((r) => ws.once('open', r));
  const facts = { os: 'linux', hostname: 'h', slots: 2, free_slots: 2, claude_accounts: [], github_accounts: [], local_repo_dirs: [], ...(caps ? { caps } : {}) };
  ws.send(JSON.stringify({ t: 'hello', live: [], facts }));
  return {
    starts: (): StartSpec[] => got.filter((m) => m.t === 'start').map((m) => m.spec),
    cmds: (c: string) => got.filter((m) => m.t === 'cmd' && m.cmd.c === c).map((m) => m.cmd),
    close: () => ws.close(),
  };
}

/** GitHub as the tests need it: one open PR #5 on me/gh, merged once merged. */
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
    repos: { compareCommits: async () => ({ data: { behind_by: 0 } }) },
    paginate: async (fn: (a: unknown) => Promise<{ data: unknown }>, args: unknown) => (await fn(args)).data,
  });
}

// DISP-63: GitHub actions run as the person who started the session, never as someone else.
describe('acting on GitHub as the session starter', () => {
  let s: Server;
  const closers: (() => void)[] = [];
  afterEach(async () => {
    closers.splice(0).forEach((c) => c());
    await s.app.close();
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
  const bobsWorker = async (caps?: string[] | null) => {
    const r = await s.call('POST', '/workers', { name: 'bobs' }, as('bob'));
    const w = await rawWorker(s.port, r.data.secret, caps);
    closers.push(w.close);
    await waitFor(() => s.ctx.hub.isConnected(r.data.worker.id), "bob's worker");
    return { id: r.data.worker.id as number, ...w };
  };
  const connectBob = () => s.call('PUT', '/me/github', { token: BOB_TOKEN }, as('bob'));
  const batch = (headers: Record<string, string>, body: Record<string, unknown> = {}) => s.call('POST', '/projects/GH/batches', { prompt: 'work', ...body }, headers);
  const counts = () => ({ sessions: s.ctx.store.sessions({}).length, items: s.ctx.store.items(s.ctx.store.projectByKey('GH')!.id).length });

  it('refuses bob before anything is made while he has not connected GitHub', async () => {
    await setup();
    await bobsWorker();
    const before = counts();
    const r = await batch(as('bob'), { new_items: [{ title: 'New thing' }] });
    expect(r.status).toBe(403);
    expect(r.data).toEqual({
      error: "bob has not connected GitHub, and Dispatch never acts on GitHub with someone else's account. Connect yours in Settings → Your GitHub.",
      code: 'github_not_connected',
      connect_url: '/settings#your-github',
    });
    expect(counts()).toEqual(before);
    const plan = await s.call('POST', '/projects/GH/planner', { prompt: 'plan', source_id: null }, as('bob'));
    expect(plan.status).toBe(403);
    const item = (await s.call('POST', '/projects/GH/items', { title: 'Talk' }, as('alice'))).data;
    const talk = await s.call('POST', `/items/${item.id}/discuss`, { text: 'why?' }, as('bob'));
    expect(talk).toMatchObject({ status: 403, data: { code: 'github_not_connected' } });
    expect(s.ctx.store.sessions({ kind: 'discuss' })).toEqual([]);
    // the assistant needs no GitHub
    expect((await s.call('POST', '/assistant/messages', { text: 'hi' }, as('bob'))).status).toBe(200);
  });

  it('with OAuth set up, the link signs in with GitHub and comes back to the project', async () => {
    await setup({ GITHUB_OAUTH_CLIENT_ID: 'cid', GITHUB_OAUTH_CLIENT_SECRET: 'cs' });
    await bobsWorker();
    expect((await batch(as('bob'))).data.connect_url).toBe(`/api/github/oauth/start?to=${encodeURIComponent('/p/GH')}`);
  });

  it("a worker too old to take bob's credential is refused, to start on or to move to", async () => {
    await setup();
    const old = await bobsWorker(null);
    await connectBob();
    const r = await batch(as('bob'), { options: { worker_id: old.id } });
    expect(r.status).toBe(403);
    expect(r.data.error).toBe('Worker bobs is too old to act as you on GitHub; update it.');
    const made = await s.call('POST', '/workers', { name: 'bobs-new' }, as('bob'));
    const job = (await batch(as('bob'), { options: { worker_id: made.data.worker.id } })).data; // offline: checked at dispatch
    const moved = await s.call('POST', `/sessions/${job.id}/move`, { worker_id: old.id }, as('bob'));
    expect(moved).toMatchObject({ status: 403, data: { code: 'worker_too_old' } });
  });

  it("once connected, bob's sessions, PRs, merges and branch deletes use his token only", async () => {
    await setup();
    const w = await bobsWorker();
    const gh = github(s);
    expect((await connectBob()).status).toBe(200);
    const job = (await batch(as('bob'))).data;
    const spec = await waitFor(() => w.starts().find((x) => x.session_id === job.id), 'start');
    expect(spec.github).toEqual({ token: BOB_TOKEN, login: 'bob-gh', git_name: 'Bob Builder', git_email: 'bob@example.com' });
    expect(spec.github_account).toBeNull();
    expect(s.ctx.store.session(job.id)!.github_login).toBe('bob-gh');

    const repo = s.ctx.store.repos(s.ctx.store.projectByKey('GH')!.id)[0];
    const pr = await s.call('POST', `/sessions/${job.id}/prs`, { repo_id: repo.id }, as('bob'));
    expect(pr.status).toBe(200);
    expect(w.cmds('push_branch')[0].github).toMatchObject({ token: BOB_TOKEN, login: 'bob-gh' });
    const merged = await s.call('POST', `/prs/${pr.data.id}/merge`, { how: 'github', method: 'squash' }, as('bob'));
    expect(merged.status).toBe(200);
    expect(await s.ctx.github.deleteRemoteBranch(repo, job.branch, s.ctx.store.session(job.id)!)).toBe(true);

    expect(gh.by(BOB_TOKEN)).toEqual(expect.arrayContaining(WRITES));
    expect(gh.by('shared').filter((m) => WRITES.includes(m))).toEqual([]);

    // bob disconnects: reads fall back to the shared client, writes are refused
    await s.call('DELETE', '/me/github', undefined, as('bob'));
    const n = gh.calls.length;
    await s.ctx.github.syncPr(pr.data.id);
    expect(gh.calls.slice(n).map((c) => c.token)).toEqual(['shared']);
    await expect(s.ctx.github.deleteRemoteBranch(repo, job.branch, s.ctx.store.session(job.id)!)).rejects.toThrow(/bob has not connected GitHub/);
    expect(gh.by('shared').filter((m) => WRITES.includes(m))).toEqual([]);
  });

  it('GitHub turning the token away marks the connection, naming the account', async () => {
    await setup();
    const w = await bobsWorker();
    const gh = github(s);
    await connectBob();
    const job = (await batch(as('bob'))).data;
    await waitFor(() => w.starts().length, 'start');
    const repo = s.ctx.store.repos(s.ctx.store.projectByKey('GH')!.id)[0];
    s.ctx.github.clientForToken = () => ({ git: { deleteRef: async () => { throw Object.assign(new Error('Bad credentials'), { status: 401 }); } } }) as any;
    await expect(s.ctx.github.deleteRemoteBranch(repo, job.branch, s.ctx.store.session(job.id)!)).rejects.toThrow("GitHub turned away the token of bob's account @bob-gh");
    expect(s.ctx.identities.info('bob')!.last_error).toMatch(/turned away/);
    expect(gh.by('shared')).toEqual([]);
  });

  it('a queued session waits "Needs GitHub" until its user connects', async () => {
    await setup();
    const r = await s.call('POST', '/workers', { name: 'bobs' }, as('bob'));
    await connectBob();
    const job = (await batch(as('bob'))).data; // the worker is not connected yet: it waits
    await s.call('DELETE', '/me/github', undefined, as('bob'));
    const w = await rawWorker(s.port, r.data.secret);
    closers.push(w.close);
    await waitFor(() => s.ctx.store.session(job.id)!.waiting_reason?.startsWith('Needs GitHub: bob has not connected GitHub'), 'needs GitHub');
    expect(w.starts()).toEqual([]);
    expect(s.ctx.notifier.sent.filter((x) => x.title === 'GH: needs GitHub')).toHaveLength(1);
    await connectBob();
    await waitFor(() => w.starts().find((x) => x.session_id === job.id), 'start after connecting');
  });

  it("a schedule of bob's does not run while he has not connected GitHub, and says why", async () => {
    await setup();
    await bobsWorker();
    const made = (await s.call('POST', '/projects/GH/schedules', { name: 'Nightly', at_time: '02:00' }, as('bob'))).data;
    const run = await s.call('POST', `/schedules/${made.id}/run`, undefined, as('bob'));
    expect(run).toMatchObject({ status: 403, data: { code: 'github_not_connected' } });
    expect(s.ctx.store.schedule(made.id)!.last_error).toBe("Schedule 'Nightly' runs as bob, who has not connected GitHub.");
    expect(s.ctx.store.sessions({ kind: 'planner' })).toEqual([]);
  });

  it('a session with no user needs the shared account', async () => {
    await setup();
    s.ctx.store.db.setSetting('api_token', LEGACY);
    const r = await batch({ authorization: `Bearer ${LEGACY}` });
    expect(r.status).toBe(403);
    expect(r.data).toMatchObject({ code: 'github_shared_missing', error: 'This session has no user, and the server has no shared GitHub account (GITHUB_TOKEN or GITHUB_ACCOUNTS).' });
    expect(s.ctx.store.sessions({})).toEqual([]);
  });

  it('with GITHUB_TOKEN, a session with no user, and the install owner, run as before on the shared account', async () => {
    await setup({ GITHUB_TOKEN: 'ghp_shared' });
    const w = await rawWorker(s.port, 'test-token'); // the install owner's (legacy) worker
    closers.push(w.close);
    const gh = github(s);
    s.ctx.store.db.setSetting('api_token', LEGACY);
    const job = (await batch({ authorization: `Bearer ${LEGACY}` })).data;
    expect(job).toMatchObject({ started_by: null });
    const mine = (await batch(as('alice'))).data;
    for (const id of [job.id, mine.id]) {
      const spec = await waitFor(() => w.starts().find((x) => x.session_id === id), 'start');
      expect(spec.github).toBeUndefined();
      expect(spec.github_account).toBeNull();
      expect(s.ctx.store.session(id)!.github_login).toBeNull();
    }
    const repo = s.ctx.store.repos(s.ctx.store.projectByKey('GH')!.id)[0];
    expect((await s.call('POST', `/sessions/${mine.id}/prs`, { repo_id: repo.id }, as('alice'))).status).toBe(200);
    expect(w.cmds('push_branch')[0].github).toBeNull();
    expect(gh.by('shared')).toContain('pulls.create');
    expect(gh.calls.every((c) => c.token === 'shared')).toBe(true);
  });
});

describe("a user's own Octokit client", () => {
  it('works as Octokit (paginate too), and a 401 marks the connection, naming the account', async () => {
    const srv = createServer((req, res) => {
      const ok = req.url!.includes('/files');
      res.statusCode = ok ? 200 : 401;
      res.setHeader('content-type', 'application/json');
      res.end(ok ? '[{"filename":"a"}]' : '{"message":"Bad credentials"}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const marked: string[] = [];
      const bob = { source: 'user' as const, user: 'bob', login: 'bob-gh', token: 't', git_name: 'Bob', git_email: 'bob@example.com' };
      const gh = new GitHub([], {} as never, {} as never, {} as never, {} as never, { markRejected: (u) => void marked.push(u) }, () => bob, `http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
      const { octo } = (gh as unknown as { as: (s: unknown, r: unknown, m: string) => { octo: Octokit } }).as({ id: 1 }, { github_owner: 'o', github_name: 'r', github_account: null }, 'read');
      expect(await octo.paginate(octo.pulls.listFiles, { owner: 'o', repo: 'r', pull_number: 1, per_page: 100 })).toEqual([{ filename: 'a' }]);
      await expect(octo.pulls.get({ owner: 'o', repo: 'r', pull_number: 1 })).rejects.toThrow("GitHub turned away the token of bob's account @bob-gh");
      expect(marked).toEqual(['bob']);
    } finally {
      srv.close();
    }
  });
});
