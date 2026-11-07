// DISP-60: a session that stops on a signed-out Claude account shows the steps to sign in, and Retry
// resumes it once the account is signed in on the worker.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attentionOf } from '../src/shared/attention.ts';
import { claudeAccounts, claudeConfigDir, claudeEnv, loginCommand } from '../src/shared/accounts.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import { Logins, loginNotice } from '../src/worker/login.ts';
import { startServer, startWorker, stopWorker, waitFor } from './helpers.ts';

const signIn = (dir: string, token = 'a') => writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: Date.now() + 3_600_000 } }));

describe('the login check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-signin-'));
  const env = { HOME: '/home/j', CLAUDE_ACCOUNTS: 'work,bot', CLAUDE_ACCOUNT_WORK_CONFIG_DIR: dir, CLAUDE_ACCOUNT_BOT_OAUTH_TOKEN: 't' };
  const accounts = claudeAccounts(env);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the folder the session runs with', () => {
    const fallback = (n: string) => `/c/${n}`;
    expect(claudeConfigDir(accounts[0], env, fallback)).toBe(claudeEnv(accounts[0], env, fallback).CLAUDE_CONFIG_DIR);
    expect(claudeConfigDir(undefined, { HOME: '/home/j' }, fallback)).toBe('/home/j/.claude');
    expect(claudeConfigDir(undefined, { CLAUDE_CONFIG_DIR: '/x' }, fallback)).toBe('/x');
    expect(new Logins(accounts, env, '/c').info('work').config_dir).toBe(dir);
  });

  it('says what is missing until the account is signed in again', () => {
    const logins = new Logins(accounts, env, '/c');
    expect(logins.info('work')).toMatchObject({ logged_in: false, missing: expect.stringContaining('No sign-in found') });
    signIn(dir);
    expect(logins.info('work')).toMatchObject({ logged_in: true, missing: null });
    // Claude refuses that login: the same file still counts as signed out, a new /login does not
    const help = logins.failedNow('work', 'authentication_failed', 'Failed to authenticate: OAuth session expired');
    expect(help).toMatchObject({ label: 'Work', config_dir: dir, command: `CLAUDE_CONFIG_DIR=${dir} claude`, fix: null, detail: expect.stringContaining('OAuth session expired') });
    expect(logins.info('work')).toMatchObject({ logged_in: false, missing: expect.stringContaining('has not changed') });
    signIn(dir, 'b');
    expect(logins.info('work').logged_in).toBe(true);
  });

  it('tells token accounts to replace the token, not to /login', () => {
    const logins = new Logins(accounts, env, '/c');
    expect(logins.info('bot').logged_in).toBe(true);
    const help = logins.failedNow('bot', 'authentication_failed', '');
    expect(help.command).toBeNull();
    expect(help.fix).toContain('CLAUDE_ACCOUNT_BOT_OAUTH_TOKEN');
    expect(logins.info('bot')).toMatchObject({ logged_in: false, missing: expect.stringContaining('setup-token') });
    expect(loginNotice(help).body).toContain('press Retry');
  });

  it('quotes a folder with spaces in the command', () => {
    expect(loginCommand('/home/j/my dir')).toBe(`CLAUDE_CONFIG_DIR='/home/j/my dir' claude`);
  });

  it('puts sign-in ahead of everything else the session needs', () => {
    const help = new Logins(accounts, env, '/c').failedNow('work', 'authentication_failed', '');
    const pr = { id: 1, state: 'open', number: 3, blocked: null, mergeable: true, local: false, repo_full_name: 'me/r', head_ref: 'b' };
    expect(attentionOf({ options: DEFAULT_RUN_OPTIONS, login_needed: { ...help, worker: 'buildbox' } }, [pr as never])).toMatchObject({ kind: 'login', text: expect.stringContaining('buildbox') });
  });
});

describe('Retry after signing in', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let worker: ChildProcess;
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-signin-work-'));

  beforeAll(async () => {
    s = await startServer();
    worker = startWorker(s.port, { CLAUDE_ACCOUNTS: 'work', CLAUDE_ACCOUNT_WORK_CONFIG_DIR: dir, CLAUDE_ACCOUNT_WORK_LABEL: 'Work' });
    await waitFor(() => s.ctx.hub.claudeAccounts().length === 1, 'worker accounts');
    await s.call('POST', '/projects', { key: 'SIN', name: 'SIN' });
    await s.call('POST', '/projects/SIN/repos', { github_owner: 'me', github_name: 'r' });
  });
  afterAll(async () => {
    await stopWorker(worker);
    await s.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('shows the steps, keeps them while signed out, and resumes once signed in', async () => {
    const started = (await s.call('POST', '/projects/SIN/batches', { prompt: 'Go [fake:signed-out]' })).data;
    const stopped = await waitFor(async () => {
      const d = (await s.call('GET', `/sessions/${started.id}`)).data;
      return d.session.status === 'idle' && d.session.login_needed ? d : null;
    }, 'the session to stop on the sign-in');
    expect(stopped.session.login_needed).toMatchObject({ label: 'Work', config_dir: dir, command: `CLAUDE_CONFIG_DIR=${dir} claude`, error: 'authentication_failed', detail: expect.stringContaining('OAuth session expired'), worker: expect.any(String) });
    expect(stopped.events.some((e: { body: { kind: string; text?: string } }) => e.body.kind === 'error' && e.body.text?.includes('Work account needs attention'))).toBe(true);
    const card = (await s.call('GET', '/inbox')).data.idle.find((x: { id: number }) => x.id === started.id);
    expect(card.attention).toMatchObject({ kind: 'login' });
    // Settings: the account reads "needs sign-in"
    const w = (await s.call('GET', '/workers')).data.workers.find((x: { connected: boolean }) => x.connected);
    expect(w.facts.claude_accounts[0]).toMatchObject({ name: 'work', logged_in: false });

    // still signed out: nothing runs, and the answer names what is missing
    const notYet = (await s.call('POST', `/sessions/${started.id}/retry-login`, {})).data;
    expect(notYet).toMatchObject({ resumed: false, account: { logged_in: false, missing: expect.stringContaining('No sign-in found') } });
    expect((await s.call('GET', `/sessions/${started.id}`)).data.session).toMatchObject({ status: 'idle', login_needed: expect.anything() });

    // the owner signs in on the worker machine; the account row's check sees it
    signIn(dir);
    expect((await s.call('POST', `/workers/${w.id}/claude-accounts/work/check`, {})).data).toMatchObject({ logged_in: true });
    expect((await s.call('POST', `/workers/${w.id}/claude-accounts/ghost/check`, {})).status).toBe(404);

    const ok = (await s.call('POST', `/sessions/${started.id}/retry-login`, {})).data;
    expect(ok).toMatchObject({ resumed: true, account: { logged_in: true } });
    expect(ok.session).toMatchObject({ status: 'running', login_needed: null });
    const done = await waitFor(async () => {
      const d = (await s.call('GET', `/sessions/${started.id}`)).data;
      return d.session.status === 'idle' && d.events.some((e: { body: { kind: string; text?: string } }) => e.body.kind === 'assistant' && e.body.text?.includes('signed in again')) ? d : null;
    }, 'the session to run to the end of its turn');
    expect(done.session.login_needed).toBeNull();
    expect(done.events.some((e: { body: { kind: string; text?: string } }) => e.body.kind === 'system' && e.body.text?.includes('resumes where it stopped'))).toBe(true);
    // no message from the owner
    const users = (d: { events: { body: { kind: string } }[] }) => d.events.filter((e) => e.body.kind === 'user').length;
    expect(users(done)).toBe(users(stopped));
    expect((await s.call('GET', '/inbox')).data.idle.find((x: { id: number }) => x.id === started.id).attention.kind).not.toBe('login');
  });

  it('refuses Retry on a running session', async () => {
    const sess = (await s.call('POST', '/projects/SIN/batches', { prompt: 'Long one' })).data;
    await s.ctx.sessions.retryLogin(sess.id).then(() => { throw new Error('should refuse'); }, (e: Error) => expect(e.message).toMatch(/not stopped|closed/));
  });
});
