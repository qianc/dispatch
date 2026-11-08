import { describe, expect, it } from 'vitest';
import { needsGithub, resolveGithubIdentity, type IdentityDeps } from '../src/server/identity.ts';
import type { GithubCredential } from '../src/server/identities.ts';
import type { Project, Repo } from '../src/shared/types.ts';

const BOB: GithubCredential = { login: 'bob-gh', token: 'ghp_bob', git_name: 'Bob', git_email: 'bob@example.com' };
const ALICE: GithubCredential = { login: 'alice-gh', token: 'ghp_alice', git_name: 'Alice', git_email: 'alice@example.com' };

const project = (github_account: string | null = null) => ({ id: 1, key: 'GH', github_account }) as Project;

function deps(opts: { connected?: Record<string, GithubCredential | { error: string }>; env?: string[]; worker?: string[]; oauth?: boolean } = {}): IdentityDeps {
  return {
    identities: { get: (user: string) => opts.connected?.[user] ?? null },
    installOwner: 'alice',
    envAccounts: (opts.env ?? []).map((name) => ({ name })),
    oauth: opts.oauth ?? false,
    workerAccounts: () => opts.worker ?? [],
  };
}

// DISP-63: one function decides as whom a session acts on GitHub.
describe('resolveGithubIdentity', () => {
  it('a connected user acts as themselves', () => {
    expect(resolveGithubIdentity(deps({ connected: { bob: BOB } }), { started_by: 'bob' }, project())).toEqual({ source: 'user', user: 'bob', ...BOB });
    // a project's env account does not change that for anyone but the install owner
    expect(resolveGithubIdentity(deps({ connected: { bob: BOB } }), { started_by: 'bob' }, project('work'))).toMatchObject({ source: 'user', login: 'bob-gh' });
  });

  it('another user without a connection is refused, with a link to connect', () => {
    const r = resolveGithubIdentity(deps({ env: ['default'] }), { started_by: 'bob' }, project());
    expect(r).toEqual({
      refused: true, code: 'github_not_connected', user: 'bob',
      message: "bob has not connected GitHub, and Dispatch never acts on GitHub with someone else's account. Connect yours in Settings → Your GitHub.",
      connect_url: '/settings#your-github',
    });
    const oauth = resolveGithubIdentity(deps({ oauth: true }), { started_by: 'bob' }, project());
    expect(oauth).toMatchObject({ connect_url: `/api/github/oauth/start?to=${encodeURIComponent('/p/GH')}` });
  });

  it('a token Dispatch cannot use is refused too', () => {
    const r = resolveGithubIdentity(deps({ connected: { bob: { error: 'Connect again.' } }, env: ['default'] }), { started_by: 'bob' }, project());
    expect(r).toMatchObject({ refused: true, code: 'github_token_unreadable', user: 'bob' });
    expect((r as { message: string }).message).toContain('Connect again.');
  });

  it('the install owner acts as themselves when connected, else through the env accounts', () => {
    expect(resolveGithubIdentity(deps({ connected: { alice: ALICE } }), { started_by: 'alice' }, project())).toMatchObject({ source: 'user', login: 'alice-gh' });
    // a project with its own env account keeps it for the owner
    expect(resolveGithubIdentity(deps({ connected: { alice: ALICE } }), { started_by: 'alice' }, project('work'))).toEqual({ source: 'owner-env', account: 'work' });
    expect(resolveGithubIdentity(deps(), { started_by: 'alice' }, project())).toEqual({ source: 'owner-env', account: null });
    expect(resolveGithubIdentity(deps(), { started_by: 'alice' }, project('work'))).toEqual({ source: 'owner-env', account: 'work' });
    // never refused: even a broken connection falls back to today's behaviour
    expect(resolveGithubIdentity(deps({ connected: { alice: { error: 'x' } } }), { started_by: 'alice' }, project())).toEqual({ source: 'owner-env', account: null });
  });

  it('no user: the shared env account, from the server or the worker, else refused', () => {
    expect(resolveGithubIdentity(deps({ env: ['default'] }), { started_by: null }, project('work'))).toEqual({ source: 'shared', account: 'work' });
    expect(resolveGithubIdentity(deps({ worker: ['default'] }), { started_by: null }, project(), 3)).toEqual({ source: 'shared', account: null });
    // never another user's token, even when one is connected
    expect(resolveGithubIdentity(deps({ connected: { bob: BOB } }), { started_by: null }, project(), 3)).toEqual({
      refused: true, code: 'github_shared_missing', user: null,
      message: 'This session has no user, and the server has no shared GitHub account (GITHUB_TOKEN or GITHUB_ACCOUNTS).',
      // the install owner's setting, not anyone's own connection
      connect_url: '/settings',
    });
  });
});

describe('needsGithub', () => {
  const repo = (r: Partial<Repo>) => ({ id: 1, project_id: 1, github_owner: 'me', github_name: 'r', ...r }) as Repo;
  const store = (repos: Repo[]) => ({ repos: () => repos });
  it('only projects with a GitHub repo, or a hosted repo with an upstream, need GitHub', () => {
    expect(needsGithub(store([repo({ kind: 'github' })]), project())).toBe(true);
    expect(needsGithub(store([repo({ kind: 'local', local_path: '/x' }), repo({ kind: 'github' })]), project())).toBe(true);
    expect(needsGithub(store([repo({ kind: 'hosted', upstream_owner: 'me', upstream_name: 'up' })]), project())).toBe(true);
    expect(needsGithub(store([repo({ kind: 'hosted' })]), project())).toBe(false);
    expect(needsGithub(store([repo({ kind: 'local', local_path: '/x' })]), project())).toBe(false);
    expect(needsGithub(store([]), project())).toBe(false);
    expect(needsGithub(store([repo({ kind: 'github' })]), null)).toBe(false);
  });
});
