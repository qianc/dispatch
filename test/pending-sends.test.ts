import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../src/shared/types.ts';
import type * as Pending from '../web/src/pendingSends.ts';
import { stubBrowser, textOf } from './web-render.ts';

vi.mock('../web/src/wide.ts', () => ({ useWide: () => true, useVeryWide: () => false }));

let P: typeof Pending;
let PendingMessages: typeof import('../web/src/components/PendingMessages.tsx').PendingMessages;
beforeEach(async () => {
  vi.resetModules();
  stubBrowser();
  vi.useFakeTimers();
  P = await import('../web/src/pendingSends.ts');
  ({ PendingMessages } = await import('../web/src/components/PendingMessages.tsx'));
});
afterEach(() => {
  P.resetPending();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A request the test answers when it wants to. */
function deferred() {
  const calls: { body: Pending.SendBody; resolve: (r?: { chat?: string }) => void; reject: (e: Error) => void }[] = [];
  const post: Pending.Post = (body) => new Promise((resolve, reject) => calls.push({ body, resolve, reject }));
  return { calls, post };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
const userEvent = (seq: number, text: string, client_id?: string): SessionEvent =>
  ({ id: seq, session_id: 1, seq, created_at: '2026-01-01T00:00:00Z', body: { kind: 'user', text, ...(client_id ? { client_id } : {}) } });
const render = (chat: string) => textOf(renderToStaticMarkup(createElement(PendingMessages, { pending: P.pendingOf(chat), onEdit: () => {} })));

describe('a message shows at once and the chat stays usable (DISP-83)', () => {
  it('shows a sent message at once with a Sending mark, before the server answers', async () => {
    const { calls, post } = deferred();
    const id = P.sendPending('session:1', { text: 'Hello' }, post);
    expect(P.pendingOf('session:1')).toMatchObject([{ client_id: id, text: 'Hello', state: 'sending' }]);
    expect(render('session:1')).toBe('Hello Sending…');
    await flush();
    expect(calls[0].body).toEqual({ text: 'Hello', images: [], client_id: id, project_keys: [] });
    calls[0].resolve();
    await flush();
    // the server has it: a normal bubble until its event arrives
    expect(P.pendingOf('session:1')[0].state).toBe('sent');
    expect(render('session:1')).toBe('Hello');
    P.reconcile('session:1', [userEvent(1, 'Hello', id)]);
    expect(P.pendingOf('session:1')).toEqual([]);
  });

  it('says "Still sending" when the server is slow, and takes the next message meanwhile', async () => {
    const { calls, post } = deferred();
    P.sendPending('session:1', { text: 'one' }, post);
    await vi.advanceTimersByTimeAsync(P.SLOW_MS);
    expect(render('session:1')).toBe('one Still sending');
    // a second message is shown at once; it is sent once the first is answered, so the order holds
    P.sendPending('session:1', { text: 'two' }, post);
    await flush();
    expect(P.pendingOf('session:1').map((p) => [p.text, p.state])).toEqual([['one', 'slow'], ['two', 'sending']]);
    expect(calls.map((c) => c.body.text)).toEqual(['one']);
    calls[0].resolve();
    await flush();
    expect(calls.map((c) => c.body.text)).toEqual(['one', 'two']);
  });

  it('keeps a message that was not sent, with its images, Not sent and Retry; a retry has the same client id', async () => {
    const { calls, post } = deferred();
    const images = [{ file: 'a.png', preview: 'blob:a' }];
    const id = P.sendPending('session:1', { text: 'See this', images }, post);
    await flush();
    calls[0].reject(new Error('Network error'));
    await flush();
    expect(P.pendingOf('session:1')).toMatchObject([{ text: 'See this', images, state: 'failed', error: 'Network error' }]);
    const html = renderToStaticMarkup(createElement(PendingMessages, { pending: P.pendingOf('session:1'), onEdit: () => {} }));
    expect(textOf(html)).toBe('See this Not sent: Network error Retry Edit');
    expect(html).toContain('src="blob:a"');
    P.retryPending(id);
    await flush();
    expect(P.pendingOf('session:1')[0].state).toBe('sending');
    expect(calls[1].body).toEqual({ text: 'See this', images: ['a.png'], client_id: id, project_keys: [] });
  });

  it('Edit takes a message that was not sent off the chat and gives back its text and images', async () => {
    const { calls, post } = deferred();
    const id = P.sendPending('session:1', { text: 'typo', images: [{ file: 'a.png', preview: 'blob:a' }] }, post);
    await flush();
    calls[0].reject(new Error('x'));
    await flush();
    expect(P.editPending(id)).toMatchObject({ text: 'typo', images: [{ file: 'a.png' }] });
    expect(P.pendingOf('session:1')).toEqual([]);
  });

  it('the first message of a new chat moves to the chat, with the messages sent after it', async () => {
    const { calls, post } = deferred();
    P.sendPending('assistant:new', { text: 'first' }, post);
    P.sendPending('assistant:new', { text: 'second' }, post);
    await flush();
    calls[0].resolve({ chat: 'session:9' });
    await flush();
    expect(P.pendingOf('assistant:new')).toEqual([]);
    expect(P.pendingOf('session:9').map((p) => [p.text, p.state])).toEqual([['first', 'sent'], ['second', 'sending']]);
  });

  it('a stored message without a client id does not drop a pending one', () => {
    const { post } = deferred();
    P.sendPending('session:1', { text: 'Hello' }, post);
    P.reconcile('session:1', [userEvent(1, 'Hello')]);
    expect(P.pendingOf('session:1')).toHaveLength(1);
  });
});

describe('the chat screen while a message is pending (DISP-83)', () => {
  it('shows the pending message and keeps the box usable while the chat has not started', async () => {
    const { QueryClient } = await import('@tanstack/react-query');
    const { DEFAULT_RUN_OPTIONS } = await import('../src/shared/types.ts');
    const { SessionView } = await import('../web/src/pages/Session.tsx');
    const { renderPage } = await import('./web-render.ts');
    const s = {
      id: 7, project_id: null, project_key: null, kind: 'assistant', title: 'Assistant', status: 'queued', force_plan: false, branch: null, sdk_session_id: null,
      initial_prompt: 'one', source_id: null, waiting_reason: null, last_text: null, usage: null, options: DEFAULT_RUN_OPTIONS, claude_account: null, worker_id: 1,
      paused: false, pending_prompt: null, moved_from: null, item_ids: [], release: null, schedule_id: null, login_needed: null, started_by: null, github_login: null,
      closed_at: null, closed_reason: null, retry_of: null, about_session: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ended_at: null,
    };
    const qc = new QueryClient();
    qc.setQueryData(['session', 7], { session: s, events: [userEvent(1, 'one', 'c-1')], inputs: [], items: [], prs: [], repos: [], source: null, project: null, failure: null, access: { drive: true, stop: true } });
    P.sendPending('session:7', { text: 'two' }, () => new Promise(() => {}));
    const html = renderPage(createElement(() => SessionView({ chat: { id: 7, title: 'Assistant', subtitle: '', onNew: () => {} } })), { qc });
    expect(textOf(html)).toMatch(/one .*two Sending…/);
    expect(html.match(/<textarea[^>]*>/)![0]).not.toContain(' disabled=""');
  });
});
