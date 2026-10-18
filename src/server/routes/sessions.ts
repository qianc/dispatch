import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { answerInput, batchInput, plannerInput, proposedItemSchema } from '../../shared/types.ts';
import { attentionOf } from '../../shared/attention.ts';
import { HttpError, intParam, notFound, type Ctx } from './ctx.ts';

export function sessionRoutes(app: FastifyInstance, { store, sessions, hub, workers, github, bus, janitor }: Ctx) {
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

  /** Everything waiting on you, across projects. */
  app.get('/api/inbox', async () => {
    const inputs = store.openInputs();
    const idle = store.sessions({ statuses: ['idle'] }).map((s) => ({ ...s, attention: attentionOf(s, store.prs({ session_id: s.id })) }));
    const idleIds = new Set(idle.map((s) => s.id));
    // PRs of idle sessions are shown on their session's card
    const prs = store.prs({ open_only: true }).filter((p) => !idleIds.has(p.session_id));
    const sessionIds = new Set([...inputs.map((i) => i.session_id), ...prs.map((p) => p.session_id)]);
    const related = [...sessionIds].map((id) => store.session(id)).filter((s) => !!s);
    // leftovers of finished sessions; re-checked in the background when the last check is old
    if (!janitor.offer || Date.now() - Date.parse(janitor.offer.checked_at) > 10 * 60_000) void janitor.check().catch(() => undefined);
    return { inputs, idle, prs, sessions: related, cleanup: janitor.offer };
  });

  app.get('/api/sessions', async (req) => {
    const q = req.query as { project?: string; status?: string; kind?: string };
    return store.sessions({
      project_id: q.project ? project(q.project).id : undefined,
      statuses: q.status?.split(',').filter(Boolean) as never,
      kind: q.kind as never,
    });
  });

  app.get('/api/worker', async () => ({
    connected: hub.connected,
    workers: workers.list().map((w) => ({ id: w.id, name: w.name, connected: hub.isConnected(w.id) })),
  }));

  app.post('/api/projects/:key/batches', async (req) => sessions.startBatch(project((req.params as { key: string }).key), batchInput.parse(req.body)));

  app.post('/api/projects/:key/planner', async (req) => sessions.startPlanner(project((req.params as { key: string }).key), plannerInput.parse(req.body)));

  /** The assistant chat: the open thread (or null), send a message, start a new thread. */
  app.get('/api/assistant', async () => ({ session_id: sessions.currentAssistant()?.id ?? null }));

  app.post('/api/assistant/messages', async (req) => {
    const { text } = z.object({ text: z.string().min(1) }).parse(req.body);
    return sessions.assistantSend(text);
  });

  app.post('/api/assistant/new', async () => {
    const cur = sessions.currentAssistant();
    if (cur) sessions.finish(cur.id, 'completed');
    return { ok: true };
  });

  app.get('/api/items/:id/discuss', async (req) => ({ session_id: sessions.currentDiscuss(intParam((req.params as { id: string }).id))?.id ?? null }));

  app.post('/api/items/:id/discuss', async (req) => {
    const { text } = z.object({ text: z.string().min(1) }).parse(req.body);
    return sessions.discussSend(intParam((req.params as { id: string }).id), text);
  });

  app.post('/api/items/:id/discuss/new', async (req) => {
    const cur = sessions.currentDiscuss(intParam((req.params as { id: string }).id));
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
    };
  });

  app.post('/api/sessions/:id/messages', async (req) => {
    const s = session((req.params as { id: string }).id);
    const { text } = z.object({ text: z.string().min(1) }).parse(req.body);
    sessions.send(s.id, text);
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
  app.post('/api/cleanup/check', async () => {
    await janitor.check();
    return janitor.offer;
  });
  app.post('/api/cleanup', async () => {
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
