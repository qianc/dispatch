// DISP-16: cost and run time per project and per item, by item type and by tag.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AllCosts, ProjectCosts, SessionKind } from '../src/shared/types.ts';
import { OWNER, startServer } from './helpers.ts';

type Server = Awaited<ReturnType<typeof startServer>>;

describe('cost and time (DISP-16)', () => {
  let s: Server;
  beforeEach(async () => {
    s = await startServer();
    for (const key of ['AA', 'BB']) await s.call('POST', '/projects', { key, name: `Project ${key}` });
  });
  afterEach(() => s.app.close());

  const item = async (project: string, title: string, extra: { type?: string; labels?: string[] } = {}) =>
    (await s.call<{ id: number; key: string }>('POST', `/projects/${project}/items`, { title, ...extra })).data;

  /** A finished session that cost `usd` and whose turns took `turnsMs`. */
  const session = (project: string | null, kind: SessionKind, itemIds: number[], usd: number, turnsMs: number[], createdAt?: string) => {
    const { store } = s.ctx;
    const made = store.createSession({
      started_by: OWNER, worker_id: store.defaultWorkerId(), project_id: project ? store.projectByKey(project)!.id : null, kind, title: `${kind} session`,
      status: 'completed', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: itemIds,
    });
    store.updateSession(made.id, { usage: { cost_usd: usd, turns: turnsMs.length } });
    store.addEvent(made.id, { kind: 'assistant', text: 'working' });
    for (const duration_ms of turnsMs) store.addEvent(made.id, { kind: 'result', subtype: 'success', cost_usd: usd, turns: 1, duration_ms });
    if (createdAt) store.db.run('UPDATE sessions SET created_at = ? WHERE id = ?', createdAt, made.id);
    return made.id;
  };
  const costs = async (project: string, query = '') => (await s.call<ProjectCosts>('GET', `/projects/${project}/costs${query}`)).data;

  it('splits a session in equal shares over its items; the project total is not split', async () => {
    const [a, b, c] = [await item('AA', 'First'), await item('AA', 'Second'), await item('AA', 'Third')];
    session('AA', 'work', [a.id, b.id], 3, [60_000, 30_000]);
    session('AA', 'work', [a.id, b.id, c.id], 6, [90_000]);

    const got = await costs('AA');
    expect(got.total).toEqual({ cost_usd: 9, duration_ms: 180_000, sessions: 2, items: 3 });
    expect(got.items.map((i) => [i.key, i.cost_usd, i.duration_ms, i.sessions])).toEqual([
      [a.key, 3.5, 75_000, 2],
      [b.key, 3.5, 75_000, 2],
      [c.key, 2, 30_000, 1],
    ]);
    expect(got.unlinked).toMatchObject({ cost_usd: 0, sessions: 0 });
  });

  it('counts every session of an item: the batch, a retry and a discussion', async () => {
    const a = await item('AA', 'Retried');
    session('AA', 'work', [a.id], 2, [10_000]);
    session('AA', 'work', [a.id], 1.5, [20_000]);
    session('AA', 'discuss', [a.id], 0.25, [5_000]);
    const got = await costs('AA');
    expect(got.items).toHaveLength(1);
    expect(got.items[0]).toMatchObject({ key: a.key, title: 'Retried', cost_usd: 3.75, duration_ms: 35_000, sessions: 3 });
  });

  it('keeps sessions with no item apart, and the total is the item shares plus those', async () => {
    const [a, b] = [await item('AA', 'First'), await item('AA', 'Second')];
    session('AA', 'work', [a.id, b.id], 1, [7_000]);
    session('AA', 'work', [b.id], 0.4, [3_000]);
    session('AA', 'planner', [], 0.6, [40_000]);
    session('AA', 'discuss', [], 0.1, [1_000]);
    session('BB', 'planner', [], 50, [1]);

    const got = await costs('AA');
    expect(got.unlinked).toEqual({ cost_usd: 0.7, duration_ms: 41_000, sessions: 2, items: 0 });
    expect(got.total).toMatchObject({ sessions: 4, items: 2 });
    expect(got.total.cost_usd).toBeCloseTo(2.1);
    const shares = got.items.reduce((sum, i) => ({ usd: sum.usd + i.cost_usd, ms: sum.ms + i.duration_ms }), { usd: 0, ms: 0 });
    expect(shares.usd + got.unlinked.cost_usd).toBeCloseTo(got.total.cost_usd);
    expect(shares.ms + got.unlinked.duration_ms).toBe(got.total.duration_ms);
  });

  it('groups by item type, and the types add up to the item shares', async () => {
    const [a, b, c] = [await item('AA', 'Feature'), await item('AA', 'Crash', { type: 'bug' }), await item('AA', 'Typo', { type: 'bug' })];
    session('AA', 'work', [a.id, b.id], 4, [100_000]);
    session('AA', 'work', [c.id], 1, [20_000]);
    session('AA', 'planner', [], 9, [1_000]);
    const got = await costs('AA');
    expect(got.by_type).toEqual([
      { name: 'bug', cost_usd: 3, duration_ms: 70_000, sessions: 2, items: 2 },
      { name: 'backlog', cost_usd: 2, duration_ms: 50_000, sessions: 1, items: 1 },
    ]);
  });

  it('groups by tag: an item counts in full under each of its tags, and one with none under no tag', async () => {
    const [a, b, c] = [await item('AA', 'Both', { labels: ['ui', 'perf'] }), await item('AA', 'One', { labels: ['UI'] }), await item('AA', 'None')];
    session('AA', 'work', [a.id], 2, [10_000]);
    session('AA', 'work', [b.id, c.id], 1, [8_000]);
    const got = await costs('AA');
    expect(got.by_tag).toEqual([
      { name: 'ui', cost_usd: 2.5, duration_ms: 14_000, sessions: 2, items: 2 },
      { name: 'perf', cost_usd: 2, duration_ms: 10_000, sessions: 1, items: 1 },
      { name: null, cost_usd: 0.5, duration_ms: 4_000, sessions: 1, items: 1 },
    ]);
  });

  it('counts only the sessions started in the period asked for', async () => {
    const a = await item('AA', 'Old and new');
    session('AA', 'work', [a.id], 5, [50_000], new Date(Date.now() - 40 * 86_400_000).toISOString());
    session('AA', 'work', [a.id], 1, [10_000]);
    expect((await costs('AA')).total).toMatchObject({ cost_usd: 6, sessions: 2 });
    expect((await costs('AA', '?days=30')).total).toMatchObject({ cost_usd: 1, duration_ms: 10_000, sessions: 1 });
    expect((await costs('AA', '?days=30')).items[0]).toMatchObject({ cost_usd: 1, sessions: 1 });
    expect((await costs('AA', '?days=90')).total).toMatchObject({ cost_usd: 6 });
  });

  it('a session with no cost or no turn yet counts as zero', async () => {
    const a = await item('AA', 'Queued');
    const { store } = s.ctx;
    store.createSession({ started_by: OWNER, worker_id: store.defaultWorkerId(), project_id: store.projectByKey('AA')!.id, kind: 'work', title: 'q', status: 'queued', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [a.id] });
    expect((await costs('AA')).total).toEqual({ cost_usd: 0, duration_ms: 0, sessions: 1, items: 1 });
    expect((await costs('BB')).total).toEqual({ cost_usd: 0, duration_ms: 0, sessions: 0, items: 0 });
  });

  it('all projects: each project unsplit, and the sessions with no project in a row of their own', async () => {
    const [a, b] = [await item('AA', 'First'), await item('BB', 'Other')];
    session('AA', 'work', [a.id], 2, [10_000]);
    session('AA', 'planner', [], 1, [5_000]);
    session('BB', 'work', [b.id], 7, [60_000]);
    session(null, 'assistant', [], 0.5, [2_000]);
    session(null, 'orchestrator', [], 1.5, [3_000]);

    const all = (await s.call<AllCosts>('GET', '/costs')).data;
    expect(all.projects.map((p) => [p.key, p.name, p.cost_usd, p.duration_ms, p.sessions, p.items])).toEqual([
      ['BB', 'Project BB', 7, 60_000, 1, 1],
      ['AA', 'Project AA', 3, 15_000, 2, 1],
    ]);
    expect(all.unlinked).toEqual({ cost_usd: 2, duration_ms: 5_000, sessions: 2, items: 0 });
    expect(all.total).toEqual({ cost_usd: 12, duration_ms: 80_000, sessions: 5, items: 2 });
  });

  it('refuses an unknown project and a bad period', async () => {
    expect((await s.call('GET', '/projects/NOPE/costs')).status).toBe(404);
    expect((await s.call('GET', '/projects/AA/costs?days=0')).status).toBe(400);
    expect((await s.call('GET', '/costs?days=soon')).status).toBe(400);
  });
});
