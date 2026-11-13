import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SESSION_KINDS, answerInput, batchInput, plannerInput, proposedItemSchema } from '../../shared/types.ts';
import { attentionOf, failureReason } from '../../shared/attention.ts';
import type { Principal } from '../access.ts';
import { assertCanDrive, canDrive, canStop } from '../sessionGuard.ts';
import type { Session } from '../../shared/types.ts';
import { HttpError, intParam, notFound, type Ctx } from './ctx.ts';


/** A chat message: text, images pasted into it (POST /api/chat-images first, DISP-34), or both. */
// client_id: the web app's id for the message, so a retry is stored once (DISP-83); project_keys: tagged with @ (DISP-82)
const message = z.object({
  text: z.string().default(''), images: z.array(z.string()).max(10).default([]),
  client_id: z.string().min(1).max(64).optional(), project_keys: z.array(z.string().max(20)).max(20).default([]),
})
  .refine((b) => b.text.trim() || b.images.length, 'Write a message or paste an image.');
export function sessionRoutes(app: FastifyInstance, { store, sessions, hub, workers, users, github, bus, janitor, orchestrator }: Ctx) {
  const project = (key: unknown) => {
    const p = store.projectByKey(String(key));
    if (!p) throw notFound('Project');
    return p;
  };
  const session = (id: unknown) => {
    const s = store.session(intParam(id));
    if (!s) throw notFound('Session');
    return s;
  };
  /** who is asking (every /api route but the public ones has one) */
  const who = (req: FastifyRequest): Principal => req.principal!;
  const drives = (req: FastifyRequest) => (s: Session | undefined) => !!s && canDrive(who(req), s, users.installOwner);
  /** the install owner (or the legacy token, which acts for the install) */
  const ownsInstall = (req: FastifyRequest) => !!who(req).legacy || users.isOwner(who(req).user);
  /** a proposal card is acted on by whoever may drive the chat it is in */
  const fromProposal = (req: FastifyRequest, ref: { session_id: number } | undefined) => {
    const from = ref && store.session(ref.session_id);
    if (from) assertCanDrive(who(req), from, users.installOwner);
  };

  /** Everything waiting on you, across projects: only sessions you can act on (DISP-63). */
  app.get('/api/inbox', async (req) => {
    const mine = drives(req);
    const inputs = store.openInputs().filter((i) => mine(store.session(i.session_id)));
    // a planning chat's open proposal cards decide what it offers
    // an orchestrator that only waits for its steps needs nothing from you: it is left out
    const idle = store.sessions({ statuses: ['idle'] }).filter(mine).flatMap((s) => {
      const attention = s.kind === 'orchestrator' ? orchestrator.attention(s.id)
        : attentionOf(s, store.prs({ session_id: s.id }), s.kind === 'planner' ? store.events(s.id) : [], github.mergingNow);
      return attention ? [{ ...s, attention }] : [];
    });
    // failed sessions not yet ignored or retried (DISP-81), each with a short reason
    const failed = store.failedOpen().filter(mine).map((s) => ({ ...s, reason: failureReason(s, store.lastError(s.id)) }));
    const idleIds = new Set(idle.map((s) => s.id));
    // PRs of idle sessions are shown on their session's card
    const prs = store.prs({ open_only: true }).filter((p) => !idleIds.has(p.session_id) && mine(store.session(p.session_id)));
    const sessionIds = new Set([...inputs.map((i) => i.session_id), ...prs.map((p) => p.session_id)]);
    const related = [...sessionIds].map((id) => store.session(id)).filter((s) => !!s);
    // leftovers of finished sessions (the install owner's to clean up); re-checked in the background when the last check is old
    if (!ownsInstall(req)) return { inputs, idle, failed, prs, sessions: related, cleanup: null };
    if (!janitor.offer || Date.now() - Date.parse(janitor.offer.checked_at) > 10 * 60_000) void janitor.check().catch(() => undefined);
    return { inputs, idle, failed, prs, sessions: related, cleanup: janitor.offer };
  });

  app.get('/api/sessions', async (req) => {
    const q = req.query as { project?: string; status?: string; kind?: string };
    return store.sessions({
      project_id: q.project ? project(q.project).id : undefined,
      statuses: q.status?.split(',').filter(Boolean) as never,
      kind: q.kind as never,
    });
  });

  /** Activity's search over the full history (DISP-54): words in the chat, project, kind, start dates, paged. */
  app.get('/api/sessions/search', async (req) => {
    const f = z.object({
      q: z.string().max(200).optional(),
      project: z.string().optional(),
      kind: z.enum(SESSION_KINDS).optional(),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(Object.fromEntries(Object.entries(req.query as Record<string, string>).filter(([, v]) => v !== '')));
    return store.searchSessions({ ...f, project_id: f.project ? project(f.project).id : undefined });
  });

  /** Your workers (the install owner: all), and whether any is connected. */
  app.get('/api/worker', async (req) => {
    const list = workers.list(users.manages(who(req).user ?? users.installOwner));
    return {
      connected: list.some((w) => hub.isConnected(w.id)),
      workers: list.map((w) => ({ id: w.id, name: w.name, connected: hub.isConnected(w.id) })),
    };
  });

  app.post('/api/projects/:key/batches', async (req) => {
    const input = batchInput.parse(req.body);
    fromProposal(req, input.proposal);
    return sessions.startBatch(project((req.params as { key: string }).key), input, who(req).user);
  });

  app.post('/api/projects/:key/planner', async (req) => {
    const input = plannerInput.parse(req.body);
    fromProposal(req, input.proposal);
    return sessions.startPlanner(project((req.params as { key: string }).key), input, who(req).user);
  });

  /** Your assistant chat: the open thread (or null) with its unread replies, send a message, start a new thread. */
  app.get('/api/assistant', async (req) => {
    const cur = sessions.currentAssistant(who(req).user);
    return cur ? { session_id: cur.id, ...store.unread(cur.id) } : { session_id: null, unread: 0, last_seq: 0 };
  });

  /** The owner has seen the chat up to `seq`. */
  app.post('/api/assistant/read', async (req) => {
    const { session_id, seq } = z.object({ session_id: z.number().int(), seq: z.number().int().min(0) }).parse(req.body);
    store.markRead(session(session_id).id, seq);
    return store.unread(session_id);
  });

  app.post('/api/assistant/messages', async (req) => {
    const { text, images, ...opts } = message.parse(req.body);
    return sessions.assistantSend(who(req).user, text, images, opts);
  });

  app.post('/api/assistant/new', async (req) => {
    const cur = sessions.currentAssistant(who(req).user);
    if (cur) sessions.finish(cur.id, 'completed');
    return { ok: true };
  });

  app.get('/api/items/:id/discuss', async (req) => ({ session_id: sessions.currentDiscuss(intParam((req.params as { id: string }).id), who(req).user)?.id ?? null }));

  app.post('/api/items/:id/discuss', async (req) => {
    const { text, images, ...opts } = message.parse(req.body);
    return sessions.discussSend(intParam((req.params as { id: string }).id), who(req).user, text, images, opts);
  });

  app.post('/api/items/:id/discuss/new', async (req) => {
    const cur = sessions.currentDiscuss(intParam((req.params as { id: string }).id), who(req).user);
    if (cur) sessions.finish(cur.id, 'completed');
    return { ok: true };
  });

  app.get('/api/sessions/:id', async (req) => {
    const s = session((req.params as { id: string }).id);
    // ?after=<seq>: only newer events (the phone polls this while live updates are held back)
    const after = Number((req.query as { after?: string }).after ?? 0) || 0;
    return {
      session: s,
      events: store.events(s.id, after),
      inputs: store.inputs(s.id),
      items: store.itemsByIds(s.item_ids),
      prs: store.prs({ session_id: s.id }),
      repos: s.project_id ? store.repos(s.project_id) : [],
      source: s.source_id ? store.source(s.source_id) : null,
      project: s.project_id ? store.project(s.project_id) : null,
      checks: github.checks.of(s.id),
      // an orchestrator's plan and steps; for a step's batch, which orchestration and step it is
      orchestration: s.kind === 'orchestrator' && store.orchestration(s.id) ? orchestrator.view(s.id) : null,
      part_of: orchestrator.partOf(s),
      // a failed session (DISP-81): why, the session that retries it, and the open discussion of it
      failure: s.status === 'failed' ? {
        reason: failureReason(s, store.lastError(s.id)),
        retried_as: store.retryOf(s.id)?.id ?? null,
        discussion: store.discussionsAbout(s.id).find((d) => d.started_by === who(req).user && d.status !== 'completed' && d.status !== 'stopped')?.id ?? null,
      } : null,
      // what the caller may do with it (DISP-63)
      access: { drive: canDrive(who(req), s, users.installOwner), stop: canStop(who(req), s, users.installOwner) },
    };
  });

  app.post('/api/sessions/:id/messages', async (req) => {
    const s = session((req.params as { id: string }).id);
    const { text, images, ...opts } = message.parse(req.body);
    sessions.send(s.id, text, images, opts);
    return { ok: true };
  });

  app.post('/api/inputs/:id/answer', async (req) => {
    sessions.answer(intParam((req.params as { id: string }).id), answerInput.parse(req.body));
    return { ok: true };
  });

  app.post('/api/sessions/:id/interrupt', async (req) => {
    sessions.interrupt(session((req.params as { id: string }).id).id);
    return { ok: true };
  });

  app.post('/api/sessions/:id/finish', async (req) => {
    const s = session((req.params as { id: string }).id);
    const { status, cleanup } = z.object({ status: z.enum(['completed', 'stopped']), cleanup: z.boolean().default(false) }).parse(req.body);
    sessions.finish(s.id, status, cleanup);
    return store.session(s.id);
  });

  // the session stopped on a signed-out Claude account: check it on the worker, and resume if signed in (DISP-60)
  app.post('/api/sessions/:id/retry-login', async (req) => sessions.retryLogin(session((req.params as { id: string }).id).id));

  // a failed session (DISP-81): set it aside (or back), ask what would fix it, or retry it
  app.post('/api/sessions/:id/ignore', async (req) => {
    const { ignored } = z.object({ ignored: z.boolean().default(true) }).parse(req.body ?? {});
    return sessions.ignoreFailed(session((req.params as { id: string }).id).id, ignored);
  });
  app.post('/api/sessions/:id/discuss-failure', async (req) => sessions.discussFailure(session((req.params as { id: string }).id).id, who(req).user));
  app.post('/api/sessions/:id/retry', async (req) => sessions.retryFailed(session((req.params as { id: string }).id).id));

  app.post('/api/sessions/:id/move', async (req) => {
    const { worker_id } = z.object({ worker_id: z.number().int() }).parse(req.body);
    return sessions.move(session((req.params as { id: string }).id).id, worker_id);
  });
  app.post('/api/sessions/:id/pause', async (req) => sessions.pause(session((req.params as { id: string }).id).id));
  app.post('/api/sessions/:id/resume', async (req) => sessions.resume(session((req.params as { id: string }).id).id));
  app.post('/api/sessions/:id/start-now', async (req) => sessions.startNow(session((req.params as { id: string }).id).id));

  app.post('/api/sessions/:id/sync-prs', async (req) => github.syncSession(session((req.params as { id: string }).id)));

  app.post('/api/sessions/:id/prs', async (req) => {
    const s = session((req.params as { id: string }).id);
    const { repo_id } = z.object({ repo_id: z.number().int() }).parse(req.body);
    return github.createPr(s, repo_id);
  });

  /** Leftovers of finished sessions (worktrees, merged branches): check now, or clean them up. */
  const assertOwnsInstall = (req: FastifyRequest) => {
    if (!ownsInstall(req)) throw new HttpError(403, `Only the install owner (${users.installOwner}) can clean up.`);
  };
  app.post('/api/cleanup/check', async (req) => {
    assertOwnsInstall(req);
    await janitor.check();
    return janitor.offer;
  });
  app.post('/api/cleanup', async (req) => {
    assertOwnsInstall(req);
    const results = await janitor.cleanAll();
    bus.emit({ t: 'cleanup' });
    return { results, left: janitor.offer };
  });

  /** Apply a change to an item that a Discuss chat suggested. */
  app.post('/api/sessions/:id/apply-update', async (req) => {
    const s = session((req.params as { id: string }).id);
    const { event_id } = z.object({ event_id: z.number().int() }).parse(req.body);
    return sessions.applyItemUpdate(s.id, event_id);
  });

  /** Set a proposal card aside without acting on it. */
  app.post('/api/sessions/:id/dismiss-proposal', async (req) => {
    const s = session((req.params as { id: string }).id);
    const { event_id } = z.object({ event_id: z.number().int() }).parse(req.body);
    if (!store.events(s.id).some((e) => e.id === event_id && e.body.kind === 'proposal')) throw notFound('Proposal');
    sessions.markProposalDone({ session_id: s.id, event_id }, 'Dismissed');
    return { ok: true };
  });

  /** Accept an `items` proposal from a planner chat. */
  app.post('/api/sessions/:id/accept-items', async (req) => {
    const s = session((req.params as { id: string }).id);
    const { items, source_id, event_id } = z.object({ items: z.array(proposedItemSchema).min(1), source_id: z.number().int().nullable().default(null), event_id: z.number().int().optional() }).parse(req.body);
    const ref = event_id === undefined ? undefined : { session_id: s.id, event_id };
    sessions.assertProposalOpen(ref);
    if (!s.project_id) throw new HttpError(400, 'This session has no project');
    const created = store.createProposedItems(s.project_id, items, source_id ?? s.source_id);
    sessions.markProposalDone(ref, `Created ${created.map((i) => i.key).join(', ')}`);
    for (const item of created) bus.emit({ t: 'item', item });
    return created;
  });
}
