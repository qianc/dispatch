import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { githubCredEnv, githubEnv, pick, sessionGithubEnv } from '../src/shared/accounts.ts';
import type { GithubCred, StartSpec, WorkerToServer } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import { Secrets } from '../src/worker/secrets.ts';
import { ServerLink, Slots } from '../src/worker/serverLink.ts';
import { as, startMultiUser, startWorker, stopWorker, waitFor } from './helpers.ts';

const BOB_TOKEN = 'ghp_bobsOwnToken0001';
const ENV_TOKEN = 'env-owner-token-xxxxxxxx';
const BOB: GithubCred = { token: BOB_TOKEN, login: 'bob-gh', git_name: 'Bob Builder', git_email: 'bob@example.com' };
const ENV_ACCOUNTS = [
  { name: 'personal', token: ENV_TOKEN, git_name: 'Env Owner', git_email: 'owner@example.com' },
  { name: 'work', token: 'env-work-token-yyyyyyyy', git_name: 'Work Owner', git_email: 'work@example.com' },
];

// DISP-63: a session started by a user runs git and gh as that user, with no env account's token.
describe("a session's GitHub environment", () => {
  it("with the starter's credential: their token in every token variable, their author, and nothing of the env accounts", () => {
    const env = sessionGithubEnv({ github: BOB, github_account: 'work' }, ENV_ACCOUNTS);
    expect(env).toEqual(githubCredEnv(BOB));
    expect(env).toEqual({
      DISPATCH_GH_TOKEN: BOB_TOKEN, GH_TOKEN: BOB_TOKEN, GITHUB_TOKEN: BOB_TOKEN,
      GIT_AUTHOR_NAME: 'Bob Builder', GIT_COMMITTER_NAME: 'Bob Builder', GIT_AUTHOR_EMAIL: 'bob@example.com', GIT_COMMITTER_EMAIL: 'bob@example.com',
    });
    const text = JSON.stringify(env);
    for (const a of ENV_ACCOUNTS) for (const v of [a.token, a.git_name, a.git_email]) expect(text).not.toContain(v);
  });

  it('without one: the env account, as before', () => {
    expect(sessionGithubEnv({ github_account: 'work' }, ENV_ACCOUNTS)).toEqual(githubEnv(pick(ENV_ACCOUNTS, 'work')));
    expect(sessionGithubEnv({ github: null, github_account: null }, ENV_ACCOUNTS)).toEqual(githubEnv(ENV_ACCOUNTS[0]));
    expect(sessionGithubEnv({ github_account: null }, [])).toEqual({});
  });
});

describe("the worker's link to a server (DISP-63)", () => {
  it("says it can take a user's credential, runs the session with it, and scrubs every token from what it sends", async () => {
    const secrets = new Secrets();
    secrets.add(ENV_TOKEN);
    secrets.add('dsw_worker_secret_123');
    const entry = { name: 'default', url: 'ws://127.0.0.1:1/worker', token: 'dsw_worker_secret_123', local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: ['personal'], releases: [], repo_env_dir: '/nonexistent' };
    const link = new ServerLink(entry, {
      fake: true, opts: { assistantReadDirs: [], sessionEnv: (spec: StartSpec) => ({ ...sessionGithubEnv(spec, ENV_ACCOUNTS) }) } as never,
      workspacesDir: mkdtempSync(join(tmpdir(), 'dsp-wgc-')), slots: new Slots(2),
      claudeAccounts: () => [], githubAccounts: ['personal', 'work'], gitEnv: () => ({}), remoteBase: 'https://github.com', secrets,
    });
    expect((await link.facts()).caps).toEqual(['github_cred']);
    const sent: WorkerToServer[] = [];
    const raw: string[] = [];
    (link as unknown as { ws: unknown }).ws = { readyState: WebSocket.OPEN, send: (d: string) => { raw.push(d); sent.push(JSON.parse(d)); } };
    // the project's account "work" is not allowed for this server: no matter, bob's own is used
    const spec: StartSpec = { session_id: 7, kind: 'work', project_key: 'GH', project_name: 'P', importance_scale: [], effort_scale: [], title: 't', branch: 'b', repos: [], items: [], source: null, prompt: '[fake:env]', force_plan: false, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: 'work', github: BOB, resume: null, resume_note: null };
    process.env.FAKE_DELAY_MS = '1';
    await (link as unknown as { onMessage: (m: unknown) => Promise<void> }).onMessage({ t: 'start', spec });
    const said = await waitFor(() => sent.find((m) => m.t === 'event' && m.body.kind === 'assistant'), 'the env');
    const text = (said as { body: { text: string } }).body.text;
    expect(text).toContain('GH_TOKEN=[redacted]');
    expect(text).toContain('GIT_AUTHOR_EMAIL=bob@example.com');
    expect(text).toContain(`sha256:${createHash('sha256').update(BOB_TOKEN).digest('hex')}`);
    expect(raw.join('\n')).not.toContain(BOB_TOKEN);
    expect(sent.find((m) => m.t === 'status' && m.status === 'failed')).toBeUndefined();
    // a command's error with a token in it goes out scrubbed too
    link.send({ t: 'cmd_result', req_id: 'r', ok: false, error: `push of ${ENV_TOKEN} by dsw_worker_secret_123 failed` });
    expect(sent.at(-1)).toEqual({ t: 'cmd_result', req_id: 'r', ok: false, error: 'push of [redacted] by [redacted] failed' });
    // the credential is kept while the session lives, and forgotten when it closes
    const creds = (link as unknown as { creds: Map<number, GithubCred> }).creds;
    expect(creds.get(7)).toEqual(BOB);
    await (link as unknown as { onMessage: (m: unknown) => Promise<void> }).onMessage({ t: 'close', session_id: 7, cleanup: false, repos: [] });
    expect(creds.has(7)).toBe(false);
    // its token stays a secret for the life of the worker
    link.send({ t: 'cmd_result', req_id: 'r2', ok: false, error: `late ${BOB_TOKEN}` });
    expect(sent.at(-1)).toMatchObject({ error: 'late [redacted]' });
  });
});

describe("the worker's GitHub credential per command (DISP-63)", () => {
  const link = () => {
    const entry = { name: 'default', url: 'ws://127.0.0.1:1/worker', token: 'dsw_x', local_repo_dirs: ['/tmp'], read_dirs: [], claude_accounts: null, github_accounts: [], releases: [], repo_env_dir: '/nonexistent' };
    const l = new ServerLink(entry, {
      fake: true, opts: { assistantReadDirs: [] } as never, workspacesDir: mkdtempSync(join(tmpdir(), 'dsp-wgc-')), slots: new Slots(2),
      claudeAccounts: () => [], githubAccounts: [], gitEnv: () => ({}), remoteBase: 'https://github.com', secrets: new Secrets(),
    });
    const used: { what: string; cred: unknown }[] = [];
    const sent: WorkerToServer[] = [];
    const x = l as unknown as { workspaces: unknown; creds: Map<number, GithubCred>; ws: unknown; onMessage: (m: unknown) => Promise<void>; command: (c: unknown) => Promise<unknown> };
    x.workspaces = {
      pushBranch: async (_r: unknown, _id: unknown, _b: unknown, cred: unknown) => void used.push({ what: 'push', cred }),
      deploy: async (_r: unknown, cred: unknown) => {
        used.push({ what: 'deploy', cred });
        return { ok: true, sha: 'abc', output: `deployed with ${(cred as GithubCred | null)?.token ?? 'env'}`, duration_ms: 1 };
      },
    };
    x.ws = { readyState: WebSocket.OPEN, send: (d: string) => sent.push(JSON.parse(d)) };
    return { x, used, sent };
  };
  const repo = { id: 1, project_id: 1, github_owner: 'me', github_name: 'r', default_branch: 'main', local_path: '/tmp/r', deploy_command: './deploy.sh' } as never;

  it('push_branch: github null (the env accounts) is not replaced by the session credential; no github key falls back to it', async () => {
    const { x, used } = link();
    x.creds.set(7, BOB);
    await x.command({ c: 'push_branch', repo, session_id: 7, branch: 'b', github: null });
    await x.command({ c: 'push_branch', repo, session_id: 7, branch: 'b' });
    expect(used).toEqual([{ what: 'push', cred: null }, { what: 'push', cred: BOB }]);
  });

  it("deploy: uses the credential the server sends, even after the session closed, and scrubs its token", async () => {
    const { x, used, sent } = link();
    await x.onMessage({ t: 'deploy', session_id: 7, repo, github: BOB });
    await x.onMessage({ t: 'deploy', session_id: 8, repo, github: null });
    expect(used).toEqual([{ what: 'deploy', cred: BOB }, { what: 'deploy', cred: null }]);
    expect(JSON.stringify(sent)).not.toContain(BOB_TOKEN);
    expect(sent[0]).toMatchObject({ t: 'deploy_result', output: 'deployed with [redacted]' });
  });
});

describe("a real worker running bob's session (DISP-63)", () => {
  let s: Awaited<ReturnType<typeof startMultiUser>>;
  let worker: ChildProcess | null = null;
  afterEach(async () => {
    if (worker) await stopWorker(worker);
    worker = null;
    await s.app.close();
  });

  it("gives the agent bob's token and author, and no token reaches the server's transcript", async () => {
    s = await startMultiUser();
    s.ctx.identities.profile = async (token) => {
      if (token !== BOB_TOKEN) throw new Error('GitHub did not accept this token.');
      return { id: 42, login: BOB.login, name: BOB.git_name, email: BOB.git_email, scopes: 'repo' };
    };
    await s.call('POST', '/projects', { key: 'GH', name: 'GitHub project' }, as('alice'));
    await s.call('POST', '/projects/GH/repos', { github_owner: 'me', github_name: 'gh' }, as('alice'));
    expect((await s.call('PUT', '/me/github', { token: BOB_TOKEN }, as('bob'))).status).toBe(200);
    const made = await s.call('POST', '/workers', { name: 'bobs' }, as('bob'));
    // the worker machine has its owner's own GitHub token in its env
    worker = startWorker(s.port, {
      WORKER_TOKEN: made.data.secret, GITHUB_TOKEN: ENV_TOKEN, GH_TOKEN: '', GITHUB_ACCOUNTS: '',
      GIT_AUTHOR_NAME: 'Env Owner', GIT_AUTHOR_EMAIL: 'owner@example.com',
    });
    await waitFor(() => s.ctx.hub.facts(made.data.worker.id)?.caps?.includes('github_cred'), "bob's worker", 15_000);

    const job = (await s.call('POST', '/projects/GH/batches', { prompt: 'show me [fake:env]' }, as('bob'))).data;
    const said = await waitFor(() => s.ctx.store.events(job.id).find((e) => e.body.kind === 'assistant' && e.body.text.includes('sha256:')), 'the env', 15_000);
    const text = (said.body as { text: string }).text;
    expect(text).toContain(`sha256:${createHash('sha256').update(BOB_TOKEN).digest('hex')}`);
    expect(text).toContain('GIT_AUTHOR_NAME=Bob Builder');
    expect(text).toContain('GIT_AUTHOR_EMAIL=bob@example.com');
    expect(text).toContain('GH_TOKEN=[redacted]');
    expect(text).toContain('GITHUB_TOKEN=[redacted]');
    expect(text).toContain('DISPATCH_GH_TOKEN=[redacted]');

    const events = await s.call('GET', `/sessions/${job.id}/events`, undefined, as('bob'));
    const session = await s.call('GET', `/sessions/${job.id}`, undefined, as('bob'));
    const all = JSON.stringify([s.ctx.store.events(job.id), events.data, session.data]);
    expect(all).toContain('[redacted]');
    expect(all).not.toContain(BOB_TOKEN);
    expect(all).not.toContain(ENV_TOKEN);
  }, 30_000);
});
