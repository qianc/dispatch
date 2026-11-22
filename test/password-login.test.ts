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

  // DISP-136: behind a reverse proxy every client has the proxy's address
  it('behind a proxy, only the client that guessed wrong is locked out', async () => {
    const s = await startServer({ DISABLE_AUTH: '', APP_PASSWORD: 'pw', TRUSTED_PROXIES: '10.9.9.9' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const proxy of ['127.0.0.1', '10.9.9.9']) {
        const via = (client: string) => ({ 'x-forwarded-for': `198.51.100.1, ${client}` });
        const attacker = proxy === '127.0.0.1' ? '203.0.113.7' : '203.0.113.8';
        for (let i = 0; i < 5; i++) expect((await login(s, 'nope', proxy, via(attacker))).r.statusCode).toBe(401);
        expect((await login(s, 'pw', proxy, via(attacker))).r.statusCode).toBe(429);
        expect(warn.mock.calls.some((c) => String(c[0]).includes(`from ${attacker}`))).toBe(true);
        // the owner through the same proxy gets in
        expect((await login(s, 'pw', proxy, via('192.0.2.44'))).r.statusCode).toBe(200);
      }
      // an address that is no proxy is held to its own address, whatever it claims to forward
      for (let i = 0; i < 5; i++) await login(s, 'nope', '192.0.2.99', { 'x-forwarded-for': `192.0.2.${i}` });
      expect((await login(s, 'pw', '192.0.2.99', { 'x-forwarded-for': '192.0.2.200' })).r.statusCode).toBe(429);
    } finally {
      await s.app.close();
    }
  });

  // DISP-189: an IPv6 line has a whole /64, so its addresses share one limit
  it('addresses in one IPv6 /64 share one limit; IPv4 addresses do not', async () => {
    const s = await startServer({ DISABLE_AUTH: '', APP_PASSWORD: 'pw' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (let i = 1; i <= 5; i++) expect((await login(s, 'nope', `2001:db8:1:2::${i}`)).r.statusCode).toBe(401);
      expect((await login(s, 'pw', '2001:db8:1:2:abcd:ef01:2345:6789')).r.statusCode).toBe(429);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('2001:db8:1:2::/64'))).toBe(true);
      // the next /64 is another client
      expect((await login(s, 'pw', '2001:db8:1:3::1')).r.statusCode).toBe(200);
      // IPv4 (also as IPv4-mapped IPv6) stays per address
      for (let i = 1; i <= 5; i++) await login(s, 'nope', '::ffff:203.0.113.5');
      expect((await login(s, 'pw', '203.0.113.5')).r.statusCode).toBe(429);
      expect((await login(s, 'pw', '::ffff:203.0.113.6')).r.statusCode).toBe(200);
    } finally {
      await s.app.close();
    }
  });

  it('parallel guesses against a hash get only the free attempts checked (DISP-201)', async () => {
    const s = await startServer({ DISABLE_AUTH: '', APP_PASSWORD_HASH: hashPassword('pw') });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const checked = vi.spyOn(s.ctx.auth, 'checkPassword');
    try {
      // all sent before any check is done: each one is counted before its hash check
      const guesses = await Promise.all(Array.from({ length: 10 }, (_, i) => login(s, `guess${i}`, '203.0.113.9')));
      expect(checked).toHaveBeenCalledTimes(5);
      expect(guesses.map((g) => g.r.statusCode).sort()).toEqual([401, 401, 401, 401, 401, 429, 429, 429, 429, 429]);
    } finally {
      await s.app.close();
    }
  });

  it('a right password after wrong ones clears the count', async () => {
    const s = await startServer({ DISABLE_AUTH: '', APP_PASSWORD_HASH: hashPassword('pw') });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const wrong = async (n: number) => (await Promise.all(Array.from({ length: n }, () => login(s, 'nope', '203.0.113.10')))).map((g) => g.r.statusCode);
      expect(await wrong(4)).toEqual([401, 401, 401, 401]);
      expect((await login(s, 'pw', '203.0.113.10')).r.statusCode).toBe(200);
      // five more wrong ones are free again
      expect(await wrong(5)).toEqual([401, 401, 401, 401, 401]);
      expect((await login(s, 'nope', '203.0.113.10')).r.statusCode).toBe(429);
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
