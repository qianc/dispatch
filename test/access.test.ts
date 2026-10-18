import { describe, expect, it } from 'vitest';
import { ROUTE_ACCESS, ipInList, isLoopback } from '../src/server/access.ts';
import { startServer } from './helpers.ts';

const LAN = '192.168.1.50';
const PROXY = '10.9.9.9';

describe('access rules', () => {
  it('every /api route has an access rule', async () => {
    const s = await startServer({ DISABLE_AUTH: '', APP_PASSWORD: 'pw' });
    const api = s.routes.filter((r) => / \/api\//.test(r) && !r.startsWith('HEAD ') && !r.startsWith('OPTIONS '));
    expect(api.length).toBeGreaterThan(50);
    expect(api.filter((r) => !(r in ROUTE_ACCESS))).toEqual([]);
    await s.app.close();
  });

  it('matches addresses and ranges', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('192.168.1.5')).toBe(false);
    expect(ipInList('::ffff:10.0.31.4', ['10.0.31.0/28'])).toBe(true);
    expect(ipInList('10.0.31.20', ['10.0.31.0/28'])).toBe(false);
    expect(ipInList('192.0.2.10', ['192.0.2.10'])).toBe(true);
    expect(ipInList('192.0.2.11', ['192.0.2.10'])).toBe(false);
  });
});

describe('tokens', () => {
  it('a token does what its scopes allow; from another machine only read and tracker', async () => {
    const s = await startServer({ DISABLE_AUTH: '', APP_PASSWORD: 'pw' });
    try {
      const login = await s.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      await s.app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: { key: 'TK', name: 'Tokens' } });
      const tracker = s.ctx.access.createToken('skill', ['tracker', 'read'], null).secret;
      const full = s.ctx.access.createToken('everything', ['read', 'tracker', 'sessions', 'admin'], null).secret;
      const call = (method: string, url: string, token: string, remoteAddress = '127.0.0.1', payload?: object) =>
        s.app.inject({ method: method as 'GET', url, remoteAddress, headers: { authorization: `Bearer ${token}` }, payload });

      // tracker: items yes, agents and settings no
      expect((await call('POST', '/api/projects/TK/items', tracker, '127.0.0.1', { title: 'From a skill' })).statusCode).toBe(200);
      expect((await call('POST', '/api/projects/TK/batches', tracker, '127.0.0.1', { prompt: 'x' })).statusCode).toBe(403);
      expect((await call('GET', '/api/settings', tracker)).statusCode).toBe(403);
      // a full token from this machine can do it all...
      expect((await call('GET', '/api/settings', full)).statusCode).toBe(200);
      // ...but from another machine it is cut back to read + tracker
      expect((await call('GET', '/api/settings', full, LAN)).statusCode).toBe(403);
      const r = await call('POST', '/api/projects/TK/batches', full, LAN, { prompt: 'x' });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toMatch(/limited to read and tracker/);
      expect((await call('POST', '/api/projects/TK/items', full, LAN, { title: 'Remote item' })).statusCode).toBe(200);
      // tokens never make tokens, even from this machine
      expect((await call('POST', '/api/tokens', full, '127.0.0.1', { name: 'x' })).statusCode).toBe(403);
      // a person can, and only the hash is kept
      const made = await s.app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: 'laptop' } });
      expect(made.json()).toMatchObject({ token: { name: 'laptop', scopes: ['tracker', 'read'] }, secret: expect.stringMatching(/^dsp_/) });
      expect(JSON.stringify(s.ctx.store.db.all('SELECT * FROM api_tokens'))).not.toContain(made.json().secret);
      // revoked and expired tokens stop working
      await s.app.inject({ method: 'DELETE', url: `/api/tokens/${made.json().token.id}`, headers: { cookie } });
      expect((await call('GET', '/api/projects', made.json().secret)).statusCode).toBe(401);
      const old = s.ctx.access.createToken('old', ['read'], new Date(Date.now() - 1000).toISOString()).secret;
      expect((await call('GET', '/api/projects', old)).statusCode).toBe(401);
      expect((await call('GET', '/api/projects', 'dsp_nonsense')).statusCode).toBe(401);
      // uses are recorded
      expect(s.ctx.access.tokens().find((t) => t.name === 'skill')!.last_used_at).not.toBeNull();
    } finally {
      await s.app.close();
    }
  });

  it('the old single token keeps working until retired, with the same remote limit', async () => {
    const s = await startServer({ DISABLE_AUTH: '', APP_PASSWORD: 'pw' });
    try {
      s.ctx.store.db.setSetting('api_token', 'dsp_legacy_token_value_1234567890');
      const call = (url: string, remoteAddress: string) => s.app.inject({ method: 'GET', url, remoteAddress, headers: { authorization: 'Bearer dsp_legacy_token_value_1234567890' } });
      expect((await call('/api/settings', '127.0.0.1')).statusCode).toBe(200);
      expect((await call('/api/settings', LAN)).statusCode).toBe(403);
      expect((await call('/api/projects', LAN)).statusCode).toBe(200);
      s.ctx.access.retireLegacyToken();
      expect((await call('/api/projects', '127.0.0.1')).statusCode).toBe(401);
    } finally {
      await s.app.close();
    }
  });
});

describe('proxy sign-in', () => {
  const proxyServer = () => startServer({ DISABLE_AUTH: '', AUTH_MODE: 'proxy', TRUSTED_PROXIES: PROXY, AUTH_USERS: 'alice', APP_PASSWORD: 'pw' });

  it('believes the user header only from the proxy, and only for allowed users', async () => {
    const s = await proxyServer();
    try {
      const get = (url: string, remoteAddress: string, headers: Record<string, string> = {}) => s.app.inject({ method: 'GET', url, remoteAddress, headers });
      expect((await get('/api/projects', PROXY, { 'remote-user': 'alice' })).statusCode).toBe(200);
      expect((await get('/api/me', PROXY, { 'remote-user': 'alice' })).json()).toMatchObject({ authed: true, user: 'alice', auth_mode: 'proxy', password_login: false });
      expect((await get('/api/projects', PROXY)).statusCode).toBe(401); // the proxy let nobody through
      expect((await get('/api/projects', PROXY, { 'remote-user': 'mallory' })).statusCode).toBe(401);
      // the same header straight from the LAN: refused before anything else, app pages too
      expect((await get('/api/projects', LAN, { 'remote-user': 'alice' })).statusCode).toBe(403);
      expect((await get('/', LAN)).statusCode).toBe(403);
      expect((await get('/mcp', LAN)).statusCode).toBe(403);
      // this machine: no header trust, the password login is the way in
      expect((await get('/api/projects', '127.0.0.1', { 'remote-user': 'alice' })).statusCode).toBe(401);
      expect((await get('/api/me', '127.0.0.1')).json()).toMatchObject({ authed: false, password_login: true });
      expect((await s.app.inject({ method: 'POST', url: '/api/login', remoteAddress: PROXY, payload: { password: 'pw' } })).statusCode).toBe(403);
      const login = await s.app.inject({ method: 'POST', url: '/api/login', remoteAddress: '127.0.0.1', payload: { password: 'pw' } });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      expect((await get('/api/projects', '127.0.0.1', { cookie })).statusCode).toBe(200);
      // a cookie from this machine does not work through the proxy
      expect((await get('/api/projects', PROXY, { cookie })).statusCode).toBe(401);
    } finally {
      await s.app.close();
    }
  });

  it('refuses to start without a proxy address', async () => {
    await expect(startServer({ DISABLE_AUTH: '', AUTH_MODE: 'proxy' })).rejects.toThrow(/TRUSTED_PROXIES/);
  });
});
