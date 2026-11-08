// DISP-71: password mode. Sessions live in the database and can be revoked; a per-address limit
// stops password guessing before the password is checked; the hash check never blocks the server.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth, COOKIE, hashPassword } from '../src/server/auth.ts';
import { Db } from '../src/server/db.ts';
import { loadConfig } from '../src/server/config.ts';
import { as, startMultiUser, startServer } from './helpers.ts';

type Server = Awaited<ReturnType<typeof startServer>>;

async function login(s: Server, password = 'pw', remoteAddress = '127.0.0.1', headers: Record<string, string> = {}) {
  const r = await s.app.inject({ method: 'POST', url: '/api/login', remoteAddress, headers, payload: { password } });
  const cookie = r.statusCode === 200 ? String(r.headers['set-cookie']).split(';')[0] : null;
  return { r, cookie };
}
const me = async (s: Server, cookie: string | null) => (await s.app.inject({ method: 'GET', url: '/api/me', headers: cookie ? { cookie } : {} })).json();

describe('password sessions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('are listed, and a revoked one is refused', async () => {
    const s = await startServer({ DISABLE_AUTH: '', APP_PASSWORD: 'pw' });
    try {
      const laptop = (await login(s, 'pw', '127.0.0.1', { 'user-agent': 'Mozilla/5.0 (Macintosh)' })).cookie!;
      const phone = (await login(s, 'pw', '127.0.0.1', { 'user-agent': 'Mozilla/5.0 (iPhone)' })).cookie!;
      expect(laptop).toMatch(new RegExp(`^${COOKIE}=dss_`));
      expect(laptop).not.toBe(phone);
      // only the hash is in the database
      expect(JSON.stringify(s.ctx.store.db.all('SELECT * FROM web_sessions'))).not.toContain(laptop.split('=')[1]);
      const list = (await s.app.inject({ method: 'GET', url: '/api/logins', headers: { cookie: laptop } })).json();
      expect(list).toEqual([
        expect.objectContaining({ name: 'iPhone', current: false }),
        expect.objectContaining({ name: 'Mac', current: true, created_at: expect.any(String), expires_at: expect.any(String) }),
      ]);
      // revoke the phone from the laptop: the phone is signed out, the laptop is not
      expect((await s.app.inject({ method: 'DELETE', url: `/api/logins/${list[0].id}`, headers: { cookie: laptop } })).statusCode).toBe(200);
      expect((await me(s, phone)).authed).toBe(false);
      expect((await me(s, laptop)).authed).toBe(true);
      expect((await s.app.inject({ method: 'GET', url: '/api/logins', headers: { cookie: laptop } })).json()).toHaveLength(1);
      // logging out deletes the row, so the cookie is good for nothing afterwards
      await s.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: laptop } });
      expect((await me(s, laptop)).authed).toBe(false);
      expect(s.ctx.store.db.all('SELECT * FROM web_sessions')).toEqual([]);
      // the signed cookie of earlier versions is no session
      expect((await me(s, `${COOKIE}=1700000000000.abcdef`)).authed).toBe(false);
    } finally {
      await s.app.close();
    }
  });

  it('"sign out everywhere" ends every session, including this one', async () => {
    const s = await startServer({ DISABLE_AUTH: '', APP_PASSWORD: 'pw' });
    try {
      const a = (await login(s)).cookie!;
      const b = (await login(s)).cookie!;
      const r = await s.app.inject({ method: 'DELETE', url: '/api/logins', headers: { cookie: a } });
      expect(r.statusCode).toBe(200);
      expect(String(r.headers['set-cookie'])).toMatch(new RegExp(`^${COOKIE}=;`));
      expect((await me(s, a)).authed).toBe(false);
      expect((await me(s, b)).authed).toBe(false);
      expect((await login(s)).r.statusCode).toBe(200);
    } finally {
      await s.app.close();
    }
  });

  it('behind a proxy, only the install owner sees the password sessions', async () => {
    const s = await startMultiUser({ APP_PASSWORD: 'pw' });
    try {
      await login(s); // from this machine, the way in when the proxy is down
      expect((await s.app.inject({ method: 'GET', url: '/api/logins', headers: as('bob') })).statusCode).toBe(403);
      expect((await s.app.inject({ method: 'DELETE', url: '/api/logins', headers: as('bob') })).statusCode).toBe(403);
      expect((await s.app.inject({ method: 'GET', url: '/api/logins', headers: as('alice') })).json()).toEqual([expect.objectContaining({ current: false })]);
    } finally {
      await s.app.close();
    }
  });

  it('a changed password ends every session', () => {
    const db = new Db(':memory:');
    const cfg = (password: string) => loadConfig({ WORKER_TOKEN: 't', APP_PASSWORD: password });
    const auth = new Auth(cfg('old'), db);
    const first = auth.create('Mac');
    expect(auth.find(first.secret)).toMatchObject({ id: first.id, name: 'Mac' });
    // the same password at the next start: the session survives
    expect(new Auth(cfg('old'), db).find(first.secret)).not.toBeNull();
    // a new password: it does not
    expect(new Auth(cfg('new'), db).find(first.secret)).toBeNull();
    expect(db.all('SELECT * FROM web_sessions')).toEqual([]);
  });

  it('after five wrong passwords an address waits, and is refused before the password is checked', async () => {
    const s = await startServer({ DISABLE_AUTH: '', APP_PASSWORD: 'pw' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const attacker = '203.0.113.7';
      const wrong = await Promise.all(Array.from({ length: 5 }, () => login(s, 'nope', attacker)));
      expect(wrong.map((w) => w.r.statusCode)).toEqual([401, 401, 401, 401, 401]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes(attacker))).toBe(true);
      // the sixth, with the right password: refused, and the password was never looked at
      const check = vi.spyOn(s.ctx.auth, 'checkPassword');
      const sixth = await login(s, 'pw', attacker);
      expect(sixth.r.statusCode).toBe(429);
      expect(Number(sixth.r.headers['retry-after'])).toBeGreaterThan(0);
      expect(sixth.r.json().error).toMatch(/Too many wrong passwords/);
      expect(check).not.toHaveBeenCalled();
      // another address is not held to it
      expect((await login(s, 'pw', '198.51.100.9')).r.statusCode).toBe(200);
    } finally {
      await s.app.close();
    }
  });

  it('a flood of wrong passwords does not delay other requests', async () => {
    const s = await startServer({ DISABLE_AUTH: '', APP_PASSWORD_HASH: hashPassword('pw') });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // the longest the event loop stands still while the flood is checked: a stalled loop is a
      // stalled server (the sync hash took it 1.7 s for 60 attempts)
      let stall = 0;
      let last = Date.now();
      let done = false;
      const tick = () => {
        const n = Date.now();
        stall = Math.max(stall, n - last - 5);
        last = n;
        if (!done) setTimeout(tick, 5);
      };
      setTimeout(tick, 5);
      // from many addresses, so the rate limit lets them through to the hash check
      const flood = await Promise.all(Array.from({ length: 60 }, (_, i) => login(s, 'nope', `198.51.100.${i + 1}`)));
      done = true;
      expect(flood.every((f) => f.r.statusCode === 401)).toBe(true);
      expect(stall).toBeLessThan(200);
    } finally {
      await s.app.close();
    }
  });
});
