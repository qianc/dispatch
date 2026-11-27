import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup, type Setup } from './orchestrator-helpers.ts';
import { turnChecks } from '../src/worker/turnCheck.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';

// DISP-262: the orchestrator sees each repo's checks and sets per step how much its batch tests.
describe('orchestrator: test level per step', () => {
  let t: Setup;
  beforeEach(async () => {
    t = await setup();
    for (const key of ['AA', 'BB']) {
      const repo = t.store.repos(t.store.projectByKey(key)!.id)[0];
      t.store.updateRepo(repo.id, { check_command: 'npm test', quick_check_command: 'npm run lint', setup_command: 'npm ci' });
    }
  });
  afterEach(() => t.s.app.close());

  /** the levels a batch's turn check runs, from the spec its worker gets */
  const levels = (sessionId: number) => {
    const spec = t.s.ctx.sessions.spec(t.store.session(sessionId)!, '', null, null);
    return turnChecks(spec.repos, spec.options).map((c) => `${c.level}: ${c.command}`);
  };

  const plan = async () => {
    const a = await t.item('AA', 'One');
    const b = await t.item('BB', 'Two');
    const id = t.start({ options: { ...DEFAULT_RUN_OPTIONS, base_check: false, auto_merge: 'github' } }).session_id;
    await t.rpc(id, 'set_plan', {
      plan_md: 'Targeted tests in each step, the full suite in the last.',
      steps: [
        { title: 'Store', project_key: 'AA', item_keys: [a.key], check_level: 'quick' },
        { title: 'Release', project_key: 'BB', item_keys: [b.key], after: [1], check_level: 'full' },
      ],
    });
    t.s.ctx.orchestrator.approve(id);
    const [first, second] = t.s.ctx.orchestrator.view(id).steps;
    return { id, first, second };
  };

  it('the plan shows the repo checks and batch options, and each step starts with its level', async () => {
    const p = await plan();
    expect([p.first.check_level, p.second.check_level]).toEqual(['quick', 'full']);
    const status = t.s.ctx.orchestrator.statusText(t.s.ctx.orchestrator.view(p.id));
    expect(status).toContain(`(step_id ${p.first.id}, check_level quick)`);
    expect(status).toContain('Batches start with: turn_check on, base_check off, auto_merge github.');
    // GitHub repos with no CI known: the full check by default
    expect(status).toContain('  AA aa: check `npm test`, quick check `npm run lint`, setup `npm ci`; after a turn by default: full');
    const child = await t.startStep(p.id, p.first.id);
    expect(t.store.session(child)!.options).toMatchObject({ check_level: 'quick', auto_merge: 'github' });
    expect(levels(child)).toEqual(['quick: npm run lint']);
  });

  it('amend_plan changes a level without approval, and a running batch uses it from its next turn', async () => {
    const p = await plan();
    const child = await t.startStep(p.id, p.first.id);
    const keep = (s: typeof p.first, check_level: string, after: number[] = []) => ({ id: s.id, title: s.title, project_key: s.project_key, prompt: s.prompt_md, item_keys: s.item_keys, after, check_level });
    const reply = String(await t.rpc(p.id, 'amend_plan', {
      steps: [keep(p.first, 'none'), keep(p.second, 'quick', [1])],
      change: { kind: 'checks', reason: 'The owner wants no checks in step 1.' },
    }));
    expect(reply).toContain('Changed: step 1 "Store": tests none after each turn; step 2 "Release": tests quick after each turn.');
    const o = t.s.ctx.orchestrator.view(p.id);
    expect(o.proposal).toBeNull();
    expect(o.changes).toEqual([expect.objectContaining({ kind: 'checks', decided_by: 'orchestrator' })]);
    expect(o.steps.map((s) => s.check_level)).toEqual(['none', 'quick']);
    // the running step's batch: its next turn's spec has no check
    expect(t.store.session(child)!.options.check_level).toBe('none');
    expect(levels(child)).toEqual([]);
    expect(t.events(child)).toContain('system: The orchestrator changed the check after each turn to none, from the next turn on.');
  });

  it('a level set by set_plan on a running plan waits for the owner like any proposal', async () => {
    const p = await plan();
    await t.rpc(p.id, 'set_plan', {
      steps: [
        { id: p.first.id, title: 'Store', project_key: 'AA', item_keys: p.first.item_keys },
        { id: p.second.id, title: 'Release', project_key: 'BB', item_keys: p.second.item_keys, after: [1], check_level: 'none' },
      ],
    });
    const o = t.s.ctx.orchestrator.view(p.id);
    expect(o.proposal).toMatchObject({ held: [p.first.id, p.second.id] });
    t.s.ctx.orchestrator.approve(p.id);
    expect(t.s.ctx.orchestrator.view(p.id).steps.map((s) => s.check_level)).toEqual([null, 'none']);
  });
});
