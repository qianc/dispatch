// Server-sent events → React Query cache.
import type { QueryClient } from '@tanstack/react-query';
import type { LiveEvent } from '../../src/shared/types.ts';
import type { AssistantChat, PrDetail, SessionDetail, SessionEvent } from './api.ts';
import { prPageStale } from './prs.ts';
import { patchItemList } from './itemsCache.ts';

/** Recent live events per session, so a refetch that raced with them can't drop them. Only for sessions
 * whose query is in the cache, and only for a few minutes: a race is over long before that (DISP-162). */
const recent = new Map<number, { e: SessionEvent; at: number }[]>();
const RECENT_MS = 3 * 60_000;

/** Forget events older than RECENT_MS, and sessions left with none. */
function pruneRecent(now = Date.now()) {
  for (const [id, list] of recent) {
    const keep = list.filter((x) => now - x.at < RECENT_MS);
    if (keep.length) recent.set(id, keep);
    else recent.delete(id);
  }
}

/** Sessions with live events kept (for tests). */
export const recentSessions = () => [...recent.keys()];

export function withLive(d: SessionDetail): SessionDetail {
  const now = Date.now();
  const extra = (recent.get(d.session.id) ?? []).flatMap((x) => (now - x.at < RECENT_MS ? [x.e] : []));
  const max = d.events.at(-1)?.seq ?? 0;
  // only the ones that continue the list: a gap would hide the missing events from `?after=` (DISP-140)
  const missing: SessionEvent[] = [];
  for (const e of [...extra].sort((a, b) => a.seq - b.seq)) if (e.seq === max + missing.length + 1) missing.push(e);
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
      // signed out at a sign-in proxy? Then the app stops this stream (main.tsx) before the next try
      void qc.invalidateQueries({ queryKey: ['me'] });
      if (!stopped) retry = window.setTimeout(open, 3000);
    };
  };
  open();
  // a session's query gone from the cache (closed long enough ago): its live events are of no use
  const unwatch = qc.getQueryCache().subscribe((ev) => {
    const key = ev.query.queryKey;
    if (ev.type === 'removed' && key[0] === 'session') recent.delete(Number(key[1]));
  });

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
    pruneRecent();
    if (document.visibilityState === 'visible' && Date.now() - last > 60_000) open();
  }, 15_000);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('online', onOnline);
  return () => {
    stopped = true;
    liveHealthy = false;
    unwatch();
    recent.clear();
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
      // kept only while the session's query is cached: a tab open for days would keep every session's
      if (qc.getQueryCache().find({ queryKey: ['session', e.event.session_id], exact: true })) {
        const list = recent.get(e.event.session_id) ?? [];
        list.push({ e: e.event, at: Date.now() });
        if (list.length > 300) list.shift();
        recent.set(e.event.session_id, list);
      }
      // seq is contiguous per session: after a gap (events sent while the stream was down) refetch,
      // since the session's query asks only for events after the last one it has (DISP-140)
      let gap = false;
      qc.setQueryData<SessionDetail>(['session', e.event.session_id], (d) => {
        if (!d || d.events.some((x) => x.seq === e.event.seq)) return d;
        if (e.event.seq !== (d.events.at(-1)?.seq ?? 0) + 1) {
          gap = true;
          return d;
        }
        return { ...d, events: [...d.events, e.event] };
      });
      // a planning chat's proposal cards change what it needs from you (its attention, DISP-159)
      if (gap || e.event.body.kind === 'proposal' || e.event.body.kind === 'proposal_done') qc.invalidateQueries({ queryKey: ['session', e.event.session_id] });
      // a reply in the assistant chat: update the unread badge
      if ((e.event.body.kind === 'assistant' || e.event.body.kind === 'proposal') && qc.getQueryData<AssistantChat>(['assistant'])?.session_id === e.event.session_id) {
        qc.invalidateQueries({ queryKey: ['assistant'] });
      }
      return;
    }
    case 'session': {
      const before = qc.getQueryData<SessionDetail>(['session', e.session.id])?.session;
      qc.setQueryData<SessionDetail>(['session', e.session.id], (d) => (d ? { ...d, session: e.session } : d));
      // a failed session's reason and retry come with the detail (DISP-81); a sign-in it needs, with its attention (DISP-159)
      if (e.session.status === 'failed' || (before && JSON.stringify(before.login_needed) !== JSON.stringify(e.session.login_needed))) {
        qc.invalidateQueries({ queryKey: ['session', e.session.id] });
      }
      qc.invalidateQueries({ queryKey: ['sessions'] });
      qc.invalidateQueries({ queryKey: ['inbox'] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      if (e.session.kind === 'assistant') qc.invalidateQueries({ queryKey: ['assistant'] });
      if (e.session.kind === 'discuss') qc.invalidateQueries({ queryKey: ['discuss'] });
      if (e.session.schedule_id) qc.invalidateQueries({ queryKey: ['schedules', e.session.project_key] });
      return;
    }
    case 'input':
      qc.setQueryData<SessionDetail>(['session', e.input.session_id], (d) =>
        d ? { ...d, inputs: [...d.inputs.filter((i) => i.id !== e.input.id), e.input].sort((a, b) => a.id - b.id) } : d,
      );
      qc.invalidateQueries({ queryKey: ['inbox'] });
      return;
    case 'item':
      if (!patchItemList(qc, e.item)) qc.invalidateQueries({ queryKey: ['items', e.item.project_id] });
      qc.invalidateQueries({ queryKey: ['item', e.item.id] });
      if (e.item.source_id) qc.invalidateQueries({ queryKey: ['source', e.item.source_id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      return;
    case 'project':
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['project', e.key] });
      qc.invalidateQueries({ queryKey: ['schedules', e.key] });
      return;
    case 'cleanup':
      qc.invalidateQueries({ queryKey: ['inbox'] });
      return;
    case 'notice':
      window.dispatchEvent(new CustomEvent('dispatch:notice', { detail: e.notice }));
      return;
    case 'check':
      qc.setQueryData<SessionDetail>(['session', e.session_id], (d) => (d ? { ...d, checks: e.checks } : d));
      return;
    case 'orchestration':
      qc.setQueryData<SessionDetail>(['session', e.orchestration.session_id], (d) => (d ? { ...d, orchestration: e.orchestration } : d));
      // the orchestrator's attention comes from its orchestration (DISP-159)
      qc.invalidateQueries({ queryKey: ['session', e.orchestration.session_id] });
      qc.invalidateQueries({ queryKey: ['orchestrations'] });
      qc.invalidateQueries({ queryKey: ['inbox'] });
      return;
    case 'pr':
      if (e.pr.session_id !== null) qc.invalidateQueries({ queryKey: ['session', e.pr.session_id] });
      // its open page shows the diff it approves and merges: read it again when the branch moved on
      if (prPageStale(qc.getQueryData<PrDetail>(['pr', e.pr.id])?.pr, e.pr)) qc.invalidateQueries({ queryKey: ['pr', e.pr.id] });
      qc.invalidateQueries({ queryKey: ['inbox'] });
      qc.invalidateQueries({ queryKey: ['project-prs'] });
      return;
    case 'update':
      qc.invalidateQueries({ queryKey: ['update'] });
      return;
  }
}
