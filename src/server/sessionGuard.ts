// Other people's sessions are read-only (DISP-63). Whoever started a session drives it (replies,
// answers, merges, moves); the install owner may also stop it. A session no user started (the
// legacy API token) is driven by the install owner and the legacy token.
import type { Session } from '../shared/types.ts';
import type { Principal } from './access.ts';
import { HttpError } from './routes/ctx.ts';
import type { Store } from './store.ts';

type Params = Record<string, string>;
const id = (v: unknown) => Number(v) || 0;
const bySessionParam = (_store: Store, p: Params) => id(p.id) || undefined;
const byInput = (store: Store, p: Params) => store.input(id(p.id))?.session_id;
const byPr = (store: Store, p: Params) => store.pr(id(p.id))?.session_id;

export type SessionNeed = 'drive' | 'stop';

/**
 * Every /api route that acts on agent work: how to find the session it acts on and what it needs,
 * or null when the handler checks (starting work, schedules, cleanup) or it changes nothing of
 * anyone else's. A test checks that none of the `sessions` scope is missing.
 */
export const SESSION_ROUTES: Record<string, { find: (store: Store, params: Params, body: unknown) => number | undefined; need: SessionNeed } | null> = {
  'POST /api/sessions/:id/messages': { find: bySessionParam, need: 'drive' },
  'POST /api/sessions/:id/start-now': { find: bySessionParam, need: 'drive' },
  'POST /api/sessions/:id/pause': { find: bySessionParam, need: 'drive' },
  'POST /api/sessions/:id/resume': { find: bySessionParam, need: 'drive' },
  'POST /api/sessions/:id/move': { find: bySessionParam, need: 'drive' },
  'POST /api/sessions/:id/retry-login': { find: bySessionParam, need: 'drive' },
  'POST /api/sessions/:id/ignore': { find: bySessionParam, need: 'drive' },
  'POST /api/sessions/:id/discuss-failure': { find: bySessionParam, need: 'drive' },
  'POST /api/sessions/:id/retry': { find: bySessionParam, need: 'drive' },
  'POST /api/sessions/:id/prs': { find: bySessionParam, need: 'drive' },
  'POST /api/sessions/:id/accept-items': { find: bySessionParam, need: 'drive' },
  'POST /api/sessions/:id/apply-update': { find: bySessionParam, need: 'drive' },
  'POST /api/sessions/:id/dismiss-proposal': { find: bySessionParam, need: 'drive' },
  // a PR sync may push to the upstream and auto-merge, as the starter
  'POST /api/sessions/:id/sync-prs': { find: bySessionParam, need: 'drive' },
  'POST /api/sessions/:id/interrupt': { find: bySessionParam, need: 'stop' },
  'POST /api/sessions/:id/finish': { find: bySessionParam, need: 'stop' },
  'POST /api/inputs/:id/answer': { find: byInput, need: 'drive' },
  'POST /api/prs/:id/merge': { find: byPr, need: 'drive' },
  'POST /api/prs/:id/github-pr': { find: byPr, need: 'drive' },
  'POST /api/prs/:id/resolve-conflicts': { find: byPr, need: 'drive' },
  // only moves the caller's read point, but of a chat that is theirs
  'POST /api/assistant/read': { find: (_store, _p, body) => id((body as { session_id?: unknown } | undefined)?.session_id) || undefined, need: 'drive' },

  // new work: the handler checks the proposal card it comes from, if any
  'POST /api/projects/:key/batches': null,
  'POST /api/projects/:key/planner': null,
  'POST /api/projects/:key/releases': null,
  // the caller's own chats
  'POST /api/assistant/messages': null,
  'POST /api/assistant/new': null,
  'POST /api/items/:id/discuss': null,
  'POST /api/items/:id/discuss/new': null,
  'POST /api/chat-images': null,
  // schedules and cleanup: the handler checks who may
  'POST /api/projects/:key/schedules': null,
  'PATCH /api/schedules/:id': null,
  'DELETE /api/schedules/:id': null,
  'POST /api/schedules/:id/run': null,
  // orchestrations check their starter in the route (routes/orchestrations.ts)
  'POST /api/orchestrations': null,
  'POST /api/orchestrations/:id/approve': null,
  'POST /api/orchestrations/:id/pause': null,
  'POST /api/orchestrations/:id/resume': null,
  'POST /api/orchestrations/:id/stop': null,
  'POST /api/orchestration-steps/:id/skip': null,
  'POST /api/orchestration-steps/:id/retry': null,
  'POST /api/cleanup': null,
  'POST /api/cleanup/check': null,
};

/** May `p` reply to, answer, merge or move the session? */
export function canDrive(p: Pick<Principal, 'user' | 'legacy'>, s: Pick<Session, 'started_by'>, installOwner: string): boolean {
  return (p.user !== null && p.user === s.started_by) || (s.started_by === null && (p.user === installOwner || !!p.legacy));
}

/** May `p` interrupt or end the session? Its driver, and the install owner. */
export function canStop(p: Pick<Principal, 'user' | 'legacy'>, s: Pick<Session, 'started_by'>, installOwner: string): boolean {
  return canDrive(p, s, installOwner) || p.user === installOwner;
}

export const readOnlyMessage = (s: Pick<Session, 'started_by'>) => `Started by ${s.started_by ?? 'an API token'}: you can read it, not act on it.`;

/** Throws 403 unless `p` may drive the session. */
export function assertCanDrive(p: Pick<Principal, 'user' | 'legacy'>, s: Pick<Session, 'started_by'>, installOwner: string) {
  if (!canDrive(p, s, installOwner)) throw new HttpError(403, readOnlyMessage(s));
}

/** The session an /api route would act on that `p` may not, if any. */
export function refusedSession(store: Store, p: Principal, method: string, route: string, params: Params, body: unknown, installOwner: string): Session | null {
  const rule = SESSION_ROUTES[`${method} ${route}`];
  if (!rule) return null;
  const sessionId = rule.find(store, params, body);
  const s = sessionId ? store.session(sessionId) : undefined;
  if (!s) return null;
  const ok = rule.need === 'stop' ? canStop(p, s, installOwner) : canDrive(p, s, installOwner);
  return ok ? null : s;
}
