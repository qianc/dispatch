// A disabled project is read-only (DISP-59): it keeps its items, sources and history, but every
// write to it is refused (HTTP routes, the /mcp tracker tools, the agents' and the assistant's
// tools), its schedules are paused, and its queued sessions wait. A running session goes on until
// the owner stops it.
import type { Project } from '../shared/types.ts';
import { HttpError } from './routes/ctx.ts';
import type { Bus } from './bus.ts';
import { passedSlot } from './scheduler.ts';
import type { Sessions } from './sessions.ts';
import type { Store } from './store.ts';

export const disabledMessage = (p: Pick<Project, 'key'>) => `Project ${p.key} is disabled (read-only). The owner can enable it in Dispatch.`;

export class ProjectDisabledError extends HttpError {
  constructor(p: Pick<Project, 'key'>) {
    super(423, disabledMessage(p));
  }
}

/** Throws when the project (or the project with this id) is disabled. */
export function assertWritable(store: Store, project: Project | number | null | undefined) {
  const p = typeof project === 'number' ? store.project(project) : project;
  if (p?.disabled) throw new ProjectDisabledError(p);
}

type Params = Record<string, string>;
const id = (v: string | undefined) => Number(v) || 0;
const byKey = (store: Store, p: Params) => store.projectByKey(String(p.key ?? ''))?.id;
const byItem = (store: Store, p: Params) => store.item(id(p.id))?.project_id;
const bySession = (store: Store, sessionId: number) => store.session(sessionId)?.project_id ?? undefined;
const bySessionParam = (store: Store, p: Params) => bySession(store, id(p.id));
const byRepo = (store: Store, p: Params) => store.repo(id(p.id))?.project_id;
const bySchedule = (store: Store, p: Params) => store.schedule(id(p.id))?.project_id;
const bySource = (store: Store, p: Params) => store.source(id(p.id))?.project_id;

/**
 * Every write route (not GET) under /api: how to find the project it writes to, or null when it
 * writes to no project (or must work on a disabled one). A test checks that none is missing.
 */
export const PROJECT_WRITES: Record<string, ((store: Store, params: Params) => number | undefined) | null> = {
  'POST /api/projects/:key/items': byKey,
  'POST /api/projects/:key/sources': byKey,
  'POST /api/projects/:key/batches': byKey,
  'POST /api/projects/:key/planner': byKey,
  'POST /api/projects/:key/schedules': byKey,
  'POST /api/projects/:key/releases': byKey,
  'POST /api/projects/:key/repos': byKey,
  // checks itself: muting stays possible, everything else is refused
  'PATCH /api/projects/:key': null,
  // the switch itself
  'POST /api/projects/:key/disable': null,
  'POST /api/projects/:key/enable': null,

  'PATCH /api/items/:id': byItem,
  'DELETE /api/items/:id': byItem,
  'POST /api/items/:id/comments': byItem,
  'POST /api/items/:id/images': byItem,
  'POST /api/items/:id/discuss': byItem,
  'POST /api/items/:id/discuss/new': byItem,
  'DELETE /api/images/:id': (store, p) => store.item(store.itemImage(id(p.id))?.item_id ?? 0)?.project_id,

  'PATCH /api/sources/:id': bySource,
  'POST /api/sources/:id/items': bySource,

  'PATCH /api/schedules/:id': bySchedule,
  'DELETE /api/schedules/:id': bySchedule,
  'POST /api/schedules/:id/run': bySchedule,

  'PATCH /api/repos/:id': byRepo,
  'DELETE /api/repos/:id': byRepo,
  'PUT /api/repos/:id/placements/:workerId': byRepo,
  'DELETE /api/repos/:id/placements/:workerId': byRepo,

  'POST /api/sessions/:id/messages': bySessionParam,
  'POST /api/sessions/:id/start-now': bySessionParam,
  'POST /api/sessions/:id/pause': bySessionParam,
  'POST /api/sessions/:id/resume': bySessionParam,
  'POST /api/sessions/:id/move': bySessionParam,
  'POST /api/sessions/:id/sync-prs': bySessionParam,
  'POST /api/sessions/:id/prs': bySessionParam,
  'POST /api/sessions/:id/accept-items': bySessionParam,
  'POST /api/sessions/:id/apply-update': bySessionParam,
  'POST /api/sessions/:id/dismiss-proposal': bySessionParam,
  // a running session is stopped only by the owner, as on any project
  'POST /api/sessions/:id/interrupt': null,
  'POST /api/sessions/:id/finish': null,
  'POST /api/inputs/:id/answer': (store, p) => bySession(store, store.input(id(p.id))?.session_id ?? 0),
  'POST /api/prs/:id/merge': (store, p) => bySession(store, store.pr(id(p.id))?.session_id ?? 0),
  'POST /api/prs/:id/github-pr': (store, p) => bySession(store, store.pr(id(p.id))?.session_id ?? 0),
  'POST /api/prs/:id/resolve-conflicts': (store, p) => bySession(store, store.pr(id(p.id))?.session_id ?? 0),

  // no project of their own (the assistant's tools check the project they write to)
  'POST /api/projects': null,
  'POST /api/login': null,
  'POST /api/logout': null,
  'POST /api/assistant/messages': null,
  'POST /api/assistant/new': null,
  'POST /api/assistant/read': null,
  'POST /api/chat-images': null,
  'POST /api/cleanup': null,
  'POST /api/cleanup/check': null,
  'PATCH /api/settings': null,
  'POST /api/push/subscribe': null,
  'POST /api/push/unsubscribe': null,
  'POST /api/push/presence': null,
  'POST /api/push/keep-only': null,
  'POST /api/push/test': null,
  'POST /api/tokens': null,
  'DELETE /api/tokens/:id': null,
  'POST /api/workers': null,
  'PATCH /api/workers/:id': null,
  'DELETE /api/workers/:id': null,
  'PUT /api/settings/default-worker': null,
  'DELETE /api/oauth/grants/:id': null,
};

/** The disabled project an /api write route would change, if any. */
export function refusedWrite(store: Store, method: string, route: string, params: Params): Project | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  const find = PROJECT_WRITES[`${method} ${route}`];
  const projectId = find?.(store, params);
  const p = projectId ? store.project(projectId) : undefined;
  return p?.disabled ? p : null;
}

/**
 * Disable a project (`by`: who) or enable it (`by` null). Enabling switches its paused schedules
 * back on from their next slot, and starts its queued sessions.
 */
export function setDisabled(deps: { store: Store; bus: Bus; sessions: Sessions }, p: Project, by: string | null): Project {
  const updated = deps.store.setDisabled(p.id, by, (s) => ({ last_slot: passedSlot(s) }));
  if (by === null) deps.sessions.dispatch();
  deps.bus.emit({ t: 'project', key: p.key });
  return updated;
}
