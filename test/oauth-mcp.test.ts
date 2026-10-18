import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { allowedRedirect } from '../src/server/oauth.ts';
import { startServer } from './helpers.ts';

const REDIRECT = 'http://localhost:33418/callback';

async function setup(env: Record<string, string> = {}) {
  const s = await startServer({ DISABLE_AUTH: '', APP_PASSWORD: 'pw', PUBLIC_URL: 'https://dispatch.example.com', ...env });
  const login = await s.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  await s.app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: { key: 'MC', name: 'Mcp' } });
  return { s, cookie };
}

/** register → authorize (consent) → code → tokens, as an MCP client does */
async function connect(s: Awaited<ReturnType<typeof startServer>>, cookie: string, scope = 'read tracker') {
  const reg = await s.app.inject({ method: 'POST', url: '/register', payload: { client_name: 'Claude Code', redirect_uris: [REDIRECT] } });
  expect(reg.statusCode).toBe(201);
  const client_id = reg.json().client_id as string;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st123456', scope });
  const consent = await s.app.inject({ method: 'GET', url: `/authorize?${q}`, headers: { cookie } });
  expect(consent.statusCode).toBe(200);
  expect(consent.body).toContain('Allow Claude Code?');
  const request = consent.body.match(/name="request" value="([^"]+)"/)![1];
  const allow = await s.app.inject({ method: 'POST', url: '/authorize', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `request=${request}&decision=allow` });
  expect(allow.statusCode).toBe(302);
  const back = new URL(String(allow.headers.location));
  expect(back.searchParams.get('state')).toBe('st123456');
  const code = back.searchParams.get('code')!;
  return { client_id, verifier, code };
}

const form = (o: Record<string, string>) => ({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(o).toString() });

async function mcp(s: Awaited<ReturnType<typeof startServer>>, token: string, method: string, params: object = {}) {
  const r = await s.app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });
  return { status: r.statusCode, body: r.statusCode === 200 ? r.json() : r.body, headers: r.headers };
}

describe('OAuth for MCP clients', () => {
  it('publishes its metadata', async () => {
    const { s } = await setup();
    const meta = (await s.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(meta).toMatchObject({ issuer: 'https://dispatch.example.com', token_endpoint: 'https://dispatch.example.com/token', code_challenge_methods_supported: ['S256'] });
    expect((await s.app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' })).json()).toMatchObject({ resource: 'https://dispatch.example.com/mcp' });
    // an unauthenticated MCP call points the client at it
    const r = await mcp(s, 'nope', 'tools/list');
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toContain('resource_metadata="https://dispatch.example.com/.well-known/oauth-protected-resource/mcp"');
    await s.app.close();
  });

  it('connects, works the tracker, refreshes with rotation, and stops when disconnected', async () => {
    const { s, cookie } = await setup();
    try {
      const { client_id, verifier, code } = await connect(s, cookie);
      // a wrong verifier fails, and the code is then used up
      const tok = await s.app.inject({ method: 'POST', url: '/token', ...form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id, code_verifier: verifier }) });
      expect(tok.statusCode).toBe(200);
      const t = tok.json();
      expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 86400, scope: 'read tracker' });
      expect((await s.app.inject({ method: 'POST', url: '/token', ...form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id, code_verifier: verifier }) })).statusCode).toBe(400);

      const tools = await mcp(s, t.access_token, 'tools/list');
      expect(tools.status).toBe(200);
      const names = tools.body.result.tools.map((x: { name: string }) => x.name);
      expect(names).toEqual(expect.arrayContaining(['list_projects', 'list_items', 'get_item', 'add_item', 'update_item', 'add_comment', 'release_items']));
      expect(names.some((n: string) => /batch|session|merge|setting/.test(n))).toBe(false);

      const added = await mcp(s, t.access_token, 'tools/call', { name: 'add_item', arguments: { project: 'MC', title: 'Filed from claude.ai', importance: 'High', tags: ['mcp'] } });
      expect(JSON.parse(added.body.result.content[0].text)).toEqual({ created: 'MC-1' });
      await mcp(s, t.access_token, 'tools/call', { name: 'add_comment', arguments: { key: 'MC-1', text: 'Found it' } });
      const item = (await s.app.inject({ method: 'GET', url: '/api/items/by-key/MC-1', headers: { cookie } })).json();
      expect(item).toMatchObject({ title: 'Filed from claude.ai', importance: 3, labels: ['mcp'] });
      const detail = (await s.app.inject({ method: 'GET', url: `/api/items/${item.id}`, headers: { cookie } })).json();
      expect(detail.comments[0]).toMatchObject({ author: 'claude', body_md: 'Found it' });

      // refresh rotates: the new pair works, the old refresh token does not
      const r2 = (await s.app.inject({ method: 'POST', url: '/token', ...form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id }) })).json();
      expect(r2.access_token).toBeTruthy();
      expect((await s.app.inject({ method: 'POST', url: '/token', ...form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id }) })).statusCode).toBe(400);
      expect((await mcp(s, t.access_token, 'tools/list')).status).toBe(401);
      expect((await mcp(s, r2.access_token, 'tools/list')).status).toBe(200);

      // Settings: listed, and disconnecting ends it
      const grants = (await s.app.inject({ method: 'GET', url: '/api/oauth/grants', headers: { cookie } })).json();
      expect(grants).toEqual([expect.objectContaining({ client_name: 'Claude Code', scopes: ['read', 'tracker'] })]);
      await s.app.inject({ method: 'DELETE', url: `/api/oauth/grants/${grants[0].id}`, headers: { cookie } });
      expect((await mcp(s, r2.access_token, 'tools/list')).status).toBe(401);
      expect((await s.app.inject({ method: 'POST', url: '/token', ...form({ grant_type: 'refresh_token', refresh_token: r2.refresh_token, client_id }) })).statusCode).toBe(400);
      // the OAuth token is no key to the REST API
      expect((await s.app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Bearer ${r2.access_token}` } })).statusCode).toBe(401);
    } finally {
      await s.app.close();
    }
  });

  it('a read-only connection cannot write', async () => {
    const { s, cookie } = await setup();
    const { client_id, verifier, code } = await connect(s, cookie, 'read');
    const t = (await s.app.inject({ method: 'POST', url: '/token', ...form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id, code_verifier: verifier }) })).json();
    expect(t.scope).toBe('read');
    const r = await mcp(s, t.access_token, 'tools/call', { name: 'add_item', arguments: { project: 'MC', title: 'x' } });
    expect(r.body.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('may only read') }] });
    await s.app.close();
  });

  it('refuses what an attacker would try', async () => {
    const { s, cookie } = await setup();
    try {
      const { client_id, code } = await connect(s, cookie);
      // wrong PKCE verifier
      expect((await s.app.inject({ method: 'POST', url: '/token', ...form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id, code_verifier: 'guess' }) })).json()).toMatchObject({ error: 'invalid_grant' });
      // registering a non-https, non-local return address
      expect((await s.app.inject({ method: 'POST', url: '/register', payload: { client_name: 'x', redirect_uris: ['http://evil.example/cb'] } })).statusCode).toBe(400);
      // an unregistered return address at authorize
      const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'https://evil.example/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
      expect((await s.app.inject({ method: 'GET', url: `/authorize?${q}`, headers: { cookie } })).statusCode).toBe(400);
      // no PKCE
      const nopkce = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT });
      expect(String((await s.app.inject({ method: 'GET', url: `/authorize?${nopkce}`, headers: { cookie } })).headers.location)).toContain('error=invalid_request');
      // nobody signed in: sent to the login page, and no code
      const ok = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
      const anon = await s.app.inject({ method: 'GET', url: `/authorize?${ok}` });
      expect(anon.statusCode).toBe(302);
      expect(String(anon.headers.location)).toMatch(/^\/\?next=%2Fauthorize/);
      // a forged decision without the approval step
      const forged = await s.app.inject({ method: 'POST', url: '/authorize', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'request=made-up&decision=allow' });
      expect(forged.statusCode).toBe(400);
      expect(forged.headers.location).toBeUndefined();
    } finally {
      await s.app.close();
    }
  });

  it('behind a proxy, only a person the proxy names can approve', async () => {
    const s = await startServer({ DISABLE_AUTH: '', AUTH_MODE: 'proxy', TRUSTED_PROXIES: '10.9.9.9', AUTH_USERS: 'alice', PUBLIC_URL: 'https://dispatch.example.com' });
    try {
      const reg = (await s.app.inject({ method: 'POST', url: '/register', remoteAddress: '10.9.9.9', payload: { client_name: 'claude.ai', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } })).json();
      const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
      expect((await s.app.inject({ method: 'GET', url: `/authorize?${q}`, remoteAddress: '10.9.9.9' })).statusCode).toBe(401);
      expect((await s.app.inject({ method: 'GET', url: `/authorize?${q}`, remoteAddress: '10.9.9.9', headers: { 'remote-user': 'mallory' } })).statusCode).toBe(401);
      expect((await s.app.inject({ method: 'GET', url: `/authorize?${q}`, remoteAddress: '192.168.1.50', headers: { 'remote-user': 'alice' } })).statusCode).toBe(403);
      const ok = await s.app.inject({ method: 'GET', url: `/authorize?${q}`, remoteAddress: '10.9.9.9', headers: { 'remote-user': 'alice' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toContain('Signed in as alice');
    } finally {
      await s.app.close();
    }
  });

  it('accepts only https or loopback return addresses', () => {
    expect(allowedRedirect('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(allowedRedirect('http://localhost:5555/cb')).toBe(true);
    expect(allowedRedirect('http://127.0.0.1:5555/cb')).toBe(true);
    expect(allowedRedirect('http://evil.example/cb')).toBe(false);
    expect(allowedRedirect('https://user:pw@evil.example/cb')).toBe(false);
    expect(allowedRedirect('javascript:alert(1)')).toBe(false);
  });
});
