// DISP-162: a session page loads its last events, "Show earlier" the ones before; the live buffer keeps only what is in use.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import type { SessionDetail, SessionEvent } from '../web/src/api.ts';
import { startServer } from './helpers.ts';
import { stubBrowser } from './web-render.ts';

describe('GET /api/sessions/:id pages its events (DISP-162)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let id: number;
  const get = async (q: string) => (await s.call<SessionDetail>('GET', `/sessions/${id}${q}`));
  const seqs = (d: SessionDetail) => d.events.map((e) => e.seq);

  beforeAll(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'PG', name: 'Paging' });
    const project = s.ctx.store.projectByKey('PG')!;
    id = s.ctx.store.createSession({
      project_id: project.id, kind: 'work', title: 'Long', status: 'idle', force_plan: false, branch: 'dispatch/pg-1', initial_prompt: '', source_id: null,
      item_ids: [], worker_id: s.ctx.workers.legacy().id, started_by: null, options: { ...DEFAULT_RUN_OPTIONS },
    }).id;
    for (let i = 1; i <= 5000; i++) s.ctx.store.addEvent(id, { kind: 'assistant', text: `event ${i}` });
  });
  afterAll(() => s.app.close());

  it('?limit=N is the last N events, and says there are earlier ones', async () => {
    const d = (await get('?limit=300')).data;
    expect(d.events).toHaveLength(300);
    expect(seqs(d)[0]).toBe(4701);
    expect(seqs(d).at(-1)).toBe(5000);
    expect(d.earlier).toBe(true);
  });

  it('?before=<seq>&limit=N is the N before it; the first page says there are none earlier', async () => {
    const d = (await get('?before=4701&limit=300')).data;
    expect(seqs(d)[0]).toBe(4401);
    expect(seqs(d).at(-1)).toBe(4700);
    expect(d.earlier).toBe(true);
    const first = (await get('?before=201&limit=300')).data;
    expect(seqs(first)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(first.earlier).toBe(false);
  });

  it('?after=<seq> still gives every newer event, whatever the limit (the poll and the gap refetch, DISP-140)', async () => {
    expect(seqs((await get('?after=4990')).data)).toEqual([4991, 4992, 4993, 4994, 4995, 4996, 4997, 4998, 4999, 5000]);
    expect((await get('?after=10&limit=5')).data.events).toHaveLength(4990);
    // no paging asked for: all of them, as before
    expect((await get('')).data.events).toHaveLength(5000);
  });

  it('refuses a bad limit', async () => {
    expect((await get('?limit=0')).status).toBe(400);
    expect((await get('?limit=abc')).status).toBe(400);
  });
});

const ev = (seq: number, session = 7): SessionEvent => ({ id: seq, session_id: session, seq, body: { kind: 'assistant', text: `event ${seq}` }, created_at: '' }) as SessionEvent;
const detail = (events: SessionEvent[], extra: Partial<SessionDetail> = {}) => ({ session: { id: 7 }, events, inputs: [], ...extra }) as unknown as SessionDetail;
const json = (d: unknown) => new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } });

describe('the session page loads the last events (DISP-162)', () => {
  beforeEach(() => stubBrowser());
  afterEach(() => vi.unstubAllGlobals());

  it('opens with ?limit=N, polls with ?after=, and Show earlier puts the earlier page in front', async () => {
    const { fetchSession, fetchEarlier, EVENT_PAGE } = await import('../web/src/pages/Session.tsx');
    const qc = new QueryClient();
    const urls: string[] = [];
    const reply = vi.fn<(url: string) => SessionDetail>();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return json(reply(url)); }));

    reply.mockReturnValueOnce(detail([ev(4999), ev(5000)], { earlier: true }));
    await qc.fetchQuery({ queryKey: ['session', 7], queryFn: () => fetchSession(qc, 7) });
    expect(urls.at(-1)).toBe(`/api/sessions/7?limit=${EVENT_PAGE}`);

    reply.mockReturnValueOnce(detail([ev(5001)], { earlier: false }));
    let d = await qc.fetchQuery({ queryKey: ['session', 7], queryFn: () => fetchSession(qc, 7) });
    expect(urls.at(-1)).toBe('/api/sessions/7?after=5000');
    expect(d.events.map((e) => e.seq)).toEqual([4999, 5000, 5001]);
    expect(d.earlier).toBe(true); // a poll does not know about earlier events: the first page's word stands

    reply.mockReturnValueOnce(detail([ev(4997), ev(4998)], { earlier: false }));
    await fetchEarlier(qc, 7);
    expect(urls.at(-1)).toBe(`/api/sessions/7?before=4999&limit=${EVENT_PAGE}`);
    d = qc.getQueryData<SessionDetail>(['session', 7])!;
    expect(d.events.map((e) => e.seq)).toEqual([4997, 4998, 4999, 5000, 5001]);
    expect(d.earlier).toBe(false);
  });
});

describe('the live buffer keeps events only for cached sessions (DISP-162)', () => {
  let stream: { onmessage?: (m: { data: string }) => void; close(): void };
  beforeEach(() => {
    stubBrowser();
    vi.stubGlobal('window', { ...window, setInterval: () => 0 });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('EventSource', class { constructor() { stream = this as never; } close() {} });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const send = (e: SessionEvent) => stream.onmessage!({ data: JSON.stringify({ t: 'session_event', event: e }) });

  it('no entry for a session without a cached query', async () => {
    const { connectLive, recentSessions } = await import('../web/src/live.ts');
    const qc = new QueryClient();
    const stop = connectLive(qc);
    qc.setQueryData(['session', 7], detail([ev(1)]));
    send(ev(2));
    send(ev(1, 8)); // nobody has session 8 open
    expect(recentSessions()).toEqual([7]);
    stop();
  });

  it('drops the entry when the query is removed', async () => {
    const { connectLive, recentSessions, withLive } = await import('../web/src/live.ts');
    const qc = new QueryClient();
    const stop = connectLive(qc);
    qc.setQueryData(['session', 7], detail([ev(1)]));
    send(ev(2));
    expect(withLive(detail([ev(1)])).events.map((e) => e.seq)).toEqual([1, 2]);
    qc.removeQueries({ queryKey: ['session', 7] });
    expect(recentSessions()).toEqual([]);
    expect(withLive(detail([ev(1)])).events.map((e) => e.seq)).toEqual([1]);
    stop();
  });

  it('forgets events older than a few minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { connectLive, withLive } = await import('../web/src/live.ts');
    const qc = new QueryClient();
    const stop = connectLive(qc);
    qc.setQueryData(['session', 7], detail([ev(1)]));
    send(ev(2));
    vi.setSystemTime(Date.now() + 4 * 60_000);
    expect(withLive(detail([ev(1)])).events.map((e) => e.seq)).toEqual([1]);
    stop();
  });
});
