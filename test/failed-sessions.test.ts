import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerLink } from '../src/server/workerHub.ts';
import { startServer } from './helpers.ts';

const GH_ERROR = 'GitHub is not signed in on this worker\ngit push: Authentication failed. Run `gh auth login` on the worker.';

// DISP-81: a failed session shows in Needs you with its reason, and can be ignored, discussed or retried.
describe('failed sessions', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  /** what the server sent to the worker: [message type, session id] */
  let sent: [string, number][];
  beforeEach(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'FS', name: 'Failures' });
    await s.call('POST', '/projects/FS/repos', { github_owner: 'me', github_name: 'fs' });
    // a worker is there: sessions start
    sent = [];
    s.ctx.hub.link = () => ({ facts: null }) as unknown as WorkerLink;
    s.ctx.hub.isConnected = () => true;
    s.ctx.hub.send = (_w, m) => {
      const id = m.t === 'start' ? m.spec.session_id : 'session_id' in m ? m.session_id : 0;
      sent.push([m.t, id]);
      return true;
    };
  });
  afterEach(() => s.app.close());

  const fail = (id: number, error = GH_ERROR) => {
    const worker = s.ctx.store.session(id)!.worker_id!;
    s.ctx.sessions.onWorkerMessage(worker, { t: 'event', session_id: id, body: { kind: 'assistant', text: 'Pushing the branch now.' } } as never);
    s.ctx.sessions.onWorkerMessage(worker, { t: 'status', session_id: id, status: 'failed', error } as never);
  };
  const startBatch = async () => {
    const item = (await s.call('POST', '/projects/FS/items', { title: 'Fix the thing' })).data;
    const options = { model: 'sonnet', effort: 'high', auto_merge: 'local', turn_check: false };
    const batch = (await s.call('POST', '/projects/FS/batches', { item_ids: [item.id], prompt: 'Fix it carefully', options })).data;
    expect(s.ctx.store.session(batch.id)!.status).toBe('running');
    return { item, batch };
  };
  const failedIds = async () => ((await s.call('GET', '/inbox')).data.failed as { id: number }[]).map((x) => x.id);

  it('shows a failed session in Needs you with a short reason', async () => {
    const { batch } = await startBatch();
    expect(await failedIds()).toEqual([]);
    fail(batch.id);
    const inbox = (await s.call('GET', '/inbox')).data;
    expect(inbox.failed).toHaveLength(1);
    expect(inbox.failed[0]).toMatchObject({ id: batch.id, status: 'failed', reason: 'GitHub is not signed in on this worker' });
    expect((await s.call('GET', `/sessions/${batch.id}`)).data.failure).toEqual({ reason: 'GitHub is not signed in on this worker', retried_as: null, discussion: null });
  });

  it('Mark as ignored takes it out of Needs you, keeps it in history, and leaves the item alone', async () => {
    const { item, batch } = await startBatch();
    fail(batch.id);
    const before = (await s.call('GET', `/items/${item.id}`)).data;
    const r = await s.call('POST', `/sessions/${batch.id}/ignore`, {});
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ status: 'failed', closed_reason: 'ignored' });
    expect(r.data.closed_at).toBeTruthy();
    expect(await failedIds()).toEqual([]);
    // history: still a failed session
    expect(((await s.call('GET', '/sessions?status=completed,failed,stopped')).data as { id: number; status: string }[]).find((x) => x.id === batch.id)).toMatchObject({ status: 'failed' });
    expect((await s.call('GET', `/items/${item.id}`)).data).toMatchObject({ status: before.status });
    // shown again
    expect((await s.call('POST', `/sessions/${batch.id}/ignore`, { ignored: false })).data).toMatchObject({ closed_reason: null, closed_at: null });
    expect(await failedIds()).toEqual([batch.id]);
  });

  it('What would fix the issue? opens a discussion seeded with the error, and does not restart the session', async () => {
    const { batch } = await startBatch();
    fail(batch.id);
    sent = [];
    const r = await s.call('POST', `/sessions/${batch.id}/discuss-failure`, {});
    expect(r.status).toBe(200);
    const chat = r.data;
    expect(chat).toMatchObject({ kind: 'discuss', about_session: batch.id, project_key: 'FS', item_ids: [] });
    const events = (await s.call('GET', `/sessions/${chat.id}`)).data.events as { body: { kind: string; text?: string } }[];
    const first = events.find((e) => e.body.kind === 'user')!.body.text!;
    expect(first).toContain(`Session #${batch.id}`);
    expect(first).toContain('Authentication failed. Run `gh auth login`');
    expect(first).toContain('Pushing the branch now.');
    expect(first).toContain('Fix it carefully');
    // the failed session stays as it was: nothing was sent to the worker for it
    expect(sent.filter(([, id]) => id === batch.id)).toEqual([]);
    expect(s.ctx.store.session(batch.id)).toMatchObject({ status: 'failed', closed_reason: null });
    expect(await failedIds()).toEqual([batch.id]);
    // asking again opens the same discussion
    expect((await s.call('POST', `/sessions/${batch.id}/discuss-failure`, {})).data.id).toBe(chat.id);
    expect((await s.call('GET', `/sessions/${batch.id}`)).data.failure.discussion).toBe(chat.id);
  });

  it('I\'ve fixed it, please retry: a GitHub-login failure starts again with the same prompt, options and worker', async () => {
    const { item, batch } = await startBatch();
    fail(batch.id);
    const failed = s.ctx.store.session(batch.id)!;
    sent = [];
    const r = await s.call('POST', `/sessions/${batch.id}/retry`, {});
    expect(r.status).toBe(200);
    const next = s.ctx.store.session(r.data.id)!;
    expect(next.id).not.toBe(batch.id);
    expect(next).toMatchObject({
      kind: 'work', status: 'running', retry_of: batch.id, initial_prompt: 'Fix it carefully', title: failed.title,
      item_ids: [item.id], worker_id: failed.worker_id, claude_account: failed.claude_account, options: failed.options, started_by: failed.started_by,
    });
    expect(next.branch).toMatch(new RegExp(`^dispatch/fs-${next.id}-`));
    expect(sent).toContainEqual(['start', next.id]);
    expect(s.ctx.store.session(batch.id)).toMatchObject({ status: 'failed', closed_reason: 'retried' });
    expect((await s.call('GET', `/sessions/${batch.id}`)).data.failure.retried_as).toBe(next.id);
    expect(await failedIds()).toEqual([]);
    // only once
    expect((await s.call('POST', `/sessions/${batch.id}/retry`, {})).status).toBe(409);

    // it fails again: the new one needs you, with its own reason; the first stays in history
    fail(next.id, 'Still no GitHub login on this worker');
    const inbox = (await s.call('GET', '/inbox')).data;
    expect(inbox.failed.map((x: { id: number; reason: string }) => [x.id, x.reason])).toEqual([[next.id, 'Still no GitHub login on this worker']]);
    expect(s.ctx.store.session(batch.id)!.status).toBe('failed');
  });

  it('refuses the actions on a session that has not failed', async () => {
    const { batch } = await startBatch();
    for (const action of ['ignore', 'discuss-failure', 'retry']) {
      expect((await s.call('POST', `/sessions/${batch.id}/${action}`, {})).status, action).toBe(409);
    }
  });

  it('a closed failure that runs again comes back to Needs you if it fails again', async () => {
    const { batch } = await startBatch();
    fail(batch.id);
    await s.call('POST', `/sessions/${batch.id}/ignore`, {});
    // the owner replies in the failed session: it runs again
    expect((await s.call('POST', `/sessions/${batch.id}/messages`, { text: 'try again' })).status).toBe(200);
    expect(s.ctx.store.session(batch.id)).toMatchObject({ status: 'running', closed_reason: null });
    fail(batch.id, 'Failed once more');
    expect(await failedIds()).toEqual([batch.id]);
  });
});
