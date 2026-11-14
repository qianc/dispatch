import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Orchestration } from '../src/shared/types.ts';
import { parseLimit } from '../web/src/orchestration.ts';
import { OWNER } from './helpers.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

// Cases the review of part 3 found.
describe('orchestrator part 3: review findings', () => {
  let t: Setup;
  let clock: number;
  beforeEach(async () => {
    t = await setup();
    clock = Date.now();
    t.s.ctx.orchestrator.now = () => new Date(clock);
  });
  afterEach(() => t.s.app.close());

  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  const view = (id: number) => t.s.ctx.orchestrator.view(id);
  const patch = (id: number, body: unknown) => t.s.call<Orchestration & { error?: string }>('PATCH', `/orchestrations/${id}`, body);
  const spend = (id: number, usd: number) => {
    t.store.updateSession(id, { usage: { cost_usd: usd, turns: 1 } });
    t.s.ctx.bus.emit({ t: 'session', session: t.store.session(id)! });
  };
  const ready = async (extra: Record<string, unknown> = {}) => {
    const p = await t.approved(extra);
    turn(p.id);
    return p;
  };
  const told = (id: number) => t.events(id).filter((e) => e.startsWith('system: (From Dispatch'));

  it('a timer does not hide a step that waits for the owner\'s review', async () => {
    const p = await ready();
    const child = await t.startStep(p.id, p.first.id);
    turn(child);
    t.pr(child, 'open');
    turn(p.id);
    expect(t.s.ctx.orchestrator.attention(p.id)).toEqual({ kind: 'plan', text: 'Step 1 waits for your review' });
    await t.rpc(p.id, 'wake_me_in', { minutes: 60, reason: 'See whether it was reviewed.' });
    expect(t.s.ctx.orchestrator.attention(p.id)).toEqual({ kind: 'plan', text: 'Step 1 waits for your review' });
  });

  it('while it plans, a timer does not stand in for a question to the owner', async () => {
    const id = t.start().session_id;
    t.status(id, 'running');
    await t.rpc(id, 'wake_me_in', { minutes: 60, reason: 'Later.' });
    t.status(id, 'idle');
    expect(t.pushes.map((x) => x.title)).toEqual(['Rework auth: waiting for you']);
    expect(t.s.ctx.orchestrator.attention(id)).toEqual({ kind: 'plan', text: 'It waits for your reply before it can plan.' });
  });

  it('timer after timer with nothing else happening stops after a while, and the owner is told', async () => {
    const p = await ready();
    t.pushes.length = 0; // its turn after the approval started nothing: that push is not this test's
    for (let i = 0; i < 12; i++) {
      t.status(p.id, 'running');
      await t.rpc(p.id, 'wake_me_in', { minutes: 5, reason: 'Again.' });
      t.status(p.id, 'idle');
      clock += 5 * 60_000;
      t.s.ctx.orchestrator.tick();
    }
    expect(t.pushes.filter((x) => x.title === 'Rework auth: waiting for you')).toEqual([]);
    t.status(p.id, 'running');
    await expect(t.rpc(p.id, 'wake_me_in', { minutes: 5, reason: 'Again.' })).rejects.toThrow('You set 12 timers in a row and nothing else happened: tell the owner what you wait for instead.');
    t.status(p.id, 'idle');
    expect(t.pushes.filter((x) => x.title === 'Rework auth: waiting for you')).toHaveLength(1);
    // something else happened (a step started): it may set timers again
    await t.rpc(p.id, 'start_step', { step_id: p.first.id });
    await t.rpc(p.id, 'wake_me_in', { minutes: 5, reason: 'Again.' });
  });

  it('a closed orchestration has no timers left, and shows none', async () => {
    const p = await ready();
    await t.rpc(p.id, 'wake_me_in', { minutes: 60, reason: 'Later.' });
    expect(view(p.id).next_wake).not.toBeNull();
    await t.s.call('POST', `/orchestrations/${p.id}/pause`);
    expect(view(p.id).next_wake).toBeNull(); // kept, but it does not wake while paused
    expect(t.store.waitingTimers(p.id, new Date(clock).toISOString())).toHaveLength(1);
    await t.s.call('POST', `/orchestrations/${p.id}/stop`);
    expect(view(p.id).next_wake).toBeNull();
    expect(t.store.waitingTimers(p.id, new Date(clock).toISOString())).toEqual([]);
    clock += 120 * 60_000;
    expect(t.store.dueOrchestrations(new Date(clock).toISOString())).toEqual([]);
    // finishing drops them too
    const q = await ready();
    await t.rpc(q.id, 'wake_me_in', { minutes: 60, reason: 'Later.' });
    for (const st of [q.first, q.second, q.third]) t.store.updateStep(st.id, { state: 'done' });
    await t.rpc(q.id, 'finish', { result: 'Done.' });
    expect(t.store.waitingTimers(q.id, new Date(clock - 120 * 60_000).toISOString())).toEqual([]);
  });

  it('a batch retried from its page still counts to the cost when its step moved on', async () => {
    const p = await ready();
    const child = await t.startStep(p.id, p.first.id);
    t.status(child, 'running');
    t.status(child, 'failed');
    await t.s.call('POST', `/orchestration-steps/${p.first.id}/skip`);
    const retry = (await t.s.call<{ id: number }>('POST', `/sessions/${child}/retry`)).data;
    expect(t.store.session(retry.id)!.orchestrator_id).toBe(p.id);
    spend(retry.id, 40);
    expect(view(p.id).cost_usd).toBe(40);
    expect(t.store.step(p.first.id)!.state).toBe('skipped');
  });

  it('only an open orchestration card of the chat starts one from a card', async () => {
    const chat = t.s.ctx.sessions.assistantSend(OWNER, 'hi').id;
    await t.rpc(chat, 'propose_session', { type: 'planner', project_key: 'AA', prompt: 'plan' });
    const planner = t.store.events(chat).find((e) => e.body.kind === 'proposal')!;
    const user = t.store.events(chat).find((e) => e.body.kind === 'user')!;
    const start = (event_id: number, session_id = chat) => t.s.call<{ error?: string }>('POST', '/orchestrations', { goal: 'x', project_keys: ['AA'], proposal: { session_id, event_id } });
    for (const res of [await start(planner.id), await start(user.id), await start(99999), await start(1, 99999)]) {
      expect(res.status).toBe(400);
      expect(res.data.error).toBe('That is not an orchestration card of this chat.');
    }
    expect(t.store.orchestrations()).toEqual([]);
    expect(t.store.events(chat).filter((e) => e.body.kind === 'proposal_done')).toEqual([]);
  });

  it('settings: the same projects in another order change nothing; a limit that pauses it does not wake it first', async () => {
    const p = await ready();
    const lines = t.events(p.id).length;
    expect((await patch(p.id, { project_keys: ['BB', 'AA'] })).data.project_keys).toEqual(['AA', 'BB']);
    expect(t.events(p.id)).toHaveLength(lines);
    spend(p.id, 8);
    const count = told(p.id).length;
    expect((await patch(p.id, { max_children: 3, cost_limit_usd: 5 })).data.phase).toBe('paused');
    expect(told(p.id)).toHaveLength(count);
    // raised over what is spent: the reason is gone, it stays paused until Resume, which then tells it
    expect((await patch(p.id, { cost_limit_usd: 20 })).data).toMatchObject({ phase: 'paused', paused_reason: null, waiting: 'Paused' });
    await t.s.call('POST', `/orchestrations/${p.id}/resume`);
    expect(told(p.id).at(-1)).toContain('at most 3 batches at once');
  });

  it('the limit is met to the cent', async () => {
    const p = await ready({ cost_limit_usd: 5 });
    spend(p.id, 4.994);
    expect(view(p.id).phase).toBe('run');
    spend(p.id, 4.996);
    expect(view(p.id)).toMatchObject({ phase: 'paused', paused_reason: 'Cost limit reached: $5.00 of $5.00 used.' });
  });

  it('a cost limit is typed as a plain amount', () => {
    expect(parseLimit('')).toBeNull();
    expect(parseLimit(' 20 ')).toBe(20);
    expect(parseLimit('12,50')).toBe(12.5);
    expect(parseLimit('12.5')).toBe(12.5);
    for (const bad of ['1,000', '1.000,00', '0', '-3', 'ten', '10001', '5.123']) expect(parseLimit(bad), bad).toBeUndefined();
  });
});
