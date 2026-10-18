import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeAccounts, claudeEnv, githubAccounts, githubEnv, pick } from '../src/shared/accounts.ts';
import { DEFAULT_RUN_OPTIONS, type Repo } from '../src/shared/types.ts';
import { rateLimitNotice } from '../src/worker/runner.ts';
import { Workspaces } from '../src/worker/workspace.ts';
import { startServer, startWorker, stopWorker, waitFor } from './helpers.ts';

describe('accounts from env', () => {
  it('keeps today\'s single login and token as the "default" account', () => {
    expect(claudeAccounts({})).toEqual([{ name: 'default', label: 'Default Claude login', kind: 'machine' }]);
    expect(githubAccounts({ GITHUB_TOKEN: 't', GIT_AUTHOR_NAME: 'J', GIT_AUTHOR_EMAIL: 'j@x' })).toEqual([{ name: 'default', token: 't', git_name: 'J', git_email: 'j@x' }]);
    expect(githubAccounts({})).toEqual([]);
  });

  it('reads named accounts and refuses half-configured ones', () => {
    const env = {
      HOME: '/home/j', CLAUDE_ACCOUNTS: 'private, Work',
      CLAUDE_ACCOUNT_PRIVATE_OAUTH_TOKEN: 'tok', CLAUDE_ACCOUNT_WORK_CONFIG_DIR: '~/.claude-dispatch/work', CLAUDE_ACCOUNT_WORK_LABEL: 'Work',
    };
    expect(claudeAccounts(env)).toEqual([
      { name: 'private', label: 'Private', kind: 'oauth_token', config_dir: undefined, oauth_token: 'tok', api_key: undefined },
      { name: 'work', label: 'Work', kind: 'config_dir', config_dir: '/home/j/.claude-dispatch/work', oauth_token: undefined, api_key: undefined },
    ]);
    expect(() => claudeAccounts({ CLAUDE_ACCOUNTS: 'x' })).toThrow(/CLAUDE_ACCOUNT_X_CONFIG_DIR/);
    expect(githubAccounts({ GITHUB_ACCOUNTS: 'personal,work', GITHUB_ACCOUNT_PERSONAL_TOKEN: 'a', GITHUB_ACCOUNT_WORK_TOKEN: 'b', GITHUB_ACCOUNT_WORK_GIT_EMAIL: 'me@work.example' }).map((a) => [a.name, a.token, a.git_email]))
      .toEqual([['personal', 'a', null], ['work', 'b', 'me@work.example']]);
    expect(() => githubAccounts({ GITHUB_ACCOUNTS: 'work' })).toThrow(/GITHUB_ACCOUNT_WORK_TOKEN/);
  });

  it('gives each named Claude account its own config folder and credentials; default runs as today', () => {
    const base = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'machine-token', ANTHROPIC_API_KEY: 'k' };
    expect(claudeEnv(undefined, base, (n) => `/c/${n}`)).toEqual(base);
    expect(claudeEnv({ name: 'default', label: '', kind: 'machine' }, base, (n) => `/c/${n}`)).toEqual(base);
    const work = claudeEnv({ name: 'work', label: '', kind: 'config_dir', config_dir: '/w' }, base, (n) => `/c/${n}`);
    expect(work).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/w' }); // the machine's token must not override the work login
    expect(claudeEnv({ name: 'private', label: '', kind: 'oauth_token', oauth_token: 'p' }, base, (n) => `/c/${n}`))
      .toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/c/private', CLAUDE_CODE_OAUTH_TOKEN: 'p' });
    expect(githubEnv({ name: 'work', token: 'b', git_name: 'Me', git_email: 'me@work.example' })).toEqual({
      DISPATCH_GH_TOKEN: 'b', GH_TOKEN: 'b', GIT_AUTHOR_NAME: 'Me', GIT_COMMITTER_NAME: 'Me', GIT_AUTHOR_EMAIL: 'me@work.example', GIT_COMMITTER_EMAIL: 'me@work.example',
    });
    expect(pick([{ name: 'a' }, { name: 'b' }], 'b')?.name).toBe('b');
    expect(pick([{ name: 'a' }, { name: 'b' }], null)?.name).toBe('a');
  });

  it('runs a repo\'s git work with its project\'s GitHub account', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'dsp-acc-')), 'r');
    execFileSync('git', ['init', '-b', 'main', dir]);
    writeFileSync(join(dir, 'a'), '1');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'i'], { cwd: dir });
    const accounts = [{ name: 'personal', token: 'tok-q', git_name: null, git_email: null }, { name: 'work', token: 'tok-work', git_name: 'Work Me', git_email: 'me@work.example' }];
    const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')), 'https://github.com', (repo) => githubEnv(pick(accounts, repo.github_account)));
    const repo: Repo = { id: 1, project_id: 1, github_owner: 'local', github_name: 'r', default_branch: 'main', check_command: null, local_path: dir, worktree_from: null, setup_command: 'echo "$DISPATCH_GH_TOKEN $GIT_AUTHOR_EMAIL" > .who', github_account: 'work' };
    const spec = { session_id: 1, kind: 'work' as const, project_key: 'P', project_name: 'P', importance_scale: [], effort_scale: [], title: 't', branch: 'b1', repos: [repo], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: 'work', resume: null, resume_note: null };
    const wt = await ws.prepare(spec);
    await ws.setup(repo, wt);
    expect(readFileSync(join(wt, '.who'), 'utf8').trim()).toBe('tok-work me@work.example');
  });

  it('words rate limit notices', () => {
    expect(rateLimitNotice('Work', { status: 'rejected', rateLimitType: 'five_hour' }).title).toBe('Work: five hour limit reached');
    expect(rateLimitNotice('Work', { status: 'allowed_warning', utilization: 0.9 }).body).toMatch(/90% used/);
  });
});

describe('Claude accounts on projects and batches', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let worker: ChildProcess;

  beforeAll(async () => {
    s = await startServer();
    worker = startWorker(s.port, { CLAUDE_ACCOUNTS: 'private,work', CLAUDE_ACCOUNT_PRIVATE_OAUTH_TOKEN: 'x', CLAUDE_ACCOUNT_WORK_CONFIG_DIR: '/tmp/none-work' });
    await waitFor(() => s.ctx.hub.claudeAccounts().length === 2, 'worker accounts');
    await s.call('POST', '/projects', { key: 'SLD', name: 'SLD' });
    await s.call('POST', '/projects/SLD/repos', { github_owner: 'me', github_name: 'r' });
  });
  afterAll(async () => {
    await stopWorker(worker);
    await s.app.close();
  });

  it('lists accounts by name and status only', async () => {
    s.ctx.github.accountsInfo = async () => [];
    const a = (await s.call('GET', '/accounts')).data;
    expect(a.claude.map((x: { name: string; logged_in: boolean | null }) => [x.name, x.logged_in])).toEqual([['private', true], ['work', false]]);
    expect(JSON.stringify(a)).not.toContain('"x"'); // no token
  });

  it('uses the project default, allows overrides within the allowed list, and locks the account', async () => {
    expect((await s.call('PATCH', '/projects/SLD', { claude_allowed: ['work'], claude_account: 'private' })).status).toBe(400);
    expect((await s.call('PATCH', '/projects/SLD', { claude_account: 'nope' })).status).toBe(400);
    await s.call('PATCH', '/projects/SLD', { claude_allowed: ['work'], claude_account: 'work' });
    const sent: unknown[] = [];
    const orig = s.ctx.hub.send.bind(s.ctx.hub);
    s.ctx.hub.send = (w, m) => { sent.push(m); return orig(w, m); };
    const a = (await s.call('POST', '/projects/SLD/batches', { prompt: 'x' })).data;
    expect(a.claude_account).toBe('work');
    expect(sent).toContainEqual(expect.objectContaining({ t: 'start', spec: expect.objectContaining({ claude_account: 'work' }) }));
    const refused = await s.call('POST', '/projects/SLD/batches', { prompt: 'y', options: { claude_account: 'private' } });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toMatch(/does not allow/);
    await s.call('PATCH', '/projects/SLD', { claude_allowed: null });
    const b = (await s.call('POST', '/projects/SLD/batches', { prompt: 'z', options: { claude_account: 'private' } })).data;
    expect(b.claude_account).toBe('private');
    // a session keeps its account even when the project default changes
    await s.call('PATCH', '/projects/SLD', { claude_account: 'private' });
    expect((await s.call('GET', `/sessions/${a.id}`)).data.session.claude_account).toBe('work');
    s.ctx.hub.send = orig;
  });

  it('runs the assistant on its own account setting', async () => {
    expect((await s.call('PATCH', '/settings', { assistant_claude_account: 'ghost' })).status).toBe(400);
    await s.call('PATCH', '/settings', { assistant_claude_account: 'work' });
    const chat = (await s.call('POST', '/assistant/messages', { text: 'hi' })).data;
    expect(chat.claude_account).toBe('work');
  });

  it('shows worker notices in the session and pushes them', async () => {
    const sess = (await s.call('GET', '/sessions?project=SLD')).data[0];
    s.ctx.sessions.onWorkerMessage(s.ctx.workers.legacy().id, { t: 'notice', session_id: sess.id, title: 'Work account needs attention', body: 'log in again' });
    const ev = (await s.call('GET', `/sessions/${sess.id}`)).data.events.at(-1);
    expect(ev.body).toMatchObject({ kind: 'error', text: expect.stringContaining('Work account needs attention') });
    expect(s.ctx.notifier.sent.some((n) => n.title.includes('Work account needs attention'))).toBe(true);
  });

  it('checks a project\'s GitHub account exists', async () => {
    expect((await s.call('PATCH', '/projects/SLD', { github_account: 'work' })).status).toBe(400);
  });
});
