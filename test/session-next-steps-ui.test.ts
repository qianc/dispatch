// An idle session's page offers what the Inbox offers for it, whatever its kind (DISP-124).
import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Attention, type Orchestration, type Session } from '../src/shared/types.ts';
import { attentionOf, finishedAttention } from '../src/shared/attention.ts';
import { nextStepsOnPage } from '../web/src/components/nextSteps.tsx';
import type { SessionDetail } from '../web/src/api.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

vi.mock('../web/src/wide.ts', () => ({ useWide: () => true, useVeryWide: () => true }));

let SessionView: typeof import('../web/src/pages/Session.tsx').SessionView;
beforeEach(async () => {
  vi.resetModules();
  stubBrowser();
  ({ SessionView } = await import('../web/src/pages/Session.tsx'));
});
afterEach(() => vi.unstubAllGlobals());

const session = (over: Partial<Session> = {}): Session => ({
  id: 7, project_id: 1, project_key: 'P', kind: 'work', title: 'Release 1.2', status: 'idle', force_plan: false, branch: null, sdk_session_id: null, run_model: null,
  initial_prompt: 'Release', source_id: null, waiting_reason: null, last_text: null, usage: null, options: DEFAULT_RUN_OPTIONS, claude_account: null, worker_id: 1,
  paused: false, pending_prompt: null, moved_from: null, item_ids: [], release: null, schedule_id: null, login_needed: null, limit_wait: null, unclean: null, started_by: null, github_login: null,
  closed_at: null, closed_reason: null, retry_of: null, about_session: null, orchestrator_id: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ended_at: null, ...over,
});
const html = (s: Session) => {
  const qc = new QueryClient();
  qc.setQueryData(['session', s.id], { session: s, events: [], inputs: [], items: [], prs: [], attention: attentionOf(s, []), repos: [], source: null, project: null, failure: null } satisfies SessionDetail);
  return renderPage(createElement(SessionView), { qc, path: `/s/${s.id}`, route: '/s/:id' });
};
const page = (s: Session) => textOf(html(s));

describe('Mark as complete on a session\'s own page (DISP-124)', () => {
  it('a finished release session has it, as in the Your turn list', () => {
    expect(page(session({ kind: 'release' }))).toContain('Mark as complete');
  });

  it('it is the primary button, as on a merged session (DISP-113)', () => {
    const button = html(session({ kind: 'release' })).match(/<button[^>]*>[^<]*Mark as complete/)?.[0] ?? '';
    expect(button).toContain('bg-accent-strong');
    expect(button).toContain('✓ Mark as complete');
  });

  it('a work session still has it', () => {
    expect(page(session())).toContain('Mark as complete');
  });

  it('not while it runs, and not on an orchestrator, which has its own controls', () => {
    expect(page(session({ kind: 'release', status: 'running' }))).not.toContain('Mark as complete');
    expect(page(session({ kind: 'orchestrator', project_id: null, project_key: null }))).not.toContain('Mark as complete');
  });

  it('a finished orchestrator has it on its page, with what it left undone (DISP-121)', () => {
    const s = session({ kind: 'orchestrator', project_id: null, project_key: null });
    const qc = new QueryClient();
    const orchestration: Orchestration = {
      session_id: s.id, title: 'Auth rework', goal: 'Rework auth', project_ids: [1], project_keys: ['AA'], phase: 'done', paused_from: null, plan_md: '', plan_approved: true, plan_version: 1, answer_children: true, notify_owner: 'needs_you', quiet_log: [], cost_usd: 0, cost_limit_usd: null, paused_reason: null, next_wake: null, model: 'default', effort: 'default',
      max_children: 2, options: DEFAULT_RUN_OPTIONS, waiting: null, proposal: null, changes: [], started_by: null, status: 'idle', created_at: '', updated_at: '',
      steps: [1, 2].map((n) => ({
        id: n, orchestration_id: s.id, position: n, title: `Step ${n}`, project_id: 1, project_key: 'AA', prompt_md: '', item_ids: [], item_keys: [], depends_on: [],
        state: n === 1 ? 'done' as const : 'failed' as const, note: null, child_session_id: 10 + n, seen: null, deploys: {}, messages_sent: 0, optional: false, child: null,
      })),
    };
    qc.setQueryData(['session', s.id], { session: s, events: [], inputs: [], items: [], prs: [], attention: finishedAttention(orchestration), repos: [], source: null, project: null, failure: null, orchestration } satisfies SessionDetail);
    const text = textOf(renderPage(createElement(SessionView), { qc, path: `/s/${s.id}`, route: '/s/:id' }));
    expect(text).toContain('Finished, but the goal is not fully met: step 2 failed.');
    expect(text).toContain('✓ Mark as complete');
    expect(text).toContain('Re-plan');
  });

  it('not on the Assistant chat, but a chat on an item still has it (DISP-128)', () => {
    expect(page(session({ kind: 'assistant', title: 'Assistant', project_id: null, project_key: null }))).not.toContain('Mark as complete');
    expect(page(session({ kind: 'discuss', title: 'Discuss P-1', item_ids: [1] }))).toContain('Mark as complete');
  });
});

describe('nextStepsOnPage (DISP-128)', () => {
  const turn: Attention = { kind: 'turn', text: '' };
  it('every kind but the Assistant chat and an orchestrator', () => {
    for (const kind of ['work', 'release', 'discuss', 'planner']) expect(nextStepsOnPage({ kind }, turn)).toBe(true);
    for (const kind of ['assistant', 'orchestrator']) expect(nextStepsOnPage({ kind }, turn)).toBe(false);
  });
});
