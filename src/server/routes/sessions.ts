import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { answerInput, batchInput, plannerInput, proposedItemSchema } from '../../shared/types.ts';
import { intParam, notFound, type Ctx } from './ctx.ts';

export function sessionRoutes(app: FastifyInstance, { store, sessions, hub, github, bus }: Ctx) {
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
    const idle = store.sessions({ statuses: ['idle'] });
    const prs = store.prs({ open_only: true });
    const sessionIds = new Set([...inputs.map((i) => i.session_id), ...prs.map((p) => p.session_id)]);
    const related = [...sessionIds].map((id) => store.session(id)).filter((s) => !!s);
    return { inputs, idle, prs, sessions: related };
  });

  app.get('/api/sessions', async (req) => {
    const q = req.query as { project?: string; status?: string; kind?: string };
    return store.sessions({
      project_id: q.project ? project(q.project).id : undefined,
      statuses: q.status?.split(',').filter(Boolean) as never,
      kind: q.kind as never,
    });
  });

  app.get('/api/worker', async () => ({ connected: hub.connected }));

  app.post('/api/projects/:key/batches', async (req) => sessions.startBatch(project((req.params as { key: string }).key), batchInput.parse(req.body)));

  app.post('/api/projects/:key/planner', async (req) => sessions.startPlanner(project((req.params as { key: string }).key), plannerInput.parse(req.body)));

  app.get('/api/sessions/:id', async (req) => {
    const s = session((req.params as { id: string }).id);
    return {
      session: s,
      events: store.events(s.id),
      inputs: store.inputs(s.id),
      items: store.itemsByIds(s.item_ids),
      prs: store.prs({ session_id: s.id }),
      repos: store.repos(s.project_id),
      source: s.source_id ? store.source(s.source_id) : null,
      project: store.project(s.project_id),
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

  app.post('/api/sessions/:id/sync-prs', async (req) => github.syncSession(session((req.params as { id: string }).id)));

  app.post('/api/sessions/:id/prs', async (req) => {
    const s = session((req.params as { id: string }).id);
    const { repo_id } = z.object({ repo_id: z.number().int() }).parse(req.body);
    return github.createPr(s, repo_id);
  });

  /** Accept an `items` proposal from a planner chat. */
  app.post('/api/sessions/:id/accept-items', async (req) => {
    const s = session((req.params as { id: string }).id);
    const { items, source_id } = z.object({ items: z.array(proposedItemSchema).min(1), source_id: z.number().int().nullable().default(null) }).parse(req.body);
    const created = store.createProposedItems(s.project_id, items, source_id ?? s.source_id);
    for (const item of created) bus.emit({ t: 'item', item });
    return created;
  });
}
