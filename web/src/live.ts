// Server-sent events → React Query cache.
import type { QueryClient } from '@tanstack/react-query';
import type { LiveEvent } from '../../src/shared/types.ts';
import type { SessionDetail, SessionEvent } from './api.ts';

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

  const open = () => {
    es = new EventSource('/api/stream');
    es.onmessage = (m) => {
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
  const onVisible = () => {
    if (document.visibilityState === 'visible' && es?.readyState !== EventSource.OPEN) {
      es?.close();
      open();
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    stopped = true;
    liveHealthy = false;
    clearTimeout(retry);
    es?.close();
    document.removeEventListener('visibilitychange', onVisible);
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
      return;
    }
    case 'session':
      qc.setQueryData<SessionDetail>(['session', e.session.id], (d) => (d ? { ...d, session: e.session } : d));
      qc.invalidateQueries({ queryKey: ['sessions'] });
      qc.invalidateQueries({ queryKey: ['inbox'] });
      qc.invalidateQueries({ queryKey: ['projects'] });
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
    case 'pr':
      qc.invalidateQueries({ queryKey: ['session', e.pr.session_id] });
      qc.invalidateQueries({ queryKey: ['inbox'] });
      return;
  }
}
