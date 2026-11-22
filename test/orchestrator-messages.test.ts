import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PendingInputPayload } from '../src/shared/types.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

const QUESTION: PendingInputPayload = { kind: 'question', questions: [{ question: 'Which?', header: 'x', multiSelect: false, options: [] }] };

// DISP-168: the orchestrator's pushes and messages say the right thing.
describe('orchestrator: pushes and messages', () => {
  let t: Setup;
  let clock: number;
  let n = 0;
  beforeEach(async () => {
    t = await setup();
    clock = Date.now();
    t.s.ctx.orchestrator.now = () => new Date(clock);
  });
  afterEach(() => t.s.app.close());

  const told = (id: number) => t.events(id).filter((e) => e.startsWith('system: (From Dispatch'));
  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  const later = (minutes: number) => { clock += minutes * 60_000; t.s.ctx.orchestrator.tick(); };
  const view = (id: number) => t.s.ctx.orchestrator.view(id);
  const spend = (id: number, usd: number) => {
    t.store.updateSession(id, { usage: { cost_usd: usd, turns: 1 } });
    t.s.ctx.bus.emit({ t: 'session', session: t.store.session(id)! });
  };
  const ask = (session: number, payload: PendingInputPayload = QUESTION) => {
    const local_id = `q${++n}`;
    t.s.ctx.sessions.onWorkerMessage(t.store.session(session)!.worker_id!, { t: 'input_request', session_id: session, local_id, payload });
    return t.store.inputs(session).find((i) => i.local_id === local_id)!;
  };
  const ready = async (extra: Record<string, unknown> = {}) => {
    const p = await t.approved(extra);
    turn(p.id);
    return p;
  };

  it('its own question is pushed with its title, not as "Assistant"', async () => {
    const p = await ready();
    t.status(p.id, 'running');
    ask(p.id);
    expect(t.pushes.map((x) => x.title)).toContain('Rework auth: question');
    expect(t.pushes.some((x) => x.title.startsWith('Assistant:'))).toBe(false);
  });

  it('paused by the owner, then past its cost limit: one cost push, and the cost reason', async () => {
    const p = await ready({ cost_limit_usd: 5 });
    const one = await t.startStep(p.id, p.first.id);
    t.status(one, 'running');
    await t.s.call('POST', `/orchestrations/${p.id}/pause`);
    expect(view(p.id)).toMatchObject({ phase: 'paused', paused_reason: null, waiting: 'Paused' });
    spend(one, 6);
    const mine = () => t.pushes.filter((x) => x.title === 'Rework auth: cost limit reached');
    expect(mine()).toHaveLength(1);
    expect(view(p.id)).toMatchObject({ phase: 'paused', paused_from: 'run', paused_reason: 'Cost limit reached: $6.00 of $5.00 used.', waiting: 'Cost limit reached: $6.00 of $5.00 used.' });
    spend(one, 7);
    expect(mine()).toHaveLength(1);
    // the limit raised: the reason goes, and it may resume
    await t.s.call('PATCH', `/orchestrations/${p.id}`, { cost_limit_usd: 10 });
    expect(view(p.id).paused_reason).toBeNull();
    expect((await t.s.call('POST', `/orchestrations/${p.id}/resume`)).status).toBe(200);
  });

  it('its own session failed: it says so, shows no next wake, and a late timer says it came late', async () => {
    const p = await ready();
    await t.rpc(p.id, 'wake_me_in', { minutes: 10, reason: 'Look at the build.' });
    const due = new Date(clock + 10 * 60_000).toISOString();
    expect(view(p.id)).toMatchObject({ waiting: 'Waits for its own timer', next_wake: due });
    t.status(p.id, 'failed');
    expect(view(p.id)).toMatchObject({ waiting: 'Its session failed: write to it to go on', next_wake: null });
    const count = told(p.id).length;
    later(15);
    later(1);
    expect(told(p.id)).toHaveLength(count);
    // the owner writes to it: its turn ends, and the timer comes with a note that it is late
    expect((await t.s.call('POST', `/sessions/${p.id}/messages`, { text: 'Go on.' })).status).toBe(200);
    turn(p.id);
    expect(told(p.id)).toHaveLength(count + 1);
    expect(told(p.id).at(-1)).toContain(`- Your timer: Look at the build. (came due at ${due.slice(11, 16)} UTC while the session was failed)`);
    expect(told(p.id).at(-1)!.match(/came due at/g)).toHaveLength(1);
  });

  it('answer_session while paused, while it plans, or when closed says why', async () => {
    const p = await ready();
    const child = await t.startStep(p.id, p.first.id);
    t.status(child, 'running');
    turn(p.id);
    const input = ask(child);
    expect(t.store.input(input.id)!.delegated_to).toBe(p.id);
    await t.s.call('POST', `/orchestrations/${p.id}/pause`);
    await expect(t.rpc(p.id, 'answer_session', { input_id: input.id, answer: 'Small' })).rejects.toThrow("The orchestration is paused: its batches' questions are the owner's until they resume it.");
    await t.s.call('POST', `/orchestrations/${p.id}/stop`);
    await expect(t.rpc(p.id, 'answer_session', { input_id: input.id, answer: 'Small' })).rejects.toThrow('This orchestration is closed.');
  });
});
