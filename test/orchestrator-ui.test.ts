import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Orchestration, type OrchestrationStep, type Session } from '../src/shared/types.ts';
import type { SessionDetail } from '../web/src/api.ts';
import { doneCount, orchestrationProblem, stepActions, stepRight } from '../web/src/orchestration.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

const screen = vi.hoisted(() => ({ wide: true }));
vi.mock('../web/src/wide.ts', () => ({ useWide: () => screen.wide, useVeryWide: () => screen.wide }));

let ui: typeof import('../web/src/components/orchestration.tsx');
let SessionView: typeof import('../web/src/pages/Session.tsx').SessionView;
beforeEach(async () => {
  vi.resetModules();
  stubBrowser();
  screen.wide = true;
  ui = await import('../web/src/components/orchestration.tsx');
  ({ SessionView } = await import('../web/src/pages/Session.tsx'));
});
afterEach(() => vi.unstubAllGlobals());

const step = (id: number, over: Partial<OrchestrationStep> = {}): OrchestrationStep => ({
  id, orchestration_id: 5, position: id, title: `Step ${id}`, project_id: 1, project_key: 'AA', prompt_md: '', item_ids: [], item_keys: [`AA-${id}`],
  depends_on: [], state: 'pending', note: null, child_session_id: null, seen: null, deploys: {}, messages_sent: 0, child: null, ...over,
});
const orch = (over: Partial<Orchestration> = {}): Orchestration => ({
  session_id: 5, title: 'Auth rework', goal: 'Rework auth', project_ids: [1, 2], project_keys: ['AA', 'BB'], phase: 'run', paused_from: null,
  plan_md: 'Store first.', plan_approved: true, plan_version: 1, answer_children: true, cost_usd: 0, cost_limit_usd: null, paused_reason: null, next_wake: null, model: 'default', effort: 'default', max_children: 2, options: DEFAULT_RUN_OPTIONS, waiting: 'Waiting for #12 (checking, then auto-merge) in AA',
  started_by: null, status: 'idle', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  steps: [
    step(1, { title: 'Token store', state: 'done', child_session_id: 11, child: { id: 11, status: 'completed', title: 'Token store', waiting_reason: null } }),
    step(2, { title: 'Session refresh', state: 'running', note: 'checking, then auto-merge', child_session_id: 12, child: { id: 12, status: 'idle', title: 'Session refresh', waiting_reason: null } }),
    step(3, { title: 'Use the new tokens', project_key: 'BB', item_keys: ['BB-90'], depends_on: [2] }),
  ],
  ...over,
});
const panel = (o: Orchestration, mine = true) => textOf(renderPage(createElement(ui.OrchestrationPanel, { o, mine })));

describe('the orchestration panel', () => {
  it('lists the steps with state, project, items and batch', () => {
    const text = panel(orch());
    expect(text).toContain('AA · BB');
    expect(text).toContain('1 of 3 steps');
    expect(text).toContain('Waiting for #12 (checking, then auto-merge) in AA');
    expect(text).toMatch(/1 AA Token store AA-1 · #11 done/);
    expect(text).toMatch(/2 AA Session refresh AA-2 · #12 checking, then auto-merge/);
    expect(text).toMatch(/3 BB Use the new tokens BB-90 · after 2/);
    expect(text).toContain('The plan in full');
    expect(text).toMatch(/Pause/);
    expect(text).toMatch(/Stop/);
    expect(text).not.toContain('Approve plan');
  });

  it('Approve shows only for a plan that waits, and only to who may act', () => {
    const waiting = orch({ phase: 'plan', plan_approved: false, waiting: 'Plan ready to approve', steps: [step(1)] });
    expect(panel(waiting)).toContain('Approve plan');
    expect(panel(waiting, false)).not.toContain('Approve plan');
    expect(panel(waiting, false)).not.toMatch(/Pause|Stop/);
    expect(panel(orch({ phase: 'plan', plan_approved: false, waiting: null, steps: [] }))).toMatch(/No plan yet/);
  });

  it('a closed orchestration has no Pause or Stop; a paused one offers Resume', () => {
    expect(panel(orch({ phase: 'done', waiting: null }))).not.toMatch(/Pause|Stop|Resume/);
    expect(panel(orch({ phase: 'paused', paused_from: 'run', waiting: 'Paused' }))).toMatch(/Resume/);
  });

  it('a held step says which step holds it, also through a step between', () => {
    const o = orch({ steps: [step(1, { state: 'failed', note: 'The build broke.' }), step(2, { depends_on: [1] }), step(3, { depends_on: [2] }), step(4)] });
    expect(stepRight(o.steps[0], o)).toBe('The build broke.');
    expect(stepRight(o.steps[1], o)).toBe('held by step 1');
    expect(stepRight(o.steps[2], o)).toBe('held by step 1');
    expect(stepRight(o.steps[3], o)).toBe('ready');
    expect(panel(o)).toContain('held by step 1');
  });

  it('the step menu offers Retry only on a failed step, and nothing to change once it is closed', () => {
    const o = orch();
    expect(stepActions(step(1, { state: 'failed', child_session_id: 9 }), o)).toEqual(['retry', 'skip', 'open']);
    expect(stepActions(step(1), o)).toEqual(['skip']);
    expect(stepActions(step(1, { state: 'review', child_session_id: 9 }), o)).toEqual(['skip', 'open']);
    expect(stepActions(step(1, { state: 'running', child_session_id: 9 }), o)).toEqual(['open']);
    expect(stepActions(step(1, { state: 'done', child_session_id: 9 }), o)).toEqual(['open']);
    expect(stepActions(step(1, { state: 'failed', child_session_id: 9 }), orch({ phase: 'stopped' }))).toEqual(['open']);
    expect(doneCount(orch({ steps: [step(1, { state: 'done' }), step(2, { state: 'skipped' }), step(3)] }))).toBe(2);
  });

  it('a new orchestration needs a goal and a project', () => {
    expect(orchestrationProblem('', ['AA'])).toBe('Say what it should reach.');
    expect(orchestrationProblem('Rework auth', [])).toBe('Pick at least one project.');
    expect(orchestrationProblem('Rework auth', ['AA'])).toBeNull();
    expect(textOf(renderPage(createElement(ui.NewOrchestration)))).toContain('New orchestration');
  });
});

describe('the session page of an orchestrator', () => {
  const session = (over: Partial<Session> = {}): Session => ({
    id: 5, project_id: null, project_key: null, kind: 'orchestrator', title: 'Auth rework', status: 'idle', force_plan: false, branch: null, sdk_session_id: null,
    initial_prompt: 'Rework auth', source_id: null, waiting_reason: null, last_text: null, usage: null, options: DEFAULT_RUN_OPTIONS, claude_account: null, worker_id: 1,
    paused: false, pending_prompt: null, moved_from: null, item_ids: [], release: null, schedule_id: null, login_needed: null, started_by: null, github_login: null,
    closed_at: null, closed_reason: null, retry_of: null, about_session: null, orchestrator_id: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ended_at: null, ...over,
  });
  const page = (detail: Partial<SessionDetail> & { session: Session }) => {
    const qc = new QueryClient();
    qc.setQueryData(['session', detail.session.id], { events: [], inputs: [], items: [], prs: [], repos: [], source: null, project: null, failure: null, orchestration: null, part_of: null, ...detail } satisfies SessionDetail);
    return textOf(renderPage(createElement(SessionView), { qc, path: `/s/${detail.session.id}`, route: '/s/:id' }));
  };

  for (const wide of [true, false]) {
    it(`shows the plan with its steps (${wide ? 'desktop' : 'phone'})`, () => {
      screen.wide = wide;
      const text = page({ session: session(), orchestration: orch() });
      expect(text).toContain('Auth rework');
      expect(text).toContain('1 of 3 steps');
      expect(text).toContain('Session refresh');
      expect(text).toContain('AA · BB · orchestration');
    });
  }

  it("a step's batch links back to its orchestration and step", () => {
    const text = page({ session: session({ id: 12, kind: 'work', project_id: 1, project_key: 'AA', title: 'Session refresh', orchestrator_id: 5 }), part_of: { orchestrator_id: 5, title: 'Auth rework', step_position: 2, step_count: 3 } });
    expect(text).toContain('Part of Auth rework (step 2 of 3)');
  });
});
