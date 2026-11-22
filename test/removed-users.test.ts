// DISP-132: a person taken off AUTH_USERS loses every way in, not only the proxy's user header:
// their paired devices, their dsp_ tokens and their Claude connectors are refused too; and (DISP-173)
// their workers' dsw_ tokens and their schedules.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import { startMultiUser } from './helpers.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('a user removed from AUTH_USERS', () => {
  it('loses their device cookie, API tokens and OAuth access tokens', async () => {
    const s = await startMultiUser();
    try {
      // bob's phone, paired
      const { pair_id, code } = s.ctx.devices.start('iPhone', '127.0.0.1')!;
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

describe('sessions started by a user later removed from AUTH_USERS (DISP-195)', () => {
  const setup = async () => {
    const s = await startMultiUser();
    const p = s.ctx.store.createProject({ key: 'RS', name: 'Removed sessions', description: '', default_force_plan: false, importance_scale: ['a', 'b', 'c', 'd'], effort_scale: ['S'] });
    const { worker } = s.ctx.workers.create('bobs-laptop', '', 'bob');
    const session = (status: 'queued' | 'idle' | 'running') => s.ctx.store.createSession({
      project_id: p.id, kind: 'work', title: `bob ${status}`, status, force_plan: false, branch: null, initial_prompt: 'go',
      source_id: null, item_ids: [], worker_id: worker.id, started_by: 'bob',
    });
    return { s, session, worker };
  };

  /** bob's session that waits for the usage limit to reset (DISP-108), with what is sent to its worker. */
  const limitWaiting = async () => {
    const { s, session, worker } = await setup();
    const w = session('running');
    s.ctx.store.updateSession(w.id, { limit_wait: { resets_at: '2026-11-15T20:30:00.000Z' }, waiting_reason: 'Waiting for the usage limit to reset' });
    const sent: { t: string; session_id?: number }[] = [];
    vi.spyOn(s.ctx.hub, 'send').mockImplementation((_id, msg) => {
      sent.push(msg as { t: string; session_id?: number });
      return true;
    });
    const closed = () => sent.some((m) => m.t === 'close' && m.session_id === w.id);
    const errors = () => s.ctx.store.events(w.id).filter((e) => e.body.kind === 'error').map((e) => (e.body as { text: string }).text).join();
    return { s, w, worker, closed, errors };
  };

  it('a queued one fails with the reason instead of starting', async () => {
    const { s, session } = await setup();
    try {
      const q = session('queued');
      s.ctx.cfg.authUsers = ['alice'];
      s.ctx.sessions.dispatch();
      const after = s.ctx.store.session(q.id)!;
      expect(after.status).toBe('failed');
      const errors = s.ctx.store.events(q.id).filter((e) => e.body.kind === 'error');
      expect(errors.map((e) => (e.body as { text: string }).text).join()).toMatch(/bob may no longer use this install/);
    } finally {
      await s.app.close();
    }
  });

  it('an idle one does not resume on a new message', async () => {
    const { s, session } = await setup();
    try {
      const idle = session('idle');
      s.ctx.cfg.authUsers = ['alice'];
      expect(() => s.ctx.sessions.send(idle.id, 'carry on')).toThrow(/bob may no longer use this install/);
      expect(s.ctx.store.session(idle.id)!.status).toBe('idle');
      expect(() => s.ctx.sessions.sendFromDispatch(idle.id, 'carry on')).toThrow(/no longer use this install/);
      expect(s.ctx.store.session(idle.id)!.status).toBe('idle');
    } finally {
      await s.app.close();
    }
  });

  it('one that waits for the usage limit does not resume after the reset (DISP-208)', async () => {
    const { s, w, worker, closed, errors } = await limitWaiting();
    try {
      s.ctx.cfg.authUsers = ['alice'];
      // the limit resets and the runner reports it goes on: refused, and the runner is closed
      s.ctx.sessions.onWorkerMessage(worker.id, { t: 'status', session_id: w.id, status: 'running' });
      expect(s.ctx.store.session(w.id)!.status).toBe('stopped');
      expect(closed()).toBe(true);
      expect(errors()).toMatch(/bob may no longer use this install/);
    } finally {
      await s.app.close();
    }
  });

  it('one that waits for the usage limit is closed when its worker says hello, not at the reset (DISP-208)', async () => {
    const { s, w, worker, closed } = await limitWaiting();
    try {
      s.ctx.cfg.authUsers = ['alice'];
      // the server restarted with the new list: the worker connects and still has the waiting runner
      s.ctx.sessions.onWorkerHello(worker.id, [w.id]);
      expect(s.ctx.store.session(w.id)!.status).toBe('stopped');
      expect(closed()).toBe(true);
    } finally {
      await s.app.close();
    }
  });

  it('one that hits the usage limit after its starter was removed stops at once (DISP-208)', async () => {
    const { s, w, worker, closed } = await limitWaiting();
    try {
      s.ctx.store.updateSession(w.id, { limit_wait: null, waiting_reason: null });
      s.ctx.cfg.authUsers = ['alice'];
      s.ctx.sessions.onWorkerMessage(worker.id, { t: 'status', session_id: w.id, status: 'running', limit: { resets_at: null } });
      expect(s.ctx.store.session(w.id)!.status).toBe('stopped');
      expect(closed()).toBe(true);
    } finally {
      await s.app.close();
    }
  });

  it('one that waits for the usage limit goes on while its starter is on the list', async () => {
    const { s, w, worker, closed } = await limitWaiting();
    try {
      s.ctx.sessions.onWorkerHello(worker.id, [w.id]);
      s.ctx.sessions.onWorkerMessage(worker.id, { t: 'status', session_id: w.id, status: 'running' });
      expect(s.ctx.store.session(w.id)).toMatchObject({ status: 'running', limit_wait: null });
      expect(closed()).toBe(false);
    } finally {
      await s.app.close();
    }
  });

  it('runs as before while the starter is still on the list', async () => {
    const { s, session } = await setup();
    try {
      const q = session('queued');
      s.ctx.sessions.dispatch();
      expect(s.ctx.store.session(q.id)!.status).toBe('queued');
      expect(s.ctx.store.session(q.id)!.waiting_reason).toMatch(/Waiting for worker/);
    } finally {
      await s.app.close();
    }
  });
});
