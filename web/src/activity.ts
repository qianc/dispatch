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
