import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Orchestration, type Session } from '../src/shared/types.ts';
import { liveGroups } from '../web/src/activity.ts';
import type { Inbox } from '../web/src/api.ts';
import { partOfIndex } from '../web/src/orchestration.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

vi.mock('../web/src/wide.ts', () => ({ useWide: () => true, useVeryWide: () => true }));

let InboxPage: typeof import('../web/src/pages/Inbox.tsx').Inbox;
let SessionRow: typeof import('../web/src/components/items.tsx').SessionRow;
beforeEach(async () => {
  vi.resetModules();
  stubBrowser();
  ({ Inbox: InboxPage } = await import('../web/src/pages/Inbox.tsx'));
  ({ SessionRow } = await import('../web/src/components/items.tsx'));
});
afterEach(() => vi.unstubAllGlobals());

const session = (over: Partial<Session> = {}): Session => ({
  id: 5, project_id: null, project_key: null, kind: 'orchestrator', title: 'Auth rework', status: 'idle', force_plan: false, branch: null, sdk_session_id: null,
  initial_prompt: 'Rework auth', source_id: null, waiting_reason: null, last_text: 'I started step 2.', usage: null, options: DEFAULT_RUN_OPTIONS, claude_account: null, worker_id: 1,
  paused: false, pending_prompt: null, moved_from: null, item_ids: [], release: null, schedule_id: null, login_needed: null, started_by: null, github_login: null,
  closed_at: null, closed_reason: null, retry_of: null, about_session: null, orchestrator_id: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ended_at: null, ...over,
});
const orch: Orchestration = {
  session_id: 5, title: 'Auth rework', goal: 'Rework auth', project_ids: [1], project_keys: ['AA'], phase: 'run', paused_from: null, plan_md: '', plan_approved: true, plan_version: 1, answer_children: true, cost_usd: 0, cost_limit_usd: null, paused_reason: null, next_wake: null, model: 'default', effort: 'default',
  max_children: 2, options: DEFAULT_RUN_OPTIONS, waiting: 'Waiting for #12 (running) in AA', started_by: null, status: 'idle', created_at: '', updated_at: '',
  steps: [1, 2, 3].map((n) => ({
    id: n, orchestration_id: 5, position: n, title: `Step ${n}`, project_id: 1, project_key: 'AA', prompt_md: '', item_ids: [], item_keys: [], depends_on: [],
    state: n === 1 ? 'done' as const : n === 2 ? 'running' as const : 'pending' as const, note: null, child_session_id: n < 3 ? 10 + n : null, seen: null, deploys: {}, messages_sent: 0, child: null,
  })),
};

describe('orchestrations in the lists', () => {
  it('the inbox shows a plan to approve and a failed step, each with a way in', () => {
    const inbox: Inbox = {
      inputs: [], failed: [], prs: [], sessions: [], cleanup: null,
      idle: [
        { ...session({ id: 5 }), attention: { kind: 'plan', text: 'The plan is ready: read it and approve it.' } },
        { ...session({ id: 6, title: 'Billing move' }), attention: { kind: 'step_failed', step_id: 3, text: 'Step 1 failed. Step 2 is held.' } },
      ],
    };
    const qc = new QueryClient();
    qc.setQueryData(['inbox'], inbox);
    qc.setQueryData(['worker'], { connected: true });
    const text = textOf(renderPage(createElement(InboxPage), { qc }));
    // the failed step comes first
    expect(text).toMatch(/Billing move.*Step failed: Step 1 failed\. Step 2 is held\..*Auth rework.*Orchestrator needs you: The plan is ready: read it and approve it\./);
    expect(text.match(/Open the plan/g)).toHaveLength(2);
    // nothing here closes an orchestration by mistake
    expect(text).not.toContain('Mark as complete');
    // the menu: a failed step is red
    expect(liveGroups([], inbox).needs.map((n) => [n.title, n.tone])).toEqual([['Auth rework', 'wait'], ['Billing move', 'bad']]);
  });

  it("an orchestrator's row shows its steps and what it waits for, not \"Your turn\"", () => {
    const text = textOf(renderPage(createElement(SessionRow, { s: session(), showProject: true, orch })));
    expect(text).toContain('Auth rework');
    expect(text).toContain('1/3');
    expect(text).toContain('Waiting for #12 (running) in AA');
    expect(text).toContain('Running');
    expect(text).not.toContain('Your turn');
    // while its plan waits for a yes, it is your turn
    const waits = textOf(renderPage(createElement(SessionRow, { s: session(), orch: { ...orch, phase: 'plan', plan_approved: false, waiting: 'Plan ready to approve' }, attention: { kind: 'plan', text: 'x' } })));
    expect(waits).toContain('Your turn');
    expect(waits).toContain('Plan ready to approve');
  });

  it("a step's batch says which orchestration it is part of", () => {
    const index = partOfIndex([orch]);
    expect(index.get(12)).toBe('Auth rework · step 2 of 3');
    expect(index.get(99)).toBeUndefined();
    const text = textOf(renderPage(createElement(SessionRow, { s: session({ id: 12, kind: 'work', project_id: 1, project_key: 'AA', title: 'Step 2', orchestrator_id: 5 }), partOf: index.get(12) })));
    expect(text).toContain('Auth rework · step 2 of 3');
  });
});
