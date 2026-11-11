import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Session } from '../src/shared/types.ts';
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
  id: 7, project_id: 1, project_key: 'P', kind: 'work', title: 'Fix login', status: 'running', force_plan: false, branch: 'dispatch/p-7-fix', sdk_session_id: null,
  initial_prompt: 'Fix the login bug', source_id: null, waiting_reason: null, last_text: null, usage: null, options: DEFAULT_RUN_OPTIONS, claude_account: null, worker_id: 1,
  paused: false, pending_prompt: null, moved_from: null, item_ids: [], release: null, schedule_id: null, login_needed: null, started_by: null, github_login: null, closed_at: null, closed_reason: null, retry_of: null, about_session: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ended_at: null, ...over,
});
const detail = (s: Session): SessionDetail => ({ session: s, events: [], inputs: [], items: [], prs: [], repos: [], source: null, project: null });

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
