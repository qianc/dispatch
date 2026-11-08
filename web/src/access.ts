// What the signed-in person may do with someone's session, PR or schedule (DISP-63), and the
// words that say whose it is. The server decides and refuses; these only hide what would be refused.
import type { GithubAccessAccount, GithubPermission, PullRequest, Schedule, Session } from '../../src/shared/types.ts';

/** What the caller may do with a session (GET /api/sessions/:id). */
export interface SessionAccess {
  /** reply, answer, approve, act on proposals, merge, move */
  drive: boolean;
  /** interrupt, mark complete, stop */
  stop: boolean;
}

/** May the caller do `what`? A server from before users sends no access: everything, as before. */
export function canAct(access: SessionAccess | undefined, what: keyof SessionAccess): boolean {
  return access ? access[what] : true;
}

/** "Started by bob as @bob-gh"; null when no user started it. */
export function startedBy(s: Pick<Session, 'started_by' | 'github_login'>): string | null {
  if (!s.started_by) return null;
  return `Started by ${s.started_by}${s.github_login ? ` as @${s.github_login}` : ''}`;
}

/** The banner on a session the caller can only read. */
export function readOnlyText(s: Pick<Session, 'started_by'>): string {
  return `Started by ${s.started_by ?? 'an API token'}. You can read this session.`;
}

/** "Opened by bob (@bob-gh)"; null when no user started its session. */
export function openedBy(pr: Pick<PullRequest, 'started_by' | 'github_login'>): string | null {
  if (!pr.started_by) return null;
  return `Opened by ${pr.started_by}${pr.github_login ? ` (@${pr.github_login})` : ''}`;
}

/**
 * What the caller may do with a schedule: its owner everything; the install owner may switch it
 * off and delete it. `user`: the signed-in person (null: unknown, e.g. still loading).
 */
export function scheduleRights(schedule: Pick<Schedule, 'owner' | 'enabled'>, user: string | null, isOwner: boolean) {
  const mine = !!user && schedule.owner === user;
  return {
    edit: mine,
    run: mine,
    /** the install owner can only switch someone else's off, not back on */
    toggle: mine || (isOwner && schedule.enabled),
    remove: mine || isOwner,
  };
}

/** Where an account in "Who can act on GitHub here" comes from, in words. */
export function accountSource(a: Pick<GithubAccessAccount, 'source' | 'account'>): string {
  return a.source === 'user' ? 'Own GitHub account' : `Server account${a.account ? ` "${a.account}"` : ''}`;
}

/** A checked permission as a chip: can push (ok), read only (wait), none (bad), not known. */
export function permissionLook(p: GithubPermission | null): { label: string; tone: 'ok' | 'wait' | 'bad' | 'neutral' } {
  if (p === 'admin') return { label: 'admin', tone: 'ok' };
  if (p === 'write') return { label: 'write', tone: 'ok' };
  if (p === 'read') return { label: 'read only', tone: 'wait' };
  if (p === 'none') return { label: 'no access', tone: 'bad' };
  return { label: 'unknown', tone: 'neutral' };
}
