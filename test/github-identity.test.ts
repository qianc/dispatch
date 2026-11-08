import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import type { GithubProfile } from '../src/server/identities.ts';
import { as, startMultiUser } from './helpers.ts';

type Server = Awaited<ReturnType<typeof startMultiUser>>;

const PAT = 'ghp_bobsVerySecretToken0001';
const OAUTH_TOKEN = 'gho_bobsOauthToken0002';
const profiles: Record<string, GithubProfile> = {
  [PAT]: { id: 42, login: 'bob-gh', name: 'Bob Builder', email: 'bob@example.com', scopes: 'repo, read:user' },
  [OAUTH_TOKEN]: { id: 42, login: 'bob-gh', name: null, email: null, scopes: 'repo, read:user, user:email' },
  ghp_noRepo: { id: 7, login: 'weak', name: null, email: null, scopes: 'read:user' },
  github_pat_fine: { id: 8, login: 'fine', name: 'Fine Grained', email: null, scopes: null },
};

function stub(s: Server) {
  const id = s.ctx.identities;
  id.profile = async (token) => {
    const p = profiles[token];
    if (!p) throw new Error('GitHub did not accept this token.');
    return p;
  };
  id.exchange = vi.fn(async (code: string) => {
    if (code !== 'good-code') throw new Error('GitHub refused the sign-in code.');
    return OAUTH_TOKEN;
  });
  id.revoke = vi.fn(async () => {});
}

describe('your own GitHub connection', () => {
  let s: Server;
  beforeEach(async () => {
    s = await startMultiUser({ GITHUB_OAUTH_CLIENT_ID: 'cid', GITHUB_OAUTH_CLIENT_SECRET: 'csecret', PUBLIC_URL: 'https://dispatch.example.com' });
    stub(s);
  });
  afterEach(async () => {
    await s.app.close();
  });

  it('connects a pasted token, shows who it is (never the token), and disconnects', async () => {
    expect((await s.call('GET', '/me/github', undefined, as('bob'))).data).toMatchObject({ connected: false, oauth_available: true, uses_env_when_unconnected: false, env_accounts: [] });
    const put = await s.call('PUT', '/me/github', { token: PAT }, as('bob'));
    expect(put.status).toBe(200);
    expect(put.data).toMatchObject({ connected: true, login: 'bob-gh', git_name: 'Bob Builder', git_email: 'bob@example.com', kind: 'pat', last_error: null });
    expect(JSON.stringify(put.data)).not.toContain(PAT);
    expect(s.ctx.identities.get('bob')).toMatchObject({ login: 'bob-gh', token: PAT, git_name: 'Bob Builder', git_email: 'bob@example.com' });
    // alice is not bob
    expect((await s.call('GET', '/me/github', undefined, as('alice'))).data.connected).toBe(false);
    expect(s.ctx.identities.listConnected()).toEqual([{ user: 'bob', login: 'bob-gh' }]);

    const del = await s.call('DELETE', '/me/github', undefined, as('bob'));
    expect(del.status).toBe(200);
    expect(del.data.connected).toBe(false);
    expect(s.ctx.identities.get('bob')).toBeNull();
    // a pasted token is not an OAuth grant: nothing to revoke
    expect(s.ctx.identities.revoke).not.toHaveBeenCalled();
  });

  it('a fine-grained token (no scopes header) is fine; commits use the noreply address', async () => {
    const r = await s.call('PUT', '/me/github', { token: 'github_pat_fine' }, as('bob'));
    expect(r.data).toMatchObject({ connected: true, login: 'fine', git_name: 'Fine Grained', git_email: '8+fine@users.noreply.github.com' });
  });

  it('refuses a classic token without the repo scope, and a token GitHub does not accept', async () => {
    const weak = await s.call('PUT', '/me/github', { token: 'ghp_noRepo' }, as('bob'));
    expect(weak.status).toBe(400);
    expect(weak.data.error).toMatch(/repo/);
    const bad = await s.call('PUT', '/me/github', { token: 'ghp_unknown' }, as('bob'));
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/did not accept/);
    expect(s.ctx.identities.get('bob')).toBeNull();
  });

  it('tokens cannot use these routes', async () => {
    const made = await s.call('POST', '/tokens', { name: 't', scopes: ['read', 'tracker', 'sessions'] }, as('bob'));
    const bearer = { authorization: `Bearer ${made.data.secret}` };
    expect((await s.call('GET', '/me/github', undefined, bearer)).status).toBe(403);
    expect((await s.call('PUT', '/me/github', { token: PAT }, bearer)).status).toBe(403);
  });

  it('the install owner sees the env accounts it uses when not connected', async () => {
    const r = await s.call('GET', '/me/github', undefined, as('alice'));
    expect(r.data).toMatchObject({ connected: false, uses_env_when_unconnected: true, env_accounts: [] });
  });

  const start = (user: string, to = '/settings') => s.app.inject({ method: 'GET', url: `/api/github/oauth/start?to=${encodeURIComponent(to)}`, headers: as(user) });
  const stateOf = (location: string) => new URL(location).searchParams.get('state')!;
  const callback = (user: string, q: Record<string, string>, cookie?: string) =>
    s.app.inject({ method: 'GET', url: `/api/github/oauth/callback?${new URLSearchParams(q)}`, headers: { ...as(user), ...(cookie ? { cookie: `dsp_gh_state=${cookie}` } : {}) } });
  const failed = (r: { statusCode: number; headers: Record<string, unknown> }) => {
    expect(r.statusCode).toBe(302);
    const loc = String(r.headers.location);
    expect(loc).toMatch(/^\/settings\?github_error=.+#your-github$/);
    return decodeURIComponent(loc.split('github_error=')[1].split('#')[0]);
  };

  it('OAuth start sends the browser to GitHub with the scopes and a state, and sets the state cookie', async () => {
    const r = await start('bob', '/projects/AB');
    expect(r.statusCode).toBe(302);
    const url = new URL(String(r.headers.location));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('scope')).toBe('repo read:user user:email');
    expect(url.searchParams.get('redirect_uri')).toBe('https://dispatch.example.com/api/github/oauth/callback');
    const state = url.searchParams.get('state')!;
    expect(state.length).toBeGreaterThan(20);
    const cookie = r.cookies.find((c) => c.name === 'dsp_gh_state')!;
    expect(cookie.value).toBe(state);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(JSON.stringify(r.headers)).not.toContain('csecret');
  });

  it('OAuth callback refuses a wrong state, a missing cookie and another user', async () => {
    const state = stateOf(String((await start('bob')).headers.location));
    expect(failed(await callback('bob', { code: 'good-code', state: 'nope' }, 'nope'))).toMatch(/expired|again/i);
    expect(failed(await callback('bob', { code: 'good-code', state }))).toMatch(/again/i);
    const state2 = stateOf(String((await start('bob')).headers.location));
    expect(failed(await callback('alice', { code: 'good-code', state: state2 }, state2))).toMatch(/again/i);
    expect(s.ctx.identities.exchange).not.toHaveBeenCalled();
    expect(s.ctx.identities.get('bob')).toBeNull();
    expect(s.ctx.identities.get('alice')).toBeNull();
  });

  it('OAuth callback connects, redirects back, and stores only ciphertext', async () => {
    const state = stateOf(String((await start('bob', '/projects/AB?tab=1')).headers.location));
    const r = await callback('bob', { code: 'good-code', state }, state);
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/projects/AB?tab=1&github=connected');
    expect(s.ctx.identities.get('bob')).toMatchObject({ login: 'bob-gh', token: OAUTH_TOKEN, git_name: 'bob-gh', git_email: '42+bob-gh@users.noreply.github.com' });
    expect((await s.call('GET', '/me/github', undefined, as('bob'))).data).toMatchObject({ connected: true, kind: 'oauth' });
    const row = s.ctx.store.db.get<{ token_enc: string }>("SELECT token_enc FROM github_identities WHERE user = 'bob'")!;
    expect(row.token_enc.startsWith('v1.')).toBe(true);
    expect(JSON.stringify(s.ctx.store.db.all('SELECT * FROM github_identities'))).not.toContain(OAUTH_TOKEN);
    // the state is used up
    expect(failed(await callback('bob', { code: 'good-code', state }, state))).toBeTruthy();
    // disconnecting an OAuth connection revokes the grant
    await s.call('DELETE', '/me/github', undefined, as('bob'));
    expect(s.ctx.identities.revoke).toHaveBeenCalledWith(OAUTH_TOKEN);
  });

  it('OAuth start only goes back into Dispatch', async () => {
    for (const to of ['//evil.example.com', 'https://evil.example.com', '/\\evil.example.com']) {
      const state = stateOf(String((await start('bob', to)).headers.location));
      const r = await callback('bob', { code: 'good-code', state }, state);
      expect(r.headers.location).toBe('/settings?github=connected');
    }
  });

  it('a GitHub error and a failed exchange come back to Settings', async () => {
    let state = stateOf(String((await start('bob')).headers.location));
    expect(failed(await callback('bob', { error: 'access_denied', error_description: 'The user has denied your application access.', state }, state))).toMatch(/denied/);
    state = stateOf(String((await start('bob')).headers.location));
    expect(failed(await callback('bob', { code: 'bad-code', state }, state))).toMatch(/refused/);
  });

  it('no token or ciphertext in any answer', async () => {
    await s.call('PUT', '/me/github', { token: PAT }, as('bob'));
    const enc = s.ctx.store.db.get<{ token_enc: string }>("SELECT token_enc FROM github_identities WHERE user = 'bob'")!.token_enc;
    for (const user of ['bob', 'alice']) {
      for (const path of ['/me/github', '/me', '/settings', '/accounts', '/workers', '/sessions']) {
        const r = await s.call('GET', path, undefined, as(user));
        const text = JSON.stringify(r.data);
        expect(text, `${user} ${path}`).not.toContain(PAT);
        expect(text, `${user} ${path}`).not.toContain(enc);
        expect(text, `${user} ${path}`).not.toContain(enc.slice(3, 40));
      }
    }
  });
});

describe('without a GitHub OAuth App', () => {
  it('OAuth start is not found, and Settings offers only the pasted token', async () => {
    const s = await startMultiUser();
    try {
      expect((await s.app.inject({ method: 'GET', url: '/api/github/oauth/start?to=/settings', headers: as('bob') })).statusCode).toBe(404);
      expect((await s.call('GET', '/me/github', undefined, as('bob'))).data.oauth_available).toBe(false);
    } finally {
      await s.app.close();
    }
  });
});

describe('the encryption key', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const open = async (dir: string, key?: string) => {
    const cfg = loadConfig({ WORKER_TOKEN: 'w', DISABLE_AUTH: '1', WEB_DIST: '/nonexistent', DATA_DIR: dir, ...(key ? { DISPATCH_SECRET_KEY: key } : {}) });
    return buildApp(cfg, { dbFile: join(dir, 'dispatch.db') });
  };

  it('a generated key file is shown to the install owner and reused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsp-ghid-'));
    dirs.push(dir);
    const a = await open(dir);
    a.ctx.identities.profile = async () => profiles[PAT];
    await a.ctx.identities.connect('local', PAT, 'pat');
    const me = await a.app.inject({ method: 'GET', url: '/api/me' });
    expect(me.json().secret_key_file).toBe(join(dir, 'secret.key'));
    await a.app.close();
    const b = await open(dir);
    expect(b.ctx.identities.get('local')).toMatchObject({ token: PAT });
    await b.app.close();
  });

  it('a changed key marks every connection "connect again"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsp-ghid-'));
    dirs.push(dir);
    const a = await open(dir, randomBytes(32).toString('hex'));
    a.ctx.identities.profile = async () => profiles[PAT];
    await a.ctx.identities.connect('local', PAT, 'pat');
    expect((await a.app.inject({ method: 'GET', url: '/api/me' })).json().secret_key_file).toBeNull();
    await a.app.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = await open(dir, randomBytes(32).toString('hex'));
    expect(warn).toHaveBeenCalled();
    expect(b.ctx.identities.get('local')).toEqual({ error: 'Dispatch cannot read this token any more (its key changed). Connect again.' });
    expect(b.ctx.identities.info('local')!.last_error).toMatch(/Connect again/);
    expect(b.ctx.identities.listConnected()).toEqual([]);
    await b.app.close();
  });
});
