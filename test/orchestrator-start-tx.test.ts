import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup, type Setup } from './orchestrator-helpers.ts';

// DISP-169: the orchestrator session and its orchestration are made in one transaction.
describe('orchestrator: starting it', () => {
  let t: Setup;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => t.s.app.close());

  it('an orchestration that cannot be made leaves no orchestrator session behind, and nothing is told or started', async () => {
    const sent: unknown[] = [];
    t.s.ctx.bus.on((m) => { if (m.t === 'session') sent.push(m); });
    t.store.createOrchestration = () => { throw new Error('constraint failed'); };
    expect(() => t.start()).toThrow('constraint failed');
    expect(t.store.sessions({ kind: 'orchestrator' })).toEqual([]);
    expect(t.store.db.get('SELECT COUNT(*) AS n FROM sessions')).toEqual({ n: 0 });
    expect(sent).toEqual([]);
  });

  it('it starts as before when the orchestration is made', () => {
    const o = t.start();
    expect(t.store.session(o.session_id)).toMatchObject({ kind: 'orchestrator' });
    expect(t.store.orchestration(o.session_id)).toBeTruthy();
  });
});
