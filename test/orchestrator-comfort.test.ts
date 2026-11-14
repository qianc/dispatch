import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/server/orchestrator.ts';
import type { Orchestration } from '../src/shared/types.ts';
import { as, startMultiUser } from './helpers.ts';
import { projects, setup, type Setup } from './orchestrator-helpers.ts';

// Part 3: the orchestrator wakes itself later, stops at a cost limit, and the owner changes its
// limits and scope while it runs.
describe('orchestrator: timers, cost and settings', () => {
  let t: Setup;
  let clock: number;
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
  const patch = (id: number, body: unknown, headers: Record<string, string> = {}) => t.s.call<Orchestration & { error?: string }>('PATCH', `/orchestrations/${id}`, body, headers);
  /** a session's cost so far, as its worker reports it at a turn end */
  const spend = (id: number, usd: number) => {
    t.store.updateSession(id, { usage: { cost_usd: usd, turns: 1 } });
    t.s.ctx.bus.emit({ t: 'session', session: t.store.session(id)! });
  };
  const ready = async (extra: Record<string, unknown> = {}) => {
    const p = await t.approved(extra);
    turn(p.id);
    return p;
  };

  describe('timers', () => {
    it('wake_me_in queues a wake-up that comes when it is due', async () => {
      const p = await ready();
      t.status(p.id, 'running');
      const reply = String(await t.rpc(p.id, 'wake_me_in', { minutes: 30, reason: 'Look whether the nightly build passed.' }));
      expect(reply).toMatch(/^Dispatch wakes you in 30 minutes \(at \d{4}-\d\d-\d\dT/);
      const before = t.pushes.length;
      t.status(p.id, 'idle');
      expect(t.pushes.slice(before)).toEqual([]); // it chose to wait: nothing for the owner
      expect(view(p.id)).toMatchObject({ waiting: 'Waits for its own timer', next_wake: new Date(clock + 30 * 60_000).toISOString() });
      expect(t.s.ctx.orchestrator.attention(p.id)).toBeNull();
      const count = told(p.id).length;
      later(29);
      expect(told(p.id)).toHaveLength(count);
      later(1);
      expect(told(p.id)).toHaveLength(count + 1);
      expect(told(p.id).at(-1)).toContain('- Your timer: Look whether the nightly build passed.');
      expect(view(p.id).next_wake).toBeNull();
      later(60);
      expect(told(p.id)).toHaveLength(count + 1);
    });

    it('a timer is refused when too short, too long, or the fourth', async () => {
      const p = await ready();
      await expect(t.rpc(p.id, 'wake_me_in', { minutes: 0, reason: 'x' })).rejects.toThrow('A timer is between 5 minutes and 7 days (10080 minutes).');
      await expect(t.rpc(p.id, 'wake_me_in', { minutes: 525_600, reason: 'x' })).rejects.toThrow(/between 5 minutes and 7 days/);
      await expect(t.rpc(p.id, 'wake_me_in', { minutes: 30, reason: ' ' })).rejects.toThrow('Say what the timer is for.');
      for (const m of [10, 20, 30]) await t.rpc(p.id, 'wake_me_in', { minutes: m, reason: `timer ${m}` });
      await expect(t.rpc(p.id, 'wake_me_in', { minutes: 40, reason: 'x' })).rejects.toThrow('3 timers wait already: that is the most.');
      later(10); // one came due: room for another
      await t.rpc(p.id, 'wake_me_in', { minutes: 40, reason: 'x' });
    });

    it('a timer that comes due while it works, or while it is paused, is delivered once afterwards', async () => {
      const p = await ready();
      await t.rpc(p.id, 'wake_me_in', { minutes: 10, reason: 'First.' });
      t.status(p.id, 'running');
      const count = told(p.id).length;
      later(15);
      expect(told(p.id)).toHaveLength(count);
      t.status(p.id, 'idle');
      expect(told(p.id).at(-1)).toContain('- Your timer: First.');
      turn(p.id);
      await t.rpc(p.id, 'wake_me_in', { minutes: 10, reason: 'Second.' });
      await t.s.call('POST', `/orchestrations/${p.id}/pause`);
      const paused = told(p.id).length;
      later(15);
      expect(told(p.id)).toHaveLength(paused);
      await t.s.call('POST', `/orchestrations/${p.id}/resume`);
      expect(told(p.id)).toHaveLength(paused + 1);
      expect(told(p.id).at(-1)).toContain('- Your timer: Second.');
      later(15);
      expect(told(p.id)).toHaveLength(paused + 1);
    });

    it('a restart delivers a timer that came due meanwhile, once', async () => {
      const p = await ready();
      await t.rpc(p.id, 'wake_me_in', { minutes: 10, reason: 'After the restart.' });
      t.s.ctx.orchestrator.stop();
      clock += 60 * 60_000;
      const count = told(p.id).length;
      const again = new Orchestrator({ store: t.store, bus: t.s.ctx.bus, sessions: t.s.ctx.sessions, notifier: t.s.ctx.notifier });
      again.now = () => new Date(clock);
      again.resume();
      again.resume();
      again.stop();
      expect(told(p.id)).toHaveLength(count + 1);
      expect(told(p.id).at(-1)).toContain('- Your timer: After the restart.');
    });

    it('a closed or unapproved-and-stopped orchestration sets no timer', async () => {
      const p = await ready();
      await t.s.call('POST', `/orchestrations/${p.id}/stop`);
      await expect(t.rpc(p.id, 'wake_me_in', { minutes: 30, reason: 'x' })).rejects.toThrow('The orchestration is stopped.');
    });
  });

  describe('cost limit', () => {
    it("the cost of an orchestration is its own and its batches'", async () => {
      const p = await ready();
      expect(view(p.id)).toMatchObject({ cost_usd: 0, cost_limit_usd: null });
      const one = await t.startStep(p.id, p.first.id);
      const three = await t.startStep(p.id, p.third.id);
      spend(p.id, 1.25);
      spend(one, 2);
      spend(three, 0.5);
      expect(view(p.id).cost_usd).toBeCloseTo(3.75);
      // a batch that is not its own does not count
      const other = (await t.s.call<{ id: number }>('POST', '/projects/AA/batches', { item_ids: [], new_items: [], prompt: 'x' })).data;
      spend(other.id, 50);
      expect(view(p.id).cost_usd).toBeCloseTo(3.75);
    });

    it('at the limit it pauses once, starts nothing new, and a batch that finishes still closes its step', async () => {
      const p = await ready({ cost_limit_usd: 5 });
      const one = await t.startStep(p.id, p.first.id);
      t.status(one, 'running');
      spend(one, 4.99);
      expect(view(p.id).phase).toBe('run');
      spend(p.id, 0.02);
      const o = view(p.id);
      expect(o).toMatchObject({ phase: 'paused', paused_from: 'run', paused_reason: 'Cost limit reached: $5.01 of $5.00 used.', waiting: 'Cost limit reached: $5.01 of $5.00 used.' });
      const mine = () => t.pushes.filter((x) => x.title === 'Rework auth: cost limit reached');
      expect(mine()).toEqual([expect.objectContaining({ body: '$5.01 of $5.00 used. Running sessions go on; no new step starts. Raise the limit to go on.', url: `/s/${p.id}` })]);
      spend(one, 6);
      expect(mine()).toHaveLength(1);
      expect(t.store.session(one)!.status).toBe('running'); // nothing is interrupted
      await expect(t.rpc(p.id, 'start_step', { step_id: p.third.id })).rejects.toThrow('The orchestration is paused.');
      t.status(one, 'idle');
      t.pr(one, 'merged');
      expect(t.store.step(p.first.id)!.state).toBe('done');
    });

    it('resume is refused until the limit is raised', async () => {
      const p = await ready({ cost_limit_usd: 5 });
      spend(p.id, 6);
      const res = await t.s.call<{ error: string }>('POST', `/orchestrations/${p.id}/resume`);
      expect(res.status).toBe(409);
      expect(res.data.error).toBe('It has used $6.00 of its $5.00 limit: raise the limit first.');
      expect((await patch(p.id, { cost_limit_usd: 10 })).data).toMatchObject({ cost_limit_usd: 10, phase: 'paused' });
      expect((await t.s.call<Orchestration>('POST', `/orchestrations/${p.id}/resume`)).data).toMatchObject({ phase: 'run', paused_reason: null });
      // no limit at all works too
      spend(p.id, 11);
      expect(view(p.id).phase).toBe('paused');
      await patch(p.id, { cost_limit_usd: null });
      expect((await t.s.call<Orchestration>('POST', `/orchestrations/${p.id}/resume`)).data.phase).toBe('run');
    });
  });

  describe('settings', () => {
    it('limits change while it runs, and the orchestrator is told', async () => {
      const p = await ready({ max_children: 1 });
      await t.rpc(p.id, 'start_step', { step_id: p.first.id });
      await expect(t.rpc(p.id, 'start_step', { step_id: p.third.id })).rejects.toThrow(/which is the limit/);
      turn(p.id);
      const res = await patch(p.id, { max_children: 2, answer_children: false });
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ max_children: 2, answer_children: false });
      expect(t.events(p.id)).toContain("system: Settings changed by the owner: at most 2 batches at once; its batches' questions come to the owner.");
      expect(told(p.id).at(-1)).toContain('- The owner changed your settings: at most 2 batches at once; its batches\' questions come to the owner.');
      expect(told(p.id).at(-1)).toContain(`Ready to start: ${p.third.id}`);
      await t.rpc(p.id, 'start_step', { step_id: p.third.id });
      expect((await patch(p.id, { max_children: 9 })).status).toBe(400);
      expect((await patch(p.id, { cost_limit_usd: -1 })).status).toBe(400);
      // nothing changed: nothing said
      const lines = t.events(p.id).length;
      await patch(p.id, { max_children: 2 });
      expect(t.events(p.id)).toHaveLength(lines);
    });

    it('the scope grows and shrinks, but a project a step works in stays', async () => {
      const p = await ready();
      const wider = await patch(p.id, { project_keys: ['AA', 'BB', 'cc'] });
      expect(wider.data.project_keys).toEqual(['AA', 'BB', 'CC']);
      expect(told(p.id).at(-1)).toContain('scope AA, BB, CC');
      expect(await t.rpc(p.id, 'list_items', { project_key: 'CC' })).toEqual([]);
      const narrow = await patch(p.id, { project_keys: ['AA'] });
      expect(narrow.status).toBe(400);
      expect(narrow.data.error).toBe('Step 2 works in BB: it stays in the scope.');
      expect((await patch(p.id, { project_keys: ['AA', 'BB', 'NOPE'] })).data.error).toBe('Unknown project NOPE');
      expect((await patch(p.id, { project_keys: [] })).status).toBe(400);
      await t.s.call('POST', '/projects/CC/disable');
      expect((await patch(p.id, { project_keys: ['AA', 'BB'] })).data.project_keys).toEqual(['AA', 'BB']);
      expect((await patch(p.id, { project_keys: ['AA', 'BB', 'CC'] })).data.error).toMatch(/Project CC is disabled/);
    });

    it('a limit lowered under what is spent pauses it', async () => {
      const p = await ready();
      spend(p.id, 8);
      expect((await patch(p.id, { cost_limit_usd: 5 })).data).toMatchObject({ phase: 'paused', paused_reason: 'Cost limit reached: $8.00 of $5.00 used.' });
    });

    it('switching its answers off gives its batches\' open questions to the owner', async () => {
      const p = await ready();
      const child = await t.startStep(p.id, p.first.id);
      t.status(p.id, 'running');
      t.s.ctx.sessions.onWorkerMessage(t.store.session(child)!.worker_id!, { t: 'input_request', session_id: child, local_id: 'q1', payload: { kind: 'question', questions: [{ question: 'Which?', header: 'x', multiSelect: false, options: [] }] } });
      const input = t.store.inputs(child)[0];
      expect(input.delegated_to).toBe(p.id);
      await patch(p.id, { answer_children: false });
      expect(t.store.input(input.id)!.delegated_to).toBeNull();
      expect(t.pushes.map((x) => x.title)).toContain('AA: question');
    });

    it('a closed orchestration is not changed', async () => {
      const p = await ready();
      await t.s.call('POST', `/orchestrations/${p.id}/stop`);
      const res = await patch(p.id, { max_children: 3 });
      expect(res.status).toBe(409);
      expect((await patch(99999, { max_children: 3 })).status).toBe(404);
    });
  });
});

describe('orchestrator settings: several people', () => {
  it('only its starter changes them', async () => {
    const s = await startMultiUser();
    try {
      await projects(s, as('alice'));
      const id = (await s.call<Orchestration>('POST', '/orchestrations', { goal: 'Rework', project_keys: ['AA'] }, as('alice'))).data.session_id;
      expect((await s.call('PATCH', `/orchestrations/${id}`, { max_children: 3 }, as('bob'))).status).toBe(403);
      expect((await s.call<Orchestration>('PATCH', `/orchestrations/${id}`, { max_children: 3 }, as('alice'))).data.max_children).toBe(3);
    } finally {
      await s.app.close();
    }
  });
});
