// DISP-89: a session's cost is the sum of what each Claude process spent, not the highest total reported.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countCost } from '../src/server/sessions.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

describe('countCost', () => {
  const count = (reports: [run: string | undefined, usd: number][]) =>
    reports.reduce((u, [run, usd]) => ({ ...u, ...countCost(u, usd, run) }), {} as Parameters<typeof countCost>[0]).cost_usd;

  it('takes the running total of several turns in one process', () => {
    expect(count([['a', 1], ['a', 2.5], ['a', 4]])).toBeCloseTo(4);
  });

  it('adds only the new spend when a resumed process goes on from the old total', () => {
    expect(count([['a', 1], ['a', 2], ['b', 2.75], ['b', 3]])).toBeCloseTo(3);
  });

  it('adds all the spend of a resumed process that starts at 0 again', () => {
    expect(count([['a', 1], ['a', 2], ['b', 0.5], ['b', 1.25]])).toBeCloseTo(3.25);
  });

  it('goes on from the last process, not from the sum, after a restart at 0', () => {
    // b started at 0 and ended at 0.5; c was resumed after a clean exit of b
    expect(count([['a', 2], ['b', 0.5], ['c', 0.75]])).toBeCloseTo(2.75);
  });

  it('counts a repeated or late result once', () => {
    expect(count([['a', 1], ['a', 2], ['a', 2], ['a', 1]])).toBeCloseTo(2);
    expect(count([['a', 2], ['b', 0.5], ['b', 0.5], ['b', 1], ['b', 0.5]])).toBeCloseTo(3);
  });

  it('goes on from a total that was counted before processes had a name', () => {
    expect(count([[undefined, 1], [undefined, 3], [undefined, 2]])).toBeCloseTo(3);
    expect(count([[undefined, 3], ['a', 3.5]])).toBeCloseTo(3.5);
    expect(count([[undefined, 3], ['a', 0.5]])).toBeCloseTo(3.5);
  });
});

describe('a session\'s cost from its worker\'s results', () => {
  let t: Setup;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => t.s.app.close());

  it('adds the spend after a restart at 0 to the orchestration at once', async () => {
    const p = await t.approved();
    const result = (run: string, usd: number) =>
      t.s.ctx.sessions.onWorkerMessage(t.store.session(p.id)!.worker_id!, { t: 'event', session_id: p.id, body: { kind: 'result', subtype: 'success', cost_usd: usd, turns: 1, run } });
    result('a', 2);
    result('a', 3);
    result('b', 0.5);
    result('b', 0.5);
    expect(t.store.session(p.id)!.usage).toMatchObject({ cost_usd: 3.5, turns: 4 });
    expect(t.s.ctx.orchestrator.view(p.id).cost_usd).toBeCloseTo(3.5);
  });
});
