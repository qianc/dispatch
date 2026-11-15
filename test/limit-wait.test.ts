// DISP-108: a session that stopped on its usage limit waits (it is not done), auto-merge needs a
// clean turn end, and a new batch on its items marks it interrupted.
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Session } from '../src/shared/types.ts';
import { limitWaitText } from '../src/shared/attention.ts';
import { busyStatus } from '../web/src/activity.ts';
import { OWNER, startServer, waitFor } from './helpers.ts';
import { fakeGithub } from './github.ts';

const RESET = '2026-11-15T20:30:00.000Z';

/** A running work session with auto-merge and an open PR whose checks passed. */
async function setup() {
  const s = await startServer();
  await s.call('POST', '/projects', { key: 'AM', name: 'AM' });
  await s.call('POST', '/projects/AM/repos', { github_owner: 'me', github_name: 'r' });
  const item = (await s.call('POST', '/projects/AM/items', { title: 'x' })).data;
  const worker = s.ctx.store.defaultWorkerId();
  const session = s.ctx.store.createSession({ started_by: OWNER, worker_id: worker,
    project_id: item.project_id, kind: 'work', title: 't', status: 'running', force_plan: false, branch: 'dispatch/am-1-x',
    initial_prompt: '', source_id: null, item_ids: [item.id], options: { ...DEFAULT_RUN_OPTIONS, auto_merge: 'github' },
  });
  s.ctx.store.updateItem(item.id, { status: 'in_progress' });
  let merged = false;
  const merges: unknown[] = [];
  const pr = () => ({ number: 7, html_url: 'u', title: 'PR', state: merged ? 'closed' : 'open', merged_at: merged ? 'now' : null, mergeable: true, mergeable_state: 'clean', head: { ref: 'dispatch/am-1-x', sha: 'abc' }, base: { ref: 'main' }, body: '' });
  fakeGithub(s.ctx, {
    pulls: { list: async () => ({ data: [pr()] }), get: async () => ({ data: pr() }), merge: async (args: unknown) => { merges.push(args); merged = true; return { data: {} }; } },
    checks: { listForRef: async () => ({ data: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', html_url: null }] } }) },
    repos: { compareCommits: async () => ({ data: { behind_by: 0 } }) },
  });
  const status = (st: 'idle' | 'running', extra: { limit?: { resets_at: string | null }; unclean?: string } = {}) =>
    s.ctx.sessions.onWorkerMessage(worker, { t: 'status', session_id: session.id, status: st, ...extra });
  const get = async () => (await s.call('GET', `/sessions/${session.id}`)).data as { session: Session; events: { body: { kind: string; text?: string } }[] };
  const texts = async () => (await get()).events.flatMap((e) => (e.body.text ? [e.body.text] : []));
  return { s, session, item, merges, status, get, texts };
}

describe('a session at its usage limit', () => {
  it('waits: it is not done, nobody is told it waits for them, and auto-merge does not run', async () => {
    const { s, session, merges, status, get } = await setup();
    status('running', { limit: { resets_at: RESET } });
    const waiting = (await get()).session;
    expect(waiting).toMatchObject({ status: 'running', limit_wait: { resets_at: RESET }, waiting_reason: 'Waiting for the usage limit to reset' });
    await s.ctx.github.syncSession(waiting);
    expect(merges).toHaveLength(0);
    expect(s.ctx.notifier.sent.filter((n) => /waiting for you|done and merged/.test(n.title))).toHaveLength(0);
    // the lists say what it does
    expect(busyStatus(waiting)).toEqual({ label: 'Waiting for limit', text: limitWaitText({ resets_at: RESET }) });
    expect(limitWaitText({ resets_at: null })).toMatch(/tries again/);
    // after the reset the runner goes on: the wait is over
    status('running');
    expect((await get()).session).toMatchObject({ status: 'running', limit_wait: null, waiting_reason: null });
    expect(session.id).toBe(waiting.id);
    await s.app.close();
  });

  it('auto-merges only after a clean turn end', async () => {
    const { s, merges, status, get, texts } = await setup();
    status('running', { limit: { resets_at: RESET } });
    // the wait was interrupted: the turn ended, but not cleanly
    status('idle', { unclean: 'it stopped on the usage limit, and the wait for the reset was interrupted' });
    await waitFor(async () => (await texts()).some((t) => t.includes('the last turn did not end cleanly')), 'auto-merge held back');
    expect(merges).toHaveLength(0);
    expect((await get()).session).toMatchObject({ status: 'idle', limit_wait: null, unclean: expect.stringContaining('usage limit') });
    expect(s.ctx.store.prs({ session_id: (await get()).session.id })[0].blocked).toMatch(/did not end cleanly/);
    // the owner sends it back to work and it ends cleanly: now it merges
    status('running');
    expect((await get()).session.unclean).toBeNull();
    status('idle');
    await waitFor(() => merges.length === 1, 'merged');
    expect((await texts()).filter((t) => t.startsWith('Auto-merged'))).toHaveLength(1);
    await s.app.close();
  });

  it('a new batch on its items marks it interrupted, not done', async () => {
    const { s, session, item, merges, status, get, texts } = await setup();
    status('running', { limit: { resets_at: RESET } });
    const next = (await s.call('POST', '/projects/AM/batches', { item_ids: [item.id], prompt: '' })).data as Session;
    expect(next.id).not.toBe(session.id);
    expect((await get()).session).toMatchObject({ status: 'stopped', limit_wait: null });
    expect((await texts()).some((t) => t.startsWith('Interrupted:') && t.includes(`session #${next.id}`))).toBe(true);
    // the item is the new session's now, and the old branch is not merged
    expect((await s.call('GET', `/items/${item.id}`)).data.status).toBe('in_progress');
    await s.ctx.github.syncSession((await get()).session);
    expect(merges).toHaveLength(0);
    await s.app.close();
  });

  it('a session that works is not abandoned by a new batch on its items', async () => {
    const { s, item, get } = await setup();
    await s.call('POST', '/projects/AM/batches', { item_ids: [item.id], prompt: '' });
    expect((await get()).session.status).toBe('running');
    await s.app.close();
  });
});
