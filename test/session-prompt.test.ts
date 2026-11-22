import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Session } from '../src/shared/types.ts';
import { attentionOf } from '../src/shared/attention.ts';
import type { SessionDetail } from '../web/src/api.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

const screen = vi.hoisted(() => ({ wide: true }));
vi.mock('../web/src/wide.ts', () => ({ useWide: () => screen.wide, useVeryWide: () => screen.wide }));

let SessionPrompt: typeof import('../web/src/components/sessionPrompt.tsx').SessionPrompt;
let promptOpen: typeof import('../web/src/components/sessionPrompt.tsx').promptOpen;
let SessionView: typeof import('../web/src/pages/Session.tsx').SessionView;
beforeEach(async () => {
  vi.resetModules(); // the open/closed state is module state: fresh for each test
  stubBrowser();
  screen.wide = true;
  ({ SessionPrompt, promptOpen } = await import('../web/src/components/sessionPrompt.tsx'));
  ({ SessionView } = await import('../web/src/pages/Session.tsx'));
});
afterEach(() => vi.unstubAllGlobals());

const LINES = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: check the login form in every browser we support`);
const LONG = LINES.join('\n');

const session = (over: Partial<Session> = {}): Session => ({
  id: 7, project_id: 1, project_key: 'P', kind: 'work', title: 'Fix login', status: 'running', force_plan: false, branch: 'dispatch/p-7-fix', sdk_session_id: null, run_model: null,
  initial_prompt: 'Fix the login bug', source_id: null, waiting_reason: null, last_text: null, usage: null, options: DEFAULT_RUN_OPTIONS, claude_account: null, worker_id: 1,
  paused: false, pending_prompt: null, moved_from: null, item_ids: [], release: null, schedule_id: null, login_needed: null, limit_wait: null, unclean: null, started_by: null, github_login: null, closed_at: null, closed_reason: null, retry_of: null, about_session: null, orchestrator_id: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ended_at: null, ...over,
});
const detail = (s: Session): SessionDetail => ({ session: s, events: [], inputs: [], items: [], prs: [], attention: attentionOf(s, []), repos: [], source: null, project: null });

const prompt = (id: number, text: string) => renderPage(createElement(SessionPrompt, { sessionId: id, text }));

describe('the prompt in the side panel (DISP-66)', () => {
  it('a short prompt shows whole, with nothing to expand', () => {
    const html = prompt(1, 'Fix the login bug\nand add a test');
    expect(html).toContain('Fix the login bug\nand add a test'); // as written, line breaks kept
    expect(html).toContain('whitespace-pre-wrap');
    expect(textOf(html)).not.toMatch(/Show (more|less)/);
  });

  it('a long prompt starts collapsed to a preview with Show more', () => {
    const html = prompt(1, LONG);
    const text = textOf(html);
    expect(text).toContain('Step 1:');
    expect(text).not.toContain('Step 12:');
    expect(text).toContain('Show more');
    expect(html).toContain('aria-expanded="false"');
  });

  it('expanded, it shows the full text with Show less', () => {
    promptOpen.set(1, true);
    const text = textOf(prompt(1, LONG));
    expect(text).toContain('Step 12:');
    expect(text).toContain('Show less');
    expect(text).not.toContain('Show more');
  });

  it('each session keeps its own open or collapsed state', () => {
    promptOpen.set(1, true);
    expect(textOf(prompt(1, LONG))).toContain('Show less');
    expect(textOf(prompt(2, LONG))).toContain('Show more');
  });

  const sessionPage = (s: Session) => {
    const qc = new QueryClient();
    qc.setQueryData(['session', s.id], detail(s));
    return renderPage(createElement(SessionView), { qc, path: `/s/${s.id}`, route: '/s/:id' });
  };

  it('desktop: a running session shows its prompt in the right-hand panel, above Details', () => {
    const html = sessionPage(session({ initial_prompt: LONG }));
    const aside = html.slice(html.indexOf('<aside'));
    expect(aside).toContain('<aside');
    const text = textOf(aside);
    expect(text.indexOf('Prompt')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Prompt')).toBeLessThan(text.indexOf('Details'));
    expect(text).toContain('Step 1:');
    expect(text).toContain('Show more');
    // the chat itself does not carry the panel's copy
    expect(textOf(html.slice(0, html.indexOf('<aside')))).not.toContain('Show more');
  });

  it('a session with no prompt has no Prompt section', () => {
    const text = textOf(sessionPage(session({ initial_prompt: '', kind: 'planner' })));
    expect(text).not.toContain('Prompt');
    expect(text).toContain('Details');
  });

  it('phone: no panel and no prompt section', () => {
    screen.wide = false;
    const html = sessionPage(session({ initial_prompt: LONG }));
    expect(html).not.toContain('<aside');
    expect(textOf(html)).not.toMatch(/\bPrompt\b|Show more/);
  });
});

describe('a plan the owner can read and answer on a phone (DISP-114)', () => {
  const PLAN = '# DISP-111 plan\n\nUnlinked PRs go in the existing PR table.\n\n- A 5-minute sync plus refresh\n- A new PRs tab';
  const waiting = (payload: unknown): string => {
    screen.wide = false;
    const s = session({ status: 'waiting_input', force_plan: true });
    const qc = new QueryClient();
    const input = { id: 5, session_id: s.id, local_id: 'x', payload, answer: null, answered_at: null, expired: false, answered_by: null, delegated_to: null, created_at: s.created_at };
    qc.setQueryData(['session', s.id], { ...detail(s), events: [{ id: 1, seq: 1, session_id: s.id, created_at: s.created_at, body: { kind: 'input_request', input_id: 5 } }], inputs: [input] });
    return renderPage(createElement(SessionView), { qc, path: `/s/${s.id}`, route: '/s/:id' });
  };

  it('a plan approval shows the full plan text, with the buttons, and the reply box points to it', () => {
    const html = waiting({ kind: 'plan_approval', plan: PLAN });
    const text = textOf(html);
    expect(text).toContain('Unlinked PRs go in the existing PR table.');
    expect(text).toContain('A new PRs tab');
    expect(text).toContain('Approve');
    expect(text).toContain('Request changes');
    expect(html).toContain('placeholder="Answer the question above first"');
    expect(text).toContain('Go to the plan');
  });

  it('a question has its own card and the reply box points to it', () => {
    const html = waiting({ kind: 'question', questions: [{ question: 'Approve the plan?', header: 'Plan', options: [{ label: 'Yes', description: '' }], multiSelect: false }] });
    expect(html).toContain('id="input-5"');
    expect(textOf(html)).toContain('Go to the question');
  });

  it('the prompt of a plan-first session asks for the whole plan in ExitPlanMode, not a file path', async () => {
    const { workPrompt } = await import('../src/worker/prompts.ts');
    const spec = { session_id: 7, kind: 'work' as const, project_key: 'P', project_name: 'P', importance_scale: [], effort_scale: [], title: 't', branch: 'b', repos: [], items: [], source: null, prompt: '', force_plan: true, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: null, resume: null, resume_note: null };
    const text = workPrompt(spec as never);
    expect(text).toContain('ExitPlanMode with the whole plan');
    expect(text).toContain('Do not ask for approval of a plan with AskUserQuestion');
  });
});
