import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Attention, type Orchestration, type OrchestrationStep, type Session } from '../src/shared/types.ts';
import { costText, foldLive, orchBusyLabel } from '../web/src/orchestration.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

vi.mock('../web/src/wide.ts', () => ({ useWide: () => true, useVeryWide: () => true }));

let ui: typeof import('../web/src/components/orchestration.tsx');
beforeEach(async () => {
  vi.resetModules();
  stubBrowser();
  ui = await import('../web/src/components/orchestration.tsx');
});
afterEach(() => vi.unstubAllGlobals());

const step = (id: number, over: Partial<OrchestrationStep> = {}): OrchestrationStep => ({
  id, orchestration_id: 5, position: id, title: `Step ${id}`, project_id: 1, project_key: 'AA', prompt_md: '', item_ids: [], item_keys: [], depends_on: [],
  state: 'pending', note: null, child_session_id: null, seen: null, deploys: {}, messages_sent: 0, child: null, ...over,
});
const orch = (over: Partial<Orchestration> = {}): Orchestration => ({
  session_id: 5, title: 'Auth rework', goal: 'Rework auth', project_ids: [1, 2], project_keys: ['AA', 'BB'], phase: 'run', paused_from: null, plan_md: '', plan_approved: true, plan_version: 1,
  max_children: 2, answer_children: true, options: DEFAULT_RUN_OPTIONS, waiting: null, cost_usd: 4.1, cost_limit_usd: null, paused_reason: null, next_wake: null,
  started_by: null, status: 'idle', created_at: '', updated_at: '', steps: [step(1, { state: 'running', child_session_id: 11 }), step(2, { project_key: 'BB' })], ...over,
});
const session = (id: number, over: Partial<Session> = {}): Session => ({
  id, project_id: 1, project_key: 'AA', kind: 'work', title: `S${id}`, status: 'running', force_plan: false, branch: null, sdk_session_id: null, initial_prompt: '', source_id: null,
  waiting_reason: null, last_text: null, usage: null, options: DEFAULT_RUN_OPTIONS, claude_account: null, worker_id: 1, paused: false, pending_prompt: null, moved_from: null, item_ids: [],
  release: null, schedule_id: null, login_needed: null, started_by: null, github_login: null, closed_at: null, closed_reason: null, retry_of: null, about_session: null, orchestrator_id: null,
  created_at: '', updated_at: '', ended_at: null, ...over,
});
const panel = (o: Orchestration, mine = true) => textOf(renderPage(createElement(ui.OrchestrationPanel, { o, mine }), { qc: new QueryClient() }));

describe('an orchestration\'s cost, timer and settings on its page', () => {
  it('shows what it cost, and the limit when there is one', () => {
    expect(costText(orch())).toBe('$4.10');
    expect(costText(orch({ cost_limit_usd: 20 }))).toBe('$4.10 of $20.00');
    expect(costText(orch({ cost_usd: 0 }))).toBe('');
    expect(panel(orch({ cost_limit_usd: 20 }))).toContain('$4.10 of $20.00');
    expect(panel(orch({ phase: 'paused', paused_from: 'run', paused_reason: 'Cost limit reached: $5.01 of $5.00 used.', waiting: 'Cost limit reached: $5.01 of $5.00 used.' }))).toContain('Cost limit reached: $5.01 of $5.00 used.');
  });

  it('Settings is there for who may act on an open orchestration', () => {
    expect(panel(orch())).toContain('Settings');
    expect(panel(orch(), false)).not.toContain('Settings');
    expect(panel(orch({ phase: 'done' }))).not.toContain('Settings');
  });

  it('the settings form has the limits, and a project a step works in cannot leave', () => {
    const qc = new QueryClient();
    qc.setQueryData(['projects'], [{ key: 'AA', name: 'Alpha', disabled: false }, { key: 'BB', name: 'Beta', disabled: false }, { key: 'CC', name: 'Gamma', disabled: false }, { key: 'DD', name: 'Off', disabled: true }]);
    const text = textOf(renderPage(createElement(ui.OrchestrationSettings, { o: orch({ cost_limit_usd: 20 }), onDone: () => {} }), { qc }));
    expect(text).toContain('Batches at once');
    expect(text).toContain('Cost limit');
    expect(text).toContain("It answers its batches' questions");
    expect(text).toMatch(/AA Alpha \(a step works here\)/);
    expect(text).toMatch(/CC Gamma/);
    expect(text).not.toContain('DD');
    expect(text).toContain('Save');
    expect(ui.fixedProjects(orch())).toEqual(['AA', 'BB']);
  });

  it('a timer it set shows on its page, and it counts as running', () => {
    const o = orch({ steps: [step(1, { state: 'done' })], next_wake: '2026-11-14T18:30:00.000Z', waiting: 'Waits for its own timer' });
    expect(orchBusyLabel(o, 'idle')).toBe('Running');
    expect(panel(o)).toContain('Wakes itself');
    expect(orchBusyLabel(orch({ steps: [step(1, { state: 'done' })] }), 'idle')).toBeUndefined();
  });

  it('the start sheet takes a cost limit', () => {
    const qc = new QueryClient();
    qc.setQueryData(['projects'], []);
    expect(textOf(renderPage(createElement(ui.NewOrchestrationForm, { onDone: () => {} }), { qc }))).toContain('Cost limit');
  });
});

describe("an orchestrator's batches are folded under it in Activity", () => {
  const o = session(5, { kind: 'orchestrator', project_id: null, project_key: null, title: 'Auth rework', status: 'idle' });
  const kid = (id: number, over: Partial<Session> = {}) => session(id, { orchestrator_id: 5, ...over });

  it('a batch is under its orchestrator, not a row of its own', () => {
    const rows = foldLive([session(1), kid(11), o, kid(12), session(2)], new Map());
    expect(rows.map((r) => [r.s.id, r.children.map((c) => c.id), r.needs.map((c) => c.id)])).toEqual([[1, [], []], [5, [11, 12], []], [2, [], []]]);
  });

  it('a batch that needs the owner himself shows without unfolding; one that asked the orchestrator does not', () => {
    const attention = new Map<number, Attention>([[13, { kind: 'review', text: 'x', pr_id: 1 }], [14, { kind: 'checking', text: 'x', pr_id: 2 }]]);
    const rows = foldLive([
      o,
      kid(11, { status: 'waiting_input', waiting_reason: 'Which approach?' }),
      kid(12, { status: 'waiting_input', waiting_reason: 'Asked the orchestrator: Which approach?' }),
      kid(13, { status: 'idle' }),
      kid(14, { status: 'idle' }),
    ], attention);
    expect(rows).toHaveLength(1);
    expect(rows[0].needs.map((c) => c.id)).toEqual([11, 13]);
    expect(rows[0].children.map((c) => c.id)).toEqual([12, 14]);
  });

  it('a batch whose orchestrator is not in the list stays a row', () => {
    expect(foldLive([kid(11)], new Map()).map((r) => r.s.id)).toEqual([11]);
  });

  it('the list shows the fold with its count', () => {
    const text = textOf(renderPage(createElement(ui.FoldedLive, { live: [o, kid(11, { title: 'Token store' }), kid(12, { title: 'Docs', status: 'waiting_input', waiting_reason: 'Which approach?' })], attention: new Map(), orchestrations: [orch()] }), { qc: new QueryClient() }));
    expect(text).toContain('Auth rework');
    expect(text).toContain('Docs'); // needs the owner: shown
    expect(text).toContain('1 session'); // the other one is folded
  });
});
