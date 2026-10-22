import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { latestSlot, Scheduler } from '../src/server/scheduler.ts';
import { plannerPrompt } from '../src/worker/prompts.ts';
import { startServer } from './helpers.ts';

// DISP-13: a schedule runs a planner on its project, which starts the work it picks by itself.
describe('scheduled planner runs', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let pushes: string[];
  beforeEach(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'SC', name: 'Sched' });
    await s.call('POST', '/projects/SC/repos', { github_owner: 'me', github_name: 'sc' });
    pushes = [];
    s.ctx.notifier.send = async (n) => void pushes.push(n.title);
  });
  afterEach(() => s.app.close());

  const item = async (title: string, status = 'backlog') => (await s.call('POST', '/projects/SC/items', { title, status })).data as { id: number; key: string };
  const schedule = async (body: Record<string, unknown> = {}) =>
    (await s.call('POST', '/projects/SC/schedules', { name: 'Nightly', at_time: '02:00', scope_md: 'Only bugs in the ui module.', ...body })).data;
  const run = async (id: number) => (await s.call('POST', `/schedules/${id}/run`)).data as { id: number; kind: string; schedule_id: number; title: string };
  const idle = (sessionId: number) => s.ctx.sessions.onWorkerMessage(s.ctx.store.session(sessionId)!.worker_id!, { t: 'status', session_id: sessionId, status: 'idle' });

  it('creates, lists, edits and deletes schedules', async () => {
    const made = await schedule({ days: [1, 3, 1], options: { auto_merge: 'github' } });
    expect(made).toMatchObject({ name: 'Nightly', at_time: '02:00', days: [1, 3], max_batches: 1, enabled: true, options: { auto_merge: 'github' } });
    expect((await s.call('POST', '/projects/SC/schedules', { name: 'x', at_time: '25:00' })).status).toBe(400);
    const list = (await s.call('GET', '/projects/SC/schedules')).data;
    expect(list).toHaveLength(1);
    expect(list[0].next_run).toBeTruthy();
    expect((await s.call('PATCH', `/schedules/${made.id}`, { enabled: false, max_batches: 2 })).data).toMatchObject({ enabled: false, max_batches: 2, name: 'Nightly' });
    expect((await s.call('DELETE', `/schedules/${made.id}`)).status).toBe(200);
    expect((await s.call('GET', '/projects/SC/schedules')).data).toHaveLength(0);
  });

  it('a run is a planner session with the scope in its instructions; it cannot ask questions', async () => {
    const sc = await schedule({ max_batches: 2 });
    const p = await run(sc.id);
    expect(p).toMatchObject({ kind: 'planner', schedule_id: sc.id, title: 'Scheduled: Nightly' });
    const spec = s.ctx.sessions.spec(s.ctx.store.session(p.id)!, '', null, null);
    expect(spec.schedule).toEqual({ name: 'Nightly', scope_md: 'Only bugs in the ui module.', max_batches: 2 });
    const text = plannerPrompt(spec);
    expect(text).toContain('Only bugs in the ui module.');
    expect(text).toMatch(/Nobody is watching/);
    expect(text).toMatch(/at most 2 batches/);
    expect(text).not.toContain('propose_items');
    const list = (await s.call('GET', '/projects/SC/schedules')).data;
    expect(list[0].last_session).toMatchObject({ id: p.id, status: 'queued' });
    // a second run while this one is still open is refused
    const again = await s.call('POST', `/schedules/${sc.id}/run`);
    expect(again.status).toBe(409);
  });

  it('propose_batch starts the batch at once with the schedule options, leaving out held items', async () => {
    const sc = await schedule({ options: { auto_merge: 'github', start: 'after', model: 'sonnet' } });
    const open = await item('Open bug');
    const triage = await item('New bug', 'triage');
    const held = await item('On hold', 'hold');
    const p = await run(sc.id);
    const reply = String(await s.ctx.sessions.rpc(p.id, 'propose', { type: 'batch', title: 'UI bugs', item_ids: [open.id, triage.id, held.id], prompt: '' }));
    expect(reply).toMatch(/^Started session #\d+/);
    expect(reply).toContain(`left out ${held.key}`);
    const work = s.ctx.store.sessions({ kind: 'work' })[0];
    expect(work.item_ids.sort()).toEqual([open.id, triage.id].sort());
    expect(work.options).toMatchObject({ auto_merge: 'github', start: 'after', model: 'sonnet' });
    expect(s.ctx.store.item(held.id)!.status).toBe('hold');
    // the cap: one batch per run
    const second = String(await s.ctx.sessions.rpc(p.id, 'propose', { type: 'batch', title: 'More', item_ids: [], prompt: 'something else' }));
    expect(second).toMatch(/Not started: this run may start at most 1 batch/);
    expect(s.ctx.store.sessions({ kind: 'work' })).toHaveLength(1);
  });

  it('refuses a batch of only held or busy items', async () => {
    const sc = await schedule();
    const held = await item('On hold', 'hold');
    const review = await item('In review', 'in_review');
    const p = await run(sc.id);
    const reply = String(await s.ctx.sessions.rpc(p.id, 'propose', { type: 'batch', title: 'x', item_ids: [held.id, review.id], prompt: 'go' }));
    expect(reply).toMatch(/^Not started: nothing left to start/);
    expect(s.ctx.store.sessions({ kind: 'work' })).toHaveLength(0);
  });

  it('update_item triages items, but never lifts a hold or closes an item', async () => {
    const sc = await schedule();
    const t = await item('Untriaged', 'triage');
    const held = await item('On hold', 'hold');
    const p = await run(sc.id);
    await s.ctx.sessions.rpc(p.id, 'update_item', { key: t.key, status: 'todo', importance: 3, tags: ['ui'], comment: 'Triaged: a UI bug.' });
    expect(s.ctx.store.item(t.id)).toMatchObject({ status: 'todo', importance: 3, labels: ['ui'] });
    expect(s.ctx.store.comments(t.id).at(-1)).toMatchObject({ author: 'claude', body_md: 'Triaged: a UI bug.' });
    await expect(s.ctx.sessions.rpc(p.id, 'update_item', { key: held.key, status: 'todo' })).rejects.toThrow(/on hold/);
    await expect(s.ctx.sessions.rpc(p.id, 'update_item', { key: t.key, status: 'done' })).rejects.toThrow(/cannot set/);
    // only a scheduled planner has it
    const manual = (await s.call('POST', '/projects/SC/planner', { prompt: 'next?' })).data;
    await expect(s.ctx.sessions.rpc(manual.id, 'update_item', { key: t.key, status: 'backlog' })).rejects.toThrow(/scheduled/);
  });

  it('ends at the end of its turn, with no push of its own', async () => {
    const sc = await schedule();
    const p = await run(sc.id);
    s.ctx.store.updateSession(p.id, { status: 'running' });
    s.ctx.sessions.onWorkerMessage(s.ctx.store.session(p.id)!.worker_id!, { t: 'event', session_id: p.id, body: { kind: 'assistant', text: 'Nothing fits the scope tonight.' } });
    idle(p.id);
    expect(s.ctx.store.session(p.id)).toMatchObject({ status: 'completed', last_text: 'Nothing fits the scope tonight.' });
    expect(pushes).toEqual([]);
    // the next run may start now
    expect((await s.call('POST', `/schedules/${sc.id}/run`)).status).toBe(200);
  });

  it('the scheduler runs each due slot once and keeps a failure on the schedule', async () => {
    const sc = await schedule({ at_time: '02:00' });
    const sched = new Scheduler(s.ctx.store, s.ctx.sessions, s.ctx.bus);
    const today = new Date();
    const slot = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 2, 0);
    // a new schedule waits for its next slot
    expect(s.ctx.store.schedule(sc.id)!.last_slot).toBe(latestSlot(sc, today)!.toISOString());
    s.ctx.store.updateSchedule(sc.id, { last_slot: null });
    sched.tick(new Date(slot.getTime() + 60_000));
    sched.tick(new Date(slot.getTime() + 120_000));
    expect(s.ctx.store.sessions({ kind: 'planner' })).toHaveLength(1);
    // no repo: the run fails, and the schedule says why
    await s.call('POST', '/projects', { key: 'NR', name: 'No repo' });
    const bad = (await s.call('POST', '/projects/NR/schedules', { name: 'x', at_time: '02:00' })).data;
    s.ctx.store.updateSchedule(bad.id, { last_slot: null });
    sched.tick(new Date(slot.getTime() + 60_000));
    expect(s.ctx.store.schedule(bad.id)!.last_error).toMatch(/Add a repo/);
  });
});
