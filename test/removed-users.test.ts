// DISP-132: a person taken off AUTH_USERS loses every way in, not only the proxy's user header:
// their paired devices, their dsp_ tokens and their Claude connectors are refused too; and (DISP-173)
// their workers' dsw_ tokens and their schedules.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
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

  it('loses their workers at /worker and /git, and their schedules start nothing (DISP-173)', async () => {
    const s = await startMultiUser({ DATA_DIR: mkdtempSync(join(tmpdir(), 'dsp-removed-')) });
    try {
      const p = s.ctx.store.createProject({ key: 'RM', name: 'Removed', description: '', default_force_plan: false, importance_scale: ['a', 'b', 'c', 'd'], effort_scale: ['S'] });
      const repo = s.ctx.store.addRepo(p.id, { github_owner: 'hosted', github_name: 'app', default_branch: 'main', check_command: null, kind: 'hosted' });
      await s.ctx.hosted.create(repo, 'main');
      const { secret } = s.ctx.workers.create('bobs-laptop', '', 'bob');
      const sched = s.ctx.store.createSchedule(p.id, { name: 'nightly', at_time: '02:00', days: [0, 1, 2, 3, 4, 5, 6], scope_md: '', max_batches: 1, options: DEFAULT_RUN_OPTIONS, enabled: true, last_slot: null, owner: 'bob' });

      const attach = () => new Promise<number | 'open'>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${s.port}/worker`, { headers: { 'x-worker-token': secret } });
        ws.once('close', (code) => resolve(code));
        // the server closes a refused worker at once; one still open after a moment was let in
        ws.once('open', () => setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
            resolve('open');
          }
        }, 300));
      });
      const git = async () => (await fetch(`${s.base}/git/r${repo.id}.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${secret}` } })).status;

      // while bob is on the list, his worker attaches and reads the hosted repo
      expect(await attach()).toBe('open');
      expect(await git()).toBe(200);

      // the owner takes bob off the list
      s.ctx.cfg.authUsers = ['alice'];
      expect(await attach()).toBe(4001);
      expect(await git()).toBe(401);
      expect(() => s.ctx.scheduler.run(sched.id)).toThrow(/no longer use this install/);
      expect(s.ctx.store.schedule(sched.id)!.last_error).toMatch(/bob/);
      expect(s.ctx.store.sessions({ kind: 'planner' })).toHaveLength(0);
    } finally {
      await s.app.close();
    }
  });
});
