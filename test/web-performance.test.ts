// DISP-247: refetch storms (finding 54), full item lists (61) and full transcript redraws (62).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { LiveEvent } from '../src/shared/types.ts';
import type { Inbox, Session, SessionDetail, SessionEvent } from '../web/src/api.ts';
import { stubBrowser } from './web-render.ts';
import { startServer } from './helpers.ts';

beforeEach(() => stubBrowser());
afterEach(() => vi.unstubAllGlobals());

const session = (over: Partial<Session> = {}) => ({ id: 7, status: 'running', title: 'Work', last_text: null, usage: null, ...over }) as Session;
const ev = (seq: number, body: SessionEvent['body'] = { kind: 'assistant', text: `event ${seq}` }): SessionEvent => ({ id: seq, session_id: 7, seq, body, created_at: '' }) as SessionEvent;

describe('a working agent does not refetch the lists per event (finding 54)', () => {
  it('a new message patches the lists in place; a status change refetches them', async () => {
    const { apply } = await import('../web/src/live.ts');
    const qc = new QueryClient();
    const fetched: string[] = [];
    // the lists a tab has on screen: active queries that count their fetches
    const watch = (key: unknown[], data: unknown) => {
      qc.setQueryData(key, data);
      new QueryObserver(qc, { queryKey: key, staleTime: Infinity, queryFn: () => { fetched.push(key.join('/')); return data; } }).subscribe(() => undefined);
    };
    watch(['sessions', 'live'], [session()]);
    watch(['inbox'], { inputs: [], idle: [], failed: [], prs: [], sessions: [session()] });
    watch(['projects'], []);
    const send = (s: Session) => apply(qc, { t: 'session', session: s } as LiveEvent);

    send(session()); // first sight of it: refetched once
    await vi.waitFor(() => expect(fetched).toHaveLength(3));
    await vi.waitFor(() => expect(qc.isFetching()).toBe(0));
    for (let i = 0; i < 20; i++) send(session({ last_text: `step ${i}`, usage: { cost_usd: i } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetched).toHaveLength(3);
    expect(qc.getQueryData<Session[]>(['sessions', 'live'])![0].last_text).toBe('step 19');
    expect(qc.getQueryData<Inbox>(['inbox'])!.sessions[0].last_text).toBe('step 19');

    send(session({ status: 'idle', last_text: 'done' }));
    await vi.waitFor(() => expect(fetched).toHaveLength(6));
  });

  it('Activity asks for the recent sessions it shows, not 200', async () => {
    const s = await startServer();
    try {
      await s.call('POST', '/projects', { key: 'LM', name: 'LM' });
      const p = s.ctx.store.projectByKey('LM')!;
      for (let i = 0; i < 5; i++) {
        s.ctx.store.createSession({ started_by: null, worker_id: s.ctx.store.defaultWorkerId(), project_id: p.id, kind: 'work', title: `s${i}`, status: 'completed', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [] });
      }
      expect((await s.call<Session[]>('GET', '/sessions?status=completed&limit=2')).data).toHaveLength(2);
      expect((await s.call<Session[]>('GET', '/sessions?status=completed')).data).toHaveLength(5);
      expect((await s.call('GET', '/sessions?limit=0')).status).toBe(400);
    } finally {
      await s.app.close();
    }
  });
});

describe('cards and anchors load only the items they show (finding 61)', () => {
  it('?ids= gives those items of the project, ?slug= the one an anchor names', async () => {
    const s = await startServer();
    try {
      await s.call('POST', '/projects', { key: 'ID', name: 'ID' });
      await s.call('POST', '/projects', { key: 'OT', name: 'OT' });
      const a = (await s.call('POST', '/projects/ID/items', { title: 'Login breaks' })).data;
      await s.call('POST', '/projects/ID/items', { title: 'Other' });
      const c = (await s.call('POST', '/projects/ID/items', { title: 'Third' })).data;
      const foreign = (await s.call('POST', '/projects/OT/items', { title: 'Login breaks' })).data;
      const ids = (await s.call<{ id: number }[]>('GET', `/projects/ID/items?ids=${a.id},${c.id},${foreign.id}`)).data;
      expect(ids.map((i) => i.id)).toEqual([a.id, c.id]);
      expect((await s.call('GET', '/projects/ID/items?ids=')).data).toEqual([]);
      expect((await s.call<{ id: number }[]>('GET', '/projects/ID/items?slug=login-breaks')).data.map((i) => i.id)).toEqual([a.id]);
      expect((await s.call('GET', '/projects/ID/items?slug=nothing')).data).toEqual([]);
    } finally {
      await s.app.close();
    }
  });
});

describe('a long live transcript (finding 62)', () => {
  it('live events keep the last page of events, unless the page was paged back', async () => {
    const { apply, EVENT_PAGE, pagedBack } = await import('../web/src/live.ts');
    const qc = new QueryClient();
    const first = Array.from({ length: EVENT_PAGE }, (_, i) => ev(i + 1));
    qc.setQueryData(['session', 7], { session: session(), events: first, inputs: [], earlier: false } as unknown as SessionDetail);
    const send = (seq: number) => apply(qc, { t: 'session_event', event: ev(seq) } as LiveEvent);
    for (let seq = EVENT_PAGE + 1; seq <= 2000; seq++) send(seq);
    let d = qc.getQueryData<SessionDetail>(['session', 7])!;
    expect(d.events).toHaveLength(EVENT_PAGE);
    expect(d.events.at(-1)!.seq).toBe(2000);
    expect(d.earlier).toBe(true);

    pagedBack.add(7);
    send(2001);
    d = qc.getQueryData<SessionDetail>(['session', 7])!;
    expect(d.events).toHaveLength(EVENT_PAGE + 1);
    pagedBack.delete(7);
  });

  it('a new event redraws only the work group it joins', async () => {
    const { sameWork } = await import('../web/src/components/transcript.tsx');
    const use = (seq: number) => ev(seq, { kind: 'tool_use', tool_use_id: `t${seq}`, name: 'Bash', summary: 'ls', input: {} } as SessionEvent['body']);
    const result = (seq: number, of: number) => ev(seq, { kind: 'tool_result', tool_use_id: `t${of}`, text: 'ok', is_error: false } as SessionEvent['body']);
    const events = [use(1), result(2, 1), use(3)];
    const resultsOf = (list: SessionEvent[]) => new Map(list.flatMap((e) => (e.body.kind === 'tool_result' ? [[e.body.tool_use_id, e.body] as const] : [])));
    const props = (list: SessionEvent[], all = list) => ({ events: list, live: true, results: resultsOf(all), project: null, sourceId: null });
    const older = props(events.slice(0, 2));
    // a later event, in another group: the same group, as far as memo goes
    expect(sameWork(older, props([...events.slice(0, 2)], [...events, result(4, 3)]))).toBe(true);
    // its own tool call's result came: drawn again
    expect(sameWork(props(events), props([...events], [...events, result(4, 3)]))).toBe(false);
    expect(sameWork(older, props(events))).toBe(false);
    expect(sameWork(older, { ...older, live: false })).toBe(false);
  });
});
