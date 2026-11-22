// DISP-159: the session page shows what the inbox shows for it, also while a PR of it is being merged.
import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type LiveEvent } from '../src/shared/types.ts';
import type { Inbox, SessionDetail } from '../web/src/api.ts';
import { startServer } from './helpers.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

vi.mock('../web/src/wide.ts', () => ({ useWide: () => true, useVeryWide: () => true }));
afterEach(() => vi.unstubAllGlobals());

describe('the attention of a session whose PR is being merged (DISP-159)', () => {
  it('the session detail says merging, as the inbox does, and its page offers no Review & merge', async () => {
    const s = await startServer();
    await s.call('POST', '/projects', { key: 'MG', name: 'Merging' });
    await s.call('POST', '/projects/MG/repos', { github_owner: 'me', github_name: 'mg' });
    const project = s.ctx.store.projectByKey('MG')!;
    const session = s.ctx.store.createSession({
      project_id: project.id, kind: 'work', title: 'Merge me', status: 'idle', force_plan: false, branch: 'dispatch/mg-1', initial_prompt: '', source_id: null,
      item_ids: [], worker_id: s.ctx.workers.legacy().id, started_by: null, options: { ...DEFAULT_RUN_OPTIONS },
    });
    const pr = s.ctx.store.upsertPr({
      session_id: session.id, repo_id: s.ctx.store.repos(project.id)[0].id, number: 3, url: 'https://github.com/me/mg/pull/3', title: 't', state: 'open',
      mergeable: true, mergeable_state: 'clean', head_ref: 'dispatch/mg-1', head_sha: 'sha3',
    });
    const detail = async () => (await s.call<SessionDetail>('GET', `/sessions/${session.id}`)).data;
    const inbox = async () => (await s.call<Inbox>('GET', '/inbox')).data.idle.find((i) => i.id === session.id)!.attention;
    expect((await detail()).attention).toMatchObject({ kind: 'review', pr_id: pr.id });

    // the merge is under way: hold it there and look at both
    const prEvents: LiveEvent[] = [];
    s.ctx.bus.on((e) => { if (e.t === 'pr') prEvents.push(e); });
    let during: [SessionDetail, Inbox['idle'][number]['attention']] | undefined;
    (s.ctx.github as unknown as { mergeOpen: () => Promise<{ ok: boolean }> }).mergeOpen = async () => {
      during = [await detail(), await inbox()];
      return { ok: false };
    };
    await s.ctx.github.merge(pr.id, 'github', 'squash');
    const [mid, fromInbox] = during!;
    expect(mid.attention).toEqual({ kind: 'merging', pr_id: pr.id, text: 'Merging PR #3.' });
    expect(mid.attention).toEqual(fromInbox);
    // the page reads it again on the PR events at the start and the end of the merge (live.ts)
    expect(prEvents).toHaveLength(2);
    const after = await detail();
    expect(after.attention.kind).toBe('review');

    stubBrowser();
    const { SessionView } = await import('../web/src/pages/Session.tsx');
    const page = (d: SessionDetail) => {
      const qc = new QueryClient();
      qc.setQueryData(['session', session.id], d);
      return textOf(renderPage(createElement(SessionView), { qc, path: `/s/${session.id}`, route: '/s/:id' }));
    };
    expect(page(mid)).not.toContain('Review & merge');
    expect(page(after)).toContain('Review & merge');
    await s.app.close();
  });

  it('live updates read the session again when its attention may have changed', async () => {
    stubBrowser();
    vi.stubGlobal('window', { ...window, setInterval: () => 0 });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} });
    let stream!: { onmessage(m: { data: string }): void };
    vi.stubGlobal('EventSource', class { constructor() { stream = this as never; } close() {} });
    const { connectLive } = await import('../web/src/live.ts');
    const qc = new QueryClient();
    const stop = connectLive(qc);
    const stale = (e: unknown) => {
      qc.setQueryData(['session', 7], { session: { id: 7, login_needed: null }, events: [], inputs: [] });
      stream.onmessage({ data: JSON.stringify(e) });
      return qc.getQueryState(['session', 7])!.isInvalidated;
    };
    // a merge starts or ends
    expect(stale({ t: 'pr', pr: { id: 1, session_id: 7, state: 'open' } })).toBe(true);
    // a planning chat's proposal card
    expect(stale({ t: 'session_event', event: { id: 1, session_id: 7, seq: 1, body: { kind: 'proposal', proposal: { type: 'items', items: [] } } } })).toBe(true);
    expect(stale({ t: 'session_event', event: { id: 1, session_id: 7, seq: 1, body: { kind: 'assistant', text: 'hi' } } })).toBe(false);
    // a sign-in it needs
    expect(stale({ t: 'session', session: { id: 7, login_needed: { label: 'Work' }, status: 'idle', kind: 'work' } })).toBe(true);
    expect(stale({ t: 'session', session: { id: 7, login_needed: null, status: 'idle', kind: 'work' } })).toBe(false);
    stop();
  });
});
