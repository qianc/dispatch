import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failureReason } from '../src/shared/attention.ts';
import { DEFAULT_RUN_OPTIONS, type FailedSession, type Session } from '../src/shared/types.ts';
import { liveGroups, waitingCount } from '../web/src/activity.ts';
import type { Inbox, SessionDetail } from '../web/src/api.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

const screen = vi.hoisted(() => ({ wide: true }));
vi.mock('../web/src/wide.ts', () => ({ useWide: () => screen.wide, useVeryWide: () => screen.wide }));

let SessionView: typeof import('../web/src/pages/Session.tsx').SessionView;
beforeEach(async () => {
  vi.resetModules();
  stubBrowser();
  screen.wide = true;
  ({ SessionView } = await import('../web/src/pages/Session.tsx'));
});
afterEach(() => vi.unstubAllGlobals());

const LOGIN = { account: 'work', label: 'Work', kind: 'subscription', config_dir: '/tmp/claude-work', command: 'claude', fix: null, error: 'authentication_failed', host: 'box', worker: 'box' } as unknown as NonNullable<Session['login_needed']>;

const session = (over: Partial<Session> = {}): Session => ({
  id: 7, project_id: 1, project_key: 'P', kind: 'work', title: 'Fix login', status: 'failed', force_plan: false, branch: 'dispatch/p-7-fix', sdk_session_id: null,
  initial_prompt: 'Fix the login bug', source_id: null, waiting_reason: null, last_text: null, usage: null, options: DEFAULT_RUN_OPTIONS, claude_account: null, worker_id: 1,
  paused: false, pending_prompt: null, moved_from: null, item_ids: [], release: null, schedule_id: null, login_needed: null, started_by: null, github_login: null,
  closed_at: null, closed_reason: null, retry_of: null, about_session: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:01:00Z', ...over,
});
const REASON = 'GitHub is not signed in on this worker';
const page = (s: Session, failure: SessionDetail['failure'] = { reason: REASON, retried_as: null, discussion: null }) => {
  const qc = new QueryClient();
  qc.setQueryData(['session', s.id], { session: s, events: [], inputs: [], items: [], prs: [], repos: [], source: null, project: null, failure } satisfies SessionDetail);
  return renderPage(createElement(SessionView), { qc, path: `/s/${s.id}`, route: '/s/:id' });
};
const BUTTONS = /Mark as ignored.*What would fix the issue\?.*I've fixed it, please retry/;

describe('a failed session in Needs you (DISP-81)', () => {
  const failed = (id: number, reason: string): FailedSession => ({ ...session({ id, title: `S${id}` }), reason });
  const inbox = (f: FailedSession[]): Inbox => ({ inputs: [], idle: [], failed: f, prs: [], sessions: [], cleanup: null });

  it('is listed in Needs you with a red dot and its reason, and counts as waiting', () => {
    const g = liveGroups([], inbox([failed(3, REASON)]));
    expect(g.needs).toEqual([{ id: 3, key: 'P', title: 'S3', tone: 'bad', reason: REASON }]);
    expect(waitingCount(inbox([failed(3, REASON), failed(4, 'x')]))).toBe(2);
    // an older server sends no failed list
    expect(liveGroups([], { inputs: [], idle: [], prs: [], sessions: [], cleanup: null }).needs).toEqual([]);
  });

  it('the reason is short: a login problem, else the first line of the last error, else Claude\'s last message', () => {
    expect(failureReason(session({ login_needed: LOGIN }), 'whatever')).toBe('Work account needs sign-in on box.');
    expect(failureReason(session(), `\n  ${REASON}\nstack trace…`)).toBe(REASON);
    expect(failureReason(session(), 'x'.repeat(300))).toHaveLength(140);
    expect(failureReason(session({ last_text: 'I could not push.' }), null)).toBe('I could not push.');
    expect(failureReason(session(), null)).toBe('The session failed.');
  });
});

describe('a failed session\'s page shows its actions (DISP-81)', () => {
  it('phone: the reason and the three buttons, in order, in the chat', () => {
    screen.wide = false;
    const html = page(session());
    expect(html).not.toContain('<aside');
    const text = textOf(html);
    expect(text).toContain(`Failed: ${REASON}`);
    expect(text).toMatch(BUTTONS);
  });

  it('desktop: the reason and the three buttons in the side panel, once', () => {
    const html = page(session());
    const aside = textOf(html.slice(html.indexOf('<aside')));
    expect(aside).toContain(REASON);
    expect(aside).toMatch(BUTTONS);
    expect(textOf(html).match(/Mark as ignored/g)).toHaveLength(1);
  });

  it('a login failure keeps the sign-in steps, with Retry next to them', () => {
    for (const wide of [false, true]) {
      screen.wide = wide;
      const text = textOf(page(session({ login_needed: LOGIN }), { reason: 'Work account needs sign-in on box.', retried_as: null, discussion: null }));
      expect(text, `wide ${wide}`).toMatch(/sign/i);
      expect(text.indexOf('I\'ve fixed it, please retry'), `wide ${wide}`).toBeGreaterThan(text.search(/claude-work|sign in/i));
      expect(text, `wide ${wide}`).toMatch(BUTTONS);
    }
  });

  it('ignored: it can be shown in Needs you again; retried: a link to the retry, no buttons', () => {
    screen.wide = false;
    const ignored = textOf(page(session({ closed_reason: 'ignored', closed_at: '2026-01-02T00:00:00Z' })));
    expect(ignored).toContain('Show in Needs you again');
    expect(ignored).not.toContain('Mark as ignored');
    const retried = page(session({ closed_reason: 'retried', closed_at: '2026-01-02T00:00:00Z' }), { reason: REASON, retried_as: 9, discussion: null });
    expect(textOf(retried)).toContain('Retried in #9');
    expect(retried).toContain('href="/s/9"');
    expect(textOf(retried)).not.toMatch(/Mark as ignored|please retry/);
  });

  it('a retry links back to the session it retries', () => {
    const html = page(session({ id: 9, status: 'running', retry_of: 7 }), null);
    expect(html).toContain('href="/s/7"');
    expect(textOf(html)).toContain('Retry of #7');
    expect(textOf(html)).not.toContain('Mark as ignored');
  });
});
