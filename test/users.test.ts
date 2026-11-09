import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/server/db.ts';
import { Users } from '../src/server/users.ts';
import { loadConfig } from '../src/server/config.ts';
import { as, startMultiUser, startServer } from './helpers.ts';

/** A database as an older Dispatch left it: rows that belong to nobody yet. */
function oldDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-users-'));
  const db = new Db(join(dir, 'd.db'));
  const p = db.run("INSERT INTO projects (key, name, importance_scale, effort_scale) VALUES ('US', 'Users', '[]', '[]')").lastId;
  db.run("INSERT INTO sessions (project_id, kind, title, status) VALUES (?, 'batch', 's', 'done')", p);
  db.run("INSERT INTO schedules (project_id, name, at_time) VALUES (?, 'nightly', '02:00')", p);
  db.run("INSERT INTO api_tokens (name, prefix, hash, scopes) VALUES ('ci', 'dsp_x', 'h1', '[\"read\"]')");
  db.run("INSERT INTO devices (name, user, hash, expires_at) VALUES ('iPhone', 'owner', 'h2', '2999-01-01')");
  db.run("INSERT INTO oauth_clients (client_id, name, redirect_uris) VALUES ('c1', 'Claude', '[]')");
  db.run("INSERT INTO oauth_grants (client_id, user, scopes, access_hash, access_expires_at, refresh_hash, refresh_expires_at) VALUES ('c1', 'owner', '[]', 'a', '2999', 'r', '2999')");
  db.run("INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ('https://push.example/1', 'p', 'a')");
  db.setSetting('default_worker_id', String(db.get<{ id: number }>('SELECT id FROM workers')!.id));
  return { db, dir };
}

const owners = (db: Db) => ({
  worker: db.get<{ v: string | null }>('SELECT owner AS v FROM workers')!.v,
  token: db.get<{ v: string | null }>('SELECT user AS v FROM api_tokens')!.v,
  schedule: db.get<{ v: string | null }>('SELECT owner AS v FROM schedules')!.v,
  session: db.get<{ v: string | null }>('SELECT started_by AS v FROM sessions')!.v,
  device: db.get<{ v: string }>('SELECT user AS v FROM devices')!.v,
  grant: db.get<{ v: string }>('SELECT user AS v FROM oauth_grants')!.v,
  push: db.get<{ v: string | null }>('SELECT user AS v FROM push_subscriptions')!.v,
});
const all = (name: string) => ({ worker: name, token: name, schedule: name, session: name, device: name, grant: name, push: name });

describe('Users.claim', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('gives every existing row to the install owner, once', () => {
    const { db, dir } = oldDb();
    dirs.push(dir);
    const users = new Users(db, { installOwner: 'carol' });
    users.claim();
    expect(owners(db)).toEqual(all('carol'));
    expect(db.setting('install_owner')).toBe('carol');
    const worker = db.get<{ id: number }>('SELECT id FROM workers')!.id;
    expect(users.list().map((u) => u.name)).toEqual(['carol']);
    expect(users.defaultWorker('carol')).toBe(worker);
    expect(users.isOwner('carol')).toBe(true);
    expect(users.isOwner('bob')).toBe(false);

    // a row made later with no owner is not claimed again
    db.run("INSERT INTO api_tokens (name, prefix, hash, scopes) VALUES ('later', 'dsp_y', 'h3', '[]')");
    users.claim();
    expect(db.get<{ user: string | null }>("SELECT user FROM api_tokens WHERE name = 'later'")!.user).toBeNull();
  });

  it('moves the rows from the placeholder owner to DISPATCH_OWNER', () => {
    const { db, dir } = oldDb();
    dirs.push(dir);
    new Users(db, { installOwner: 'owner' }).claim();
    expect(owners(db)).toEqual(all('owner'));
    const users = new Users(db, { installOwner: 'carol' });
    users.claim();
    expect(owners(db)).toEqual(all('carol'));
    expect(db.setting('install_owner')).toBe('carol');
    expect(users.list().map((u) => u.name)).toEqual(['carol']);
    expect(users.defaultWorker('carol')).not.toBeNull();
  });

  it('does not move rows from one real person to another', () => {
    const { db, dir } = oldDb();
    dirs.push(dir);
    new Users(db, { installOwner: 'alice' }).claim();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Users(db, { installOwner: 'bob' }).claim();
    expect(warn).toHaveBeenCalled();
    expect(owners(db)).toMatchObject({ worker: 'alice', token: 'alice', schedule: 'alice', session: 'alice' });
    expect(db.setting('install_owner')).toBe('alice');
  });
});

describe('install owner', () => {
  it('comes from DISPATCH_OWNER, the first allowed proxy user, or the single user', () => {
    const base = { WORKER_TOKEN: 't' };
    expect(loadConfig({ ...base, DISABLE_AUTH: '1' }).installOwner).toBe('local');
    expect(loadConfig({ ...base, APP_PASSWORD: 'pw' }).installOwner).toBe('owner');
    expect(loadConfig({ ...base, APP_PASSWORD: 'pw', DISPATCH_OWNER: 'carol' }).installOwner).toBe('carol');
    expect(loadConfig({ ...base, AUTH_MODE: 'proxy', TRUSTED_PROXIES: '10.0.0.1', AUTH_USERS: 'alice,bob' }).installOwner).toBe('alice');
    expect(loadConfig({ ...base, AUTH_MODE: 'proxy', TRUSTED_PROXIES: '10.0.0.1' }).installOwner).toBe('owner');
    const c = loadConfig({ ...base, DISABLE_AUTH: '1', GITHUB_OAUTH_CLIENT_ID: 'id', GITHUB_OAUTH_CLIENT_SECRET: 'sec', DISPATCH_SECRET_KEY: 'k' });
    expect(c.githubOAuth).toEqual({ clientId: 'id', clientSecret: 'sec' });
    expect(c.secretKey).toBe('k');
    expect(loadConfig({ ...base, DISABLE_AUTH: '1' }).githubOAuth).toBeNull();
  });

  it('the password sign-in is the install owner', async () => {
    const s = await startServer({ DISABLE_AUTH: '', APP_PASSWORD: 'pw', DISPATCH_OWNER: 'carol' });
    try {
      const login = await s.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const me = (await s.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
      expect(me).toMatchObject({ authed: true, user: 'carol', is_owner: true, install_owner: 'carol' });
    } finally {
      await s.app.close();
    }
  });

  it('auth off: the local user is the install owner', async () => {
    const s = await startServer();
    try {
      expect((await s.call('GET', '/me')).data).toMatchObject({ user: 'local', is_owner: true, install_owner: 'local' });
    } finally {
      await s.app.close();
    }
  });
});

describe('several users', () => {
  it('only the install owner changes install settings', async () => {
    const s = await startMultiUser();
    try {
      expect((await s.call('GET', '/me', undefined, as('bob'))).data).toMatchObject({ user: 'bob', is_owner: false, install_owner: 'alice' });
      const bob = await s.call('POST', '/projects', { key: 'BO', name: 'Bob' }, as('bob'));
      expect(bob.status).toBe(403);
      expect(bob.data.error).toBe('Only the install owner (alice) can change this.');
      expect((await s.call('POST', '/projects', { key: 'AL', name: 'Alice' }, as('alice'))).status).toBe(200);
      // bob still reads and signs in
      expect((await s.call('GET', '/projects', undefined, as('bob'))).status).toBe(200);
      expect(s.ctx.users.list().map((u) => u.name).sort()).toEqual(['alice', 'bob']);
    } finally {
      await s.app.close();
    }
  });

  it('a token of bob with the admin scope cannot do admin things', async () => {
    const s = await startMultiUser();
    try {
      const { secret } = s.ctx.access.createToken('sneaky', ['read', 'admin'], null, 'bob');
      const r = await s.call('POST', '/projects', { key: 'BO', name: 'Bob' }, { authorization: `Bearer ${secret}` });
      expect(r.status).toBe(403);
      const own = s.ctx.access.createToken('mine', ['read', 'admin'], null, 'alice').secret;
      expect((await s.call('POST', '/projects', { key: 'AL', name: 'Alice' }, { authorization: `Bearer ${own}` })).status).toBe(200);
    } finally {
      await s.app.close();
    }
  });

  it('each person sees and revokes their own tokens; the install owner sees and revokes all', async () => {
    const s = await startMultiUser();
    try {
      const a = await s.call('POST', '/tokens', { name: 'alice-ci', scopes: ['read', 'admin'] }, as('alice'));
      expect(a.status).toBe(200);
      expect(a.data.token.user).toBe('alice');
      const b = await s.call('POST', '/tokens', { name: 'bob-ci', scopes: ['tracker'] }, as('bob'));
      expect(b.status).toBe(200);
      expect(b.data.token.user).toBe('bob');
      // bob may not make an admin token
      expect((await s.call('POST', '/tokens', { name: 'bob-admin', scopes: ['admin'] }, as('bob'))).status).toBe(400);

      expect((await s.call('GET', '/tokens', undefined, as('bob'))).data.map((t: { name: string }) => t.name)).toEqual(['bob-ci']);
      expect((await s.call('GET', '/tokens', undefined, as('alice'))).data.map((t: { name: string; user: string }) => `${t.user}:${t.name}`)).toEqual(['bob:bob-ci', 'alice:alice-ci']);

      // bob cannot revoke alice's token, nor the legacy one
      expect((await s.call('DELETE', `/tokens/${a.data.token.id}`, undefined, as('bob'))).status).toBe(404);
      expect((await s.call('DELETE', '/tokens/legacy', undefined, as('bob'))).status).toBe(403);
      expect(s.ctx.access.tokens().find((t) => t.id === a.data.token.id)!.revoked_at).toBeNull();
      // alice can revoke bob's
      expect((await s.call('DELETE', `/tokens/${b.data.token.id}`, undefined, as('alice'))).status).toBe(200);
      expect(s.ctx.access.tokens().find((t) => t.id === b.data.token.id)!.revoked_at).not.toBeNull();
      // and bob his own
      const b2 = await s.call('POST', '/tokens', { name: 'bob-2', scopes: ['read'] }, as('bob'));
      expect((await s.call('DELETE', `/tokens/${b2.data.token.id}`, undefined, as('bob'))).status).toBe(200);
    } finally {
      await s.app.close();
    }
  });

  it('each person sees and revokes their own devices and connected apps; the install owner all', async () => {
    const s = await startMultiUser();
    try {
      const pair = (user: string) => {
        const { code } = s.ctx.devices.start('iPhone');
        return s.ctx.devices.approve(code, user)!;
      };
      const ad = pair('alice');
      const bd = pair('bob');
      expect((await s.call('GET', '/devices', undefined, as('bob'))).data.map((d: { id: number }) => d.id)).toEqual([bd.id]);
      expect((await s.call('GET', '/devices', undefined, as('alice'))).data.map((d: { id: number }) => d.id)).toEqual([bd.id, ad.id]);
      expect((await s.call('DELETE', `/devices/${ad.id}`, undefined, as('bob'))).status).toBe(404);
      expect(s.ctx.devices.list().map((d) => d.id)).toContain(ad.id);
      expect((await s.call('DELETE', `/devices/${bd.id}`, undefined, as('alice'))).status).toBe(200);
      expect(s.ctx.devices.list().map((d) => d.id)).toEqual([ad.id]);

      const db = s.ctx.store.db;
      db.run("INSERT INTO oauth_clients (client_id, name, redirect_uris) VALUES ('c1', 'Claude', '[]')");
      const grant = (user: string, n: number) => db.run(
        "INSERT INTO oauth_grants (client_id, user, scopes, access_hash, access_expires_at, refresh_hash, refresh_expires_at) VALUES ('c1', ?, '[]', ?, '2999', ?, '2999')", user, `a${n}`, `r${n}`,
      ).lastId;
      const ag = grant('alice', 1);
      const bg = grant('bob', 2);
      expect((await s.call('GET', '/oauth/grants', undefined, as('bob'))).data.map((g: { id: number }) => g.id)).toEqual([bg]);
      expect((await s.call('GET', '/oauth/grants', undefined, as('alice'))).data.map((g: { id: number }) => g.id)).toEqual([bg, ag]);
      expect((await s.call('DELETE', `/oauth/grants/${ag}`, undefined, as('bob'))).status).toBe(404);
      expect((await s.call('DELETE', `/oauth/grants/${bg}`, undefined, as('alice'))).status).toBe(200);
      expect((await s.call('GET', '/oauth/grants', undefined, as('alice'))).data.map((g: { id: number }) => g.id)).toEqual([ag]);
    } finally {
      await s.app.close();
    }
  });
});
