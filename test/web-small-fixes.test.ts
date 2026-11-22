// DISP-213, DISP-214, DISP-216: a deleted item leaves the list, a refused pairing says why, "Show earlier" keeps one range.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import type { Item, SessionDetail, SessionEvent } from '../web/src/api.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

beforeEach(() => stubBrowser());
afterEach(() => vi.unstubAllGlobals());

describe('a deleted item leaves the project list at once (DISP-213)', () => {
  it('takes it out of every cached list of its project and refetches the lists and the project counts', async () => {
    const { dropDeletedItem } = await import('../web/src/itemsCache.ts');
    const qc = new QueryClient();
    const item = (id: number) => ({ id, project_id: 3 }) as Item;
    qc.setQueryData(['items', 3], [item(1), item(2)]);
    qc.setQueryData(['items', 3, 'open'], [item(1), item(2)]);
    qc.setQueryData(['items', 4], [item(1)]); // another project's list is not touched
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    dropDeletedItem(qc, item(1));

    expect(qc.getQueryData<Item[]>(['items', 3])!.map((i) => i.id)).toEqual([2]);
    expect(qc.getQueryData<Item[]>(['items', 3, 'open'])!.map((i) => i.id)).toEqual([2]);
    expect(qc.getQueryData<Item[]>(['items', 4])!.map((i) => i.id)).toEqual([1]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['items', 3] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });
});

describe('a refused pairing shows its message and a retry (DISP-214)', () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('reads a 429 as an error with the server message, not as a code', async () => {
    const { readStart } = await import('../web/src/pages/Pair.tsx');
    expect(await readStart(res(429, { error: 'Too many pairing requests. Try again in a minute.' }))).toEqual({ error: 'Too many pairing requests. Try again in a minute.' });
    expect(await readStart(new Response('busy', { status: 503 }))).toEqual({ error: 'Dispatch answered 503.' });
    expect(await readStart(res(200, { pair_id: 'p1', code: 'ABCD', expires_at: '' }))).toEqual({ pair_id: 'p1', code: 'ABCD' });
    expect(await readStart(res(200, { authed: true }))).toEqual({ authed: true });
  });

  it('the error screen shows the message and a Try again button', async () => {
    const { PairScreen } = await import('../web/src/pages/Pair.tsx');
    const text = textOf(renderPage(createElement(PairScreen, { state: 'error', code: null, error: 'The pairing queue is full.', onAgain: () => {} })));
    expect(text).toContain('The pairing queue is full.');
    expect(text).toContain('Try again');
  });
});

const ev = (seq: number): SessionEvent => ({ id: seq, session_id: 7, seq, body: { kind: 'assistant', text: `event ${seq}` }, created_at: '' }) as SessionEvent;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));
const detail = (events: SessionEvent[], extra: Partial<SessionDetail> = {}) => ({ session: { id: 7 }, events, inputs: [], ...extra }) as unknown as SessionDetail;
const json = (d: unknown) => new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } });

describe('"Show earlier" does not glue two ranges together (DISP-216)', () => {
  it('drops the earlier page when the cache was replaced while it loaded', async () => {
    const { fetchEarlier } = await import('../web/src/pages/Session.tsx');
    const qc = new QueryClient();
    qc.setQueryData(['session', 7], detail(range(5000, 5300), { earlier: true }));
    vi.stubGlobal('fetch', vi.fn(async () => {
      // the phone woke meanwhile: the DISP-184 refetch put the last page in place of the window
      qc.setQueryData(['session', 7], detail(range(9701, 10000), { earlier: true }));
      return json(detail(range(4700, 4999), { earlier: true }));
    }));

    await fetchEarlier(qc, 7);

    const d = qc.getQueryData<SessionDetail>(['session', 7])!;
    expect(d.events[0].seq).toBe(9701);
    expect(d.events).toHaveLength(300);
    expect(d.earlier).toBe(true);
  });
});
