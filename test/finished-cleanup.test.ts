// DISP-228: "Delete worktree from disk" on a session that already ended only tidies it up:
// its status stays, and items that another session has now are left alone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer } from './helpers.ts';

describe('cleanup of an ended session (DISP-228)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let tidied: { id: number; removeAll: boolean }[];
  beforeEach(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'FC', name: 'Cleanup' });
    await s.call('POST', '/projects/FC/repos', { github_owner: 'me', github_name: 'fc' });
    tidied = [];
    vi.spyOn(s.ctx.sessions, 'onFinished').mockImplementation((x, _status, removeAll) => tidied.push({ id: x.id, removeAll }));
  });
  afterEach(() => s.app.close());

  const batch = async (itemIds: number[]) => (await s.call('POST', '/projects/FC/batches', { prompt: 'x', item_ids: itemIds })).data;

  it("on a moved session, leaves the new session's in-progress items alone", async () => {
    const item = (await s.call('POST', '/projects/FC/items', { title: 'x' })).data;
    const one = await batch([item.id]);
    s.ctx.store.updateSession(one.id, { status: 'stopped', ended_at: new Date().toISOString() }); // moved: #2 has its items
    const two = await batch([item.id]);
    s.ctx.store.updateItem(item.id, { status: 'in_progress' });

    // what the button sends now, and what it sent before
    for (const body of [{ cleanup: true }, { status: 'stopped', cleanup: true }]) {
      const r = await s.call('POST', `/sessions/${one.id}/finish`, body);
      expect(r.status).toBe(200);
      expect(r.data.status).toBe('stopped');
    }
    expect(s.ctx.store.item(item.id)!.status).toBe('in_progress');
    expect(s.ctx.store.session(two.id)!.status).not.toBe('stopped');
    expect(tidied).toEqual([{ id: one.id, removeAll: true }, { id: one.id, removeAll: true }]);
  });

  it('works on a failed session, which stays failed', async () => {
    const one = await batch([]);
    s.ctx.store.updateSession(one.id, { status: 'failed', ended_at: new Date().toISOString() });
    const r = await s.call('POST', `/sessions/${one.id}/finish`, { cleanup: true });
    expect(r.status).toBe(200);
    expect(r.data.status).toBe('failed');
    expect(tidied).toEqual([{ id: one.id, removeAll: true }]);
  });

  it('a cleanup-only call on a session that has not ended is refused', async () => {
    const one = await batch([]);
    const r = await s.call('POST', `/sessions/${one.id}/finish`, { cleanup: true });
    expect(r.status).toBe(409);
    expect(s.ctx.store.session(one.id)!.status).not.toMatch(/completed|stopped|failed/);
    expect(tidied).toEqual([]);
  });
});
