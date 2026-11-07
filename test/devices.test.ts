import { describe, expect, it } from 'vitest';
import { startServer } from './helpers.ts';

// A phone's home-screen app cannot use the proxy's SSO (e.g. a managed-browser-only Entra policy on
// iOS). It pairs instead: it shows a code, a person signed in through the proxy approves it, and the
// phone gets its own long-lived, revocable device session.
const PROXY = '10.9.9.9';
const SECRET = 'a-long-random-proxy-secret-123456';

async function proxyServer() {
  const s = await startServer({ DISABLE_AUTH: '', AUTH_MODE: 'proxy', TRUSTED_PROXIES: PROXY, AUTH_USERS: 'alice', PROXY_SECRET: SECRET });
  type Opts = { headers?: Record<string, string>; payload?: object; user?: string; cookie?: string };
  const call = (method: string, url: string, o: Opts = {}) => s.app.inject({
    method: method as 'GET', url, remoteAddress: PROXY, payload: o.payload,
    headers: { 'x-proxy-secret': SECRET, ...(o.user ? { 'remote-user': o.user } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers },
  });
  return { s, call };
}

const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie'] ?? '').split(';')[0];

describe('device pairing', () => {
  it('pairs a phone: code shown on the phone, approved by a signed-in person, cookie handed over once', async () => {
    const { s, call } = await proxyServer();
    try {
      const start = await call('POST', '/api/devices/pair', { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' } });
      expect(start.statusCode).toBe(200);
      const { pair_id, code } = start.json();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect((await call('GET', `/api/devices/pair/${pair_id}`)).json()).toEqual({ status: 'pending' });

      // approving needs a person signed in through the proxy
      expect((await call('POST', '/api/devices/approve', { payload: { code } })).statusCode).toBe(401);
      const ok = await call('POST', '/api/devices/approve', { user: 'alice', payload: { code: code.toLowerCase().replace('-', ' ') } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ name: 'iPhone', user: 'alice' });

      // the phone collects its cookie once
      const done = await call('GET', `/api/devices/pair/${pair_id}`);
      expect(done.json()).toEqual({ status: 'approved' });
      const cookie = cookieOf(done);
      expect(cookie).toMatch(/^dispatch_device=dsd_/);
      expect(String(done.headers['set-cookie'])).toMatch(/HttpOnly/i);
      expect((await call('GET', `/api/devices/pair/${pair_id}`)).json()).toEqual({ status: 'expired' });

      // the device is the person who approved it, with a person's rights
      expect((await call('GET', '/api/me', { cookie })).json()).toMatchObject({ authed: true, user: 'alice' });
      expect((await call('POST', '/api/projects', { cookie, payload: { key: 'PH', name: 'Phone' } })).statusCode).toBe(200);
      // only the hash is stored
      expect(JSON.stringify(s.ctx.store.db.all('SELECT * FROM devices'))).not.toContain(cookie.split('=')[1]);
      // a paired device asking to pair again is told it already is
      expect((await call('POST', '/api/devices/pair', { cookie })).json()).toEqual({ authed: true });
    } finally {
      await s.app.close();
    }
  });

  it('a device cannot pair other devices, and revoking or signing out ends it', async () => {
    const { s, call } = await proxyServer();
    try {
      const pair = async () => {
        const { pair_id, code } = (await call('POST', '/api/devices/pair')).json();
        await call('POST', '/api/devices/approve', { user: 'alice', payload: { code } });
        return cookieOf(await call('GET', `/api/devices/pair/${pair_id}`));
      };
      const phone = await pair();
      const { code } = (await call('POST', '/api/devices/pair')).json();
      const r = await call('POST', '/api/devices/approve', { cookie: phone, payload: { code } });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toMatch(/paired device/);

      const list = (await call('GET', '/api/devices', { user: 'alice' })).json();
      expect(list).toHaveLength(1);
      await call('DELETE', `/api/devices/${list[0].id}`, { user: 'alice' });
      expect((await call('GET', '/api/projects', { cookie: phone })).statusCode).toBe(401);
      // a dead device cookie is cleared, so the app can offer pairing again
      expect(String((await call('GET', '/api/me', { cookie: phone })).headers['set-cookie'])).toMatch(/dispatch_device=;/);

      const tablet = await pair();
      expect((await call('GET', '/api/projects', { cookie: tablet })).statusCode).toBe(200);
      await call('POST', '/api/logout', { cookie: tablet });
      expect((await call('GET', '/api/projects', { cookie: tablet })).statusCode).toBe(401);
    } finally {
      await s.app.close();
    }
  });

  it('refuses wrong, used and expired codes, and does not trust a device cookie from outside the proxy', async () => {
    const { s, call } = await proxyServer();
    try {
      expect((await call('POST', '/api/devices/approve', { user: 'alice', payload: { code: 'AAAA-AAAA' } })).statusCode).toBe(404);
      const { pair_id, code } = (await call('POST', '/api/devices/pair')).json();
      s.ctx.devices.expireAll();
      expect((await call('POST', '/api/devices/approve', { user: 'alice', payload: { code } })).statusCode).toBe(404);
      expect((await call('GET', `/api/devices/pair/${pair_id}`)).json()).toEqual({ status: 'expired' });
      expect((await call('GET', '/api/devices/pair/not-a-real-id')).json()).toEqual({ status: 'expired' });

      const p = (await call('POST', '/api/devices/pair')).json();
      await call('POST', '/api/devices/approve', { user: 'alice', payload: { code: p.code } });
      expect((await call('POST', '/api/devices/approve', { user: 'alice', payload: { code: p.code } })).statusCode).toBe(404);
      const cookie = cookieOf(await call('GET', `/api/devices/pair/${p.pair_id}`));
      // straight to the port, around the proxy: refused like everything else
      const direct = await s.app.inject({ method: 'GET', url: '/api/projects', remoteAddress: '192.168.1.50', headers: { cookie } });
      expect(direct.statusCode).toBe(403);
      // expired devices stop working
      s.ctx.store.db.run("UPDATE devices SET expires_at = '2000-01-01T00:00:00.000Z'");
      expect((await call('GET', '/api/projects', { cookie })).statusCode).toBe(401);
    } finally {
      await s.app.close();
    }
  });
});
