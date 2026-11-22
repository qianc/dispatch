// DISP-132: a person taken off AUTH_USERS loses every way in, not only the proxy's user header:
// their paired devices, their dsp_ tokens and their Claude connectors are refused too.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { startMultiUser } from './helpers.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('a user removed from AUTH_USERS', () => {
  it('loses their device cookie, API tokens and OAuth access tokens', async () => {
    const s = await startMultiUser();
    try {
      // bob's phone, paired
      const { pair_id, code } = s.ctx.devices.start('iPhone', '127.0.0.1');
      expect(s.ctx.devices.approve(code, 'bob')).toBeTruthy();
      const collected = s.ctx.devices.collect(pair_id);
      if (collected.status !== 'approved') throw new Error('not approved');
      const cookie = `dispatch_device=${collected.secret}`;
      // bob's token, with no expiry
      const { secret: token } = s.ctx.access.createToken('laptop', ['read', 'tracker'], null, 'bob');
      // bob's Claude connector
      const db = s.ctx.store.db;
      db.run('INSERT INTO oauth_clients (client_id, name, redirect_uris) VALUES (?, ?, ?)', 'mcp_bob', 'claude.ai', '["https://claude.ai/api/mcp/auth_callback"]');
      const access = 'dsa_bob_access_token_value_1234567890';
      const later = new Date(Date.now() + 3600_000).toISOString();
      db.run(
        'INSERT INTO oauth_grants (client_id, user, scopes, access_hash, access_expires_at, refresh_hash, refresh_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        'mcp_bob', 'bob', '["read","tracker"]', sha256(access), later, sha256('dsr_bob_refresh'), later,
      );

      const me = async () => (await s.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
      const withToken = async () => (await s.app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Bearer ${token}` } })).statusCode;
      const mcp = async () => (await s.app.inject({
        method: 'POST', url: '/mcp',
        headers: { authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      })).statusCode;

      // while bob is on the list, all three work as bob
      expect(await me()).toMatchObject({ authed: true, user: 'bob' });
      expect(await withToken()).toBe(200);
      expect(await mcp()).toBe(200);

      // the owner takes bob off the list
      s.ctx.cfg.authUsers = ['alice'];
      expect(await me()).toMatchObject({ authed: false, user: null });
      expect(await withToken()).toBe(401);
      expect(await mcp()).toBe(401);
    } finally {
      await s.app.close();
    }
  });
});
