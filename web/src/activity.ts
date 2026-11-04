import { waitsOnOwner } from '../../src/shared/attention.ts';
import type { Attention, Inbox, Session } from './api.ts';

export interface NeedsEntry { id: number; key: string | null; title: string; tone: 'wait' | 'bad' | 'ok' }
export interface RunningEntry { session: Session; attention?: Attention }

/**
 * The live sessions in groups, as the menu shows them: what needs you (open questions, idle
 * sessions that wait on you), what runs (including idle sessions that Dispatch checks or merges,
 * DISP-31), and what is queued.
 */
export function liveGroups(live: Session[], inbox?: Inbox): { needs: NeedsEntry[]; running: RunningEntry[]; queued: Session[] } {
  const sessions = new Map((inbox?.sessions ?? []).map((s) => [s.id, s]));
  const idle = inbox?.idle ?? [];
  const needs: NeedsEntry[] = [
    ...(inbox?.inputs ?? []).map((i) => ({ id: i.session_id, key: sessions.get(i.session_id)?.project_key ?? null, title: sessions.get(i.session_id)?.title ?? 'Question', tone: 'wait' as const })),
    ...idle.filter((s) => waitsOnOwner(s.attention)).map((s) => ({ id: s.id, key: s.project_key, title: s.title, tone: s.attention.kind === 'merge_blocked' ? 'bad' as const : s.attention.kind === 'merged' ? 'ok' as const : 'wait' as const })),
  ];
  const running: RunningEntry[] = [
    ...live.filter((s) => s.status === 'running').map((session) => ({ session })),
    ...idle.filter((s) => !waitsOnOwner(s.attention)).map((s) => ({ session: s as Session, attention: s.attention })),
  ];
  return { needs, running, queued: live.filter((s) => s.status === 'queued') };
}

/** How many things wait on you (the Inbox tab's badge). */
export function waitingCount(inbox?: Inbox): number {
  return (inbox?.inputs.length ?? 0) + (inbox?.idle.filter((s) => waitsOnOwner(s.attention)).length ?? 0);
}

/**
 * A session's status in a list: an idle session that Dispatch checks or merges shows that, not
 * "Your turn" (DISP-31). Null: its plain session status.
 */
export function busyStatus(s: Pick<Session, 'status'>, attention?: Attention): { label: string; text: string } | null {
  if (s.status !== 'idle' || !attention || waitsOnOwner(attention)) return null;
  return { label: attention.kind === 'merging' ? 'Merging' : 'Checking', text: attention.text };
}

/** What Activity's search asks for (DISP-54). Dates are the owner's local days, `to` included. */
export interface SessionFilter { q: string; project: string; kind: string; from: string; to: string }
export const NO_FILTER: SessionFilter = { q: '', project: '', kind: '', from: '', to: '' };

/** Whether a search or filter is set: then results replace "Recently finished". */
export function filtering(f: SessionFilter): boolean {
  return !!(f.q.trim() || f.project || f.kind || f.from || f.to);
}

/** The query string for GET /api/sessions/search: local days become times, `to` the start of the next day. */
export function searchQuery(f: SessionFilter, offset = 0, limit = 30): string {
  const day = (d: string, plus = 0) => {
    const [y, m, dd] = d.split('-').map(Number);
    return new Date(y, m - 1, dd + plus).toISOString();
  };
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.project) p.set('project', f.project);
  if (f.kind) p.set('kind', f.kind);
  if (f.from) p.set('from', day(f.from));
  if (f.to) p.set('to', day(f.to, 1));
  p.set('limit', String(limit));
  if (offset) p.set('offset', String(offset));
  return p.toString();
}

/** The statuses of a session that is not finished: the Live list, and open discussions (DISP-58). */
export const OPEN_STATUSES = 'queued,running,waiting_input,idle';

/** An open discussion untouched this long leaves Activity's list; it stays open on its item. */
export const DISCUSSION_DAYS = 10;

/** The open discussions Activity shows: those with a message in the last DISCUSSION_DAYS days. */
export function recentDiscussions<T extends Pick<Session, 'updated_at'>>(open: T[], now = Date.now()): T[] {
  return open.filter((s) => now - Date.parse(s.updated_at) < DISCUSSION_DAYS * 86_400_000);
}

/**
 * Where a session's row opens. An open discussion opens on its item, beside it on desktop
 * (DISP-58), and the open assistant chat on its own screen: those screens show the open thread.
 * A finished chat, and every other session, opens on the session page.
 */
export function sessionLink(s: Pick<Session, 'id' | 'kind' | 'status' | 'item_ids'>, wide: boolean): string {
  const open = OPEN_STATUSES.split(',').includes(s.status);
  const item = s.item_ids[0];
  if (open && s.kind === 'discuss' && item) return wide ? `/items/${item}?discuss=1` : `/items/${item}/discuss`;
  if (open && s.kind === 'assistant') return '/assistant';
  return `/s/${s.id}`;
}
