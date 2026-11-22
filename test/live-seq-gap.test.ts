// DISP-140: a live session event after a gap in seq must not hide the missing event for good.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { SessionDetail, SessionEvent } from '../web/src/api.ts';
import { stubBrowser } from './web-render.ts';

const ev = (seq: number): SessionEvent => ({ id: seq, session_id: 7, seq, body: { kind: 'assistant', text: `event ${seq}` }, created_at: '' }) as SessionEvent;
const detail = (events: SessionEvent[]) => ({ session: { id: 7 }, events, inputs: [] }) as unknown as SessionDetail;

let stream: { onmessage?: (m: { data: string }) => void; close(): void };
beforeEach(() => {
  stubBrowser();
  vi.stubGlobal('window', { ...window, setInterval: () => 0 });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal(
    'EventSource',
    class {
      constructor() {
        stream = this as never;
      }
      close() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('live session events after a reconnect (DISP-140)', () => {
  it('an event after a gap refetches the session, and the missing one shows', async () => {
    const { connectLive } = await import('../web/src/live.ts');
    const { fetchSession } = await import('../web/src/pages/Session.tsx');
    const qc = new QueryClient();
    qc.setQueryData(['session', 7], detail([ev(9), ev(10)]));
    const stop = connectLive(qc);
    const send = (e: SessionEvent) => stream.onmessage!({ data: JSON.stringify({ t: 'session_event', event: e }) });

    // seq 11 was written while the stream was down; 12 arrives live
    send(ev(12));
    expect(qc.getQueryData<SessionDetail>(['session', 7])!.events.map((e) => e.seq)).toEqual([9, 10]);
    expect(qc.getQueryState(['session', 7])!.isInvalidated).toBe(true);

    // opening the session refetches after the last seq it has, so 11 comes back
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe('/api/sessions/7?after=10');
      return new Response(JSON.stringify(detail([ev(11), ev(12)])), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    const d = await qc.fetchQuery({ queryKey: ['session', 7], queryFn: () => fetchSession(qc, 7) });
    expect(d.events.map((e) => e.seq)).toEqual([9, 10, 11, 12]);
    expect(fetch).toHaveBeenCalledOnce();

    // the next event in order is appended as before
    send(ev(13));
    expect(qc.getQueryData<SessionDetail>(['session', 7])!.events.map((e) => e.seq)).toEqual([9, 10, 11, 12, 13]);
    stop();
  });

  it('a refetch that raced with live events keeps only the ones that continue it', async () => {
    const { connectLive, withLive } = await import('../web/src/live.ts');
    const qc = new QueryClient();
    const stop = connectLive(qc);
    qc.setQueryData(['session', 7], detail([ev(20)])); // the session is open: its live events are kept (DISP-162)
    stream.onmessage!({ data: JSON.stringify({ t: 'session_event', event: ev(22) }) });
    expect(withLive(detail([ev(20)])).events.map((e) => e.seq)).toEqual([20]);
    expect(withLive(detail([ev(21)])).events.map((e) => e.seq)).toEqual([21, 22]);
    stop();
  });
});
