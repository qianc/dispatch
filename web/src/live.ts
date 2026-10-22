// Server-sent events → React Query cache.
import type { QueryClient } from '@tanstack/react-query';
import type { LiveEvent } from '../../src/shared/types.ts';
import type { AssistantChat, SessionDetail, SessionEvent } from './api.ts';

/** Recent live events per session, so a refetch that raced with them can't drop them. */
const recent = new Map<number, SessionEvent[]>();

export function withLive(d: SessionDetail): SessionDetail {
  const extra = recent.get(d.session.id) ?? [];
  const max = d.events.at(-1)?.seq ?? 0;
  const missing = extra.filter((e) => e.seq > max);
  return missing.length ? { ...d, events: [...d.events, ...missing] } : d;
}

/** False until the stream has delivered an event; queries poll while it is false (see main.tsx). */
export let liveHealthy = false;

export function connectLive(qc: QueryClient): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let retry: number | undefined;
  let last = Date.now();
  let hiddenAt = 0;

  const open = () => {
    clearTimeout(retry);
    es?.close();
    liveHealthy = false; // poll until this stream delivers something
    last = Date.now();
    es = new EventSource('/api/stream');
    es.onmessage = (m) => {
      last = Date.now();
      liveHealthy = true;
      apply(qc, JSON.parse(m.data) as LiveEvent);
    };
    es.onopen = () => qc.invalidateQueries(); // catch up on anything missed while offline
    es.onerror = () => {
      liveHealthy = false;
      es?.close();
      if (!stopped) retry = window.setTimeout(open, 3000);
    };
  };
  open();

  // iOS freezes a backgrounded app and kills its stream, yet the EventSource can still say OPEN.
  // Coming back: reconnect, and refetch what is on screen.
  const resume = () => {
    if (stopped || document.visibilityState !== 'visible') return;
    if (hiddenAt && Date.now() - hiddenAt > 2000) open();
    hiddenAt = 0;
    void qc.invalidateQueries();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else resume();
  };
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) hiddenAt = hiddenAt || 1; // restored from the back/forward cache
    resume();
  };
  const onOnline = () => {
    open();
    void qc.invalidateQueries();
  };
  // the server sends something at least every 25 s; a minute of silence means the stream is dead
  const watchdog = window.setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - last > 60_000) open();
  }, 15_000);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('online', onOnline);
  return () => {
    stopped = true;
    liveHealthy = false;
    clearTimeout(retry);
    clearInterval(watchdog);
    es?.close();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('online', onOnline);
  };
}

function apply(qc: QueryClient, e: LiveEvent) {
  switch (e.t) {
    case 'hello':
      return;
    case 'session_event': {
      const list = recent.get(e.event.session_id) ?? [];
      list.push(e.event);
      if (list.length > 300) list.shift();
      recent.set(e.event.session_id, list);
      qc.setQueryData<SessionDetail>(['session', e.event.session_id], (d) =>
        d && !d.events.some((x) => x.seq === e.event.seq) ? { ...d, events: [...d.events, e.event] } : d,
      );
      // a reply in the assistant chat: update the unread badge
      if ((e.event.body.kind === 'assistant' || e.event.body.kind === 'proposal') && qc.getQueryData<AssistantChat>(['assistant'])?.session_id === e.event.session_id) {
        qc.invalidateQueries({ queryKey: ['assistant'] });
      }
      return;
    }
    case 'session':
      qc.setQueryData<SessionDetail>(['session', e.session.id], (d) => (d ? { ...d, session: e.session } : d));
      qc.invalidateQueries({ queryKey: ['sessions'] });
      qc.invalidateQueries({ queryKey: ['inbox'] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      if (e.session.kind === 'assistant') qc.invalidateQueries({ queryKey: ['assistant'] });
      if (e.session.kind === 'discuss') qc.invalidateQueries({ queryKey: ['discuss'] });
      return;
    case 'input':
      qc.setQueryData<SessionDetail>(['session', e.input.session_id], (d) =>
        d ? { ...d, inputs: [...d.inputs.filter((i) => i.id !== e.input.id), e.input].sort((a, b) => a.id - b.id) } : d,
      );
      qc.invalidateQueries({ queryKey: ['inbox'] });
      return;
    case 'item':
      qc.invalidateQueries({ queryKey: ['items', e.item.project_id] });
      qc.invalidateQueries({ queryKey: ['item', e.item.id] });
      if (e.item.source_id) qc.invalidateQueries({ queryKey: ['source', e.item.source_id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      return;
    case 'project':
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['project', e.key] });
      return;
    case 'cleanup':
      qc.invalidateQueries({ queryKey: ['inbox'] });
      return;
    case 'notice':
      window.dispatchEvent(new CustomEvent('dispatch:notice', { detail: e.notice }));
      return;
    case 'pr':
      qc.invalidateQueries({ queryKey: ['session', e.pr.session_id] });
      qc.invalidateQueries({ queryKey: ['inbox'] });
      return;
  }
}
