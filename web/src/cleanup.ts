import type { Inbox } from './api.ts';

type Offer = NonNullable<Inbox['cleanup']>;
/** What the worker did in one repo of a session (`TidyResult` in src/worker/workspace.ts). */
export interface TidyResult { repo: string; worktree: string; branch: string }
/** The answer of POST /api/cleanup. */
export interface CleanupAnswer { results: { session_id: number; results: TidyResult[] }[]; left: Inbox['cleanup'] }

export interface CleanupReport {
  /** "2 branches could not be removed:" */
  title: string;
  kept: { session_id: number; session: string; repo: string; what: 'branch' | 'worktree'; reason: string }[];
  /** "Removed 3 worktrees and 1 branch." or '' */
  removed: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const and = (parts: string[]) => parts.filter(Boolean).join(' and ');

/** The worker's "kept (<why>)" as a reason; git's "error: " prefix is noise. */
function reason(kept: string, what: 'branch' | 'worktree') {
  const why = /^kept \((.*)\)$/s.exec(kept)?.[1]?.replace(/^(error|fatal): /, '');
  if (why) return why;
  return what === 'branch' ? 'its worktree stays' : 'kept';
}

/**
 * After Clean up: what the worker kept, per session and repo, with its reason (DISP-61).
 * Null when nothing is left: the card goes, with no message.
 */
export function cleanupReport(answer: CleanupAnswer, before: Offer): CleanupReport | null {
  if (!answer.left) return null;
  const sessions = [...before.sessions, ...answer.left.sessions];
  const label = (id: number) => {
    const s = sessions.find((o) => o.id === id);
    return s ? `${s.project_key ? `${s.project_key} ` : ''}#${id} ${s.title}` : `#${id}`;
  };
  const kept: CleanupReport['kept'] = [];
  let worktrees = 0;
  let branches = 0;
  for (const { session_id, results } of answer.results) {
    for (const r of results) {
      if (r.worktree === 'removed') worktrees++;
      if (r.branch === 'deleted') branches++;
      if (r.worktree.startsWith('kept')) kept.push({ session_id, session: label(session_id), repo: r.repo, what: 'worktree', reason: reason(r.worktree, 'worktree') });
      if (r.branch.startsWith('kept')) kept.push({ session_id, session: label(session_id), repo: r.repo, what: 'branch', reason: reason(r.branch, 'branch') });
    }
  }
  // still offered, but the worker did not tidy it (offline, or the session was resumed)
  for (const o of answer.left.sessions) {
    if (!answer.results.some((r) => r.session_id === o.id && r.results.length)) {
      kept.push({ session_id: o.id, session: label(o.id), repo: '', what: o.branches ? 'branch' : 'worktree', reason: 'its worker did not tidy it; is it online?' });
    }
  }
  const count = (what: 'branch' | 'worktree') => kept.filter((k) => k.what === what).length;
  const keptText = and([count('branch') ? plural(count('branch'), 'branch', 'branches') : '', count('worktree') ? plural(count('worktree'), 'worktree', 'worktrees') : '']);
  const n = count('branch') + count('worktree');
  return {
    title: n ? `${keptText} could not be removed:` : 'Some leftovers are still on disk.',
    kept,
    removed: worktrees || branches ? `Removed ${and([worktrees ? plural(worktrees, 'worktree', 'worktrees') : '', branches ? plural(branches, 'branch', 'branches') : ''])}.` : '',
  };
}
