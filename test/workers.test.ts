import { describe, expect, it } from 'vitest';
import { startServer } from './helpers.ts';

describe('worker records', () => {
  it('makes a worker with a dsw_ secret, keeps only its hash, and verifies it', async () => {
    const s = await startServer();
    try {
      const { worker, secret } = s.ctx.workers.create('desktop', 'Windows desktop in WSL.');
      expect(secret).toMatch(/^dsw_[A-Za-z0-9_-]{43}$/);
      expect(worker).toMatchObject({ name: 'desktop', description: 'Windows desktop in WSL.', revoked_at: null });
      expect(JSON.stringify(s.ctx.store.db.all('SELECT * FROM workers'))).not.toContain(secret);
      expect(s.ctx.workers.verify(secret)?.id).toBe(worker.id);
      expect(s.ctx.workers.verify('dsw_nonsense')).toBeNull();
      s.ctx.workers.revoke(worker.id);
      expect(s.ctx.workers.verify(secret)).toBeNull();
      expect(() => s.ctx.workers.create('desktop', '')).toThrow(/already/);
    } finally {
      await s.app.close();
    }
  });

  it('has one legacy worker "default" that the old WORKER_TOKEN connects as, and it is the default', async () => {
    const s = await startServer();
    try {
      const a = s.ctx.workers.legacy();
      expect(a.name).toBe('default');
      expect(s.ctx.workers.legacy().id).toBe(a.id);
      expect(s.ctx.workers.defaultId()).toBe(a.id);
      expect(s.ctx.workers.list().map((w) => w.name)).toEqual(['default']);
    } finally {
      await s.app.close();
    }
  });

  it('existing rows get the default worker and a repo kind', async () => {
    const s = await startServer();
    try {
      const p = s.ctx.store.createProject({ key: 'LR', name: 'L', description: '', default_force_plan: false, importance_scale: ['a', 'b', 'c', 'd'], effort_scale: ['S'] });
      const local = s.ctx.store.addRepo(p.id, { github_owner: 'local', github_name: 'x', default_branch: 'main', check_command: null, local_path: '/tmp/x' });
      const gh = s.ctx.store.addRepo(p.id, { github_owner: 'o', github_name: 'r', default_branch: 'main', check_command: null });
      expect(local).toMatchObject({ kind: 'local', worker_id: s.ctx.workers.defaultId() });
      expect(gh).toMatchObject({ kind: 'github', worker_id: null });
      const sess = s.ctx.store.createSession({ project_id: p.id, kind: 'work', title: 't', status: 'queued', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [] });
      expect(sess).toMatchObject({ worker_id: s.ctx.workers.defaultId(), paused: false, pending_prompt: null, moved_from: null });
      expect(s.ctx.store.project(p.id)).toMatchObject({ worker_id: null, placement_md: '' });
    } finally {
      await s.app.close();
    }
  });

  it('owner routes: list, create (secret once), describe, revoke, pick the default', async () => {
    const s = await startServer();
    try {
      const made = await s.call('POST', '/workers', { name: 'linux', description: 'Linux VM' });
      expect(made.status).toBe(200);
      expect(made.data.secret).toMatch(/^dsw_/);
      const list = await s.call('GET', '/workers');
      expect(list.data.workers.map((w: { name: string }) => w.name)).toEqual(['default', 'linux']);
      expect(JSON.stringify(list.data)).not.toContain(made.data.secret);
      expect(list.data.default_worker_id).toBe(s.ctx.workers.defaultId());
      const id = made.data.worker.id;
      expect((await s.call('PATCH', `/workers/${id}`, { description: 'Linux VM, 8 cores' })).data.worker.description).toBe('Linux VM, 8 cores');
      expect((await s.call('PUT', '/settings/default-worker', { worker_id: id })).status).toBe(200);
      expect(s.ctx.workers.defaultId()).toBe(id);
      expect((await s.call('DELETE', `/workers/${id}`)).status).toBe(200);
      // a revoked worker cannot be the default: it falls back to the legacy one
      expect(s.ctx.workers.defaultId()).toBe(s.ctx.workers.legacy().id);
      expect((await s.call('POST', '/workers', { name: 'Bad Name' })).status).toBe(400);
    } finally {
      await s.app.close();
    }
  });
});
