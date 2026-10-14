import type { FastifyInstance } from 'fastify';
import { proposedItemSchema, sourceInput } from '../../shared/types.ts';
import { z } from 'zod';
import { intParam, notFound, type Ctx } from './ctx.ts';

export function sourceRoutes(app: FastifyInstance, { store, bus }: Ctx) {
  const project = (key: unknown) => {
    const p = store.projectByKey(String(key));
    if (!p) throw notFound('Project');
    return p;
  };

  app.get('/api/projects/:key/sources', async (req) => store.sources(project((req.params as { key: string }).key).id));

  /** Capture a retro / report. Skills can call this with `Authorization: Bearer <api token>`. */
  app.post('/api/projects/:key/sources', async (req) => {
    const p = project((req.params as { key: string }).key);
    const { items, ...input } = sourceInput.parse(req.body);
    const source = store.createSource(p.id, input);
    const created = store.createProposedItems(p.id, items, source.id);
    for (const item of created) bus.emit({ t: 'item', item });
    return { ...source, items: created };
  });

  app.get('/api/sources/:id', async (req) => {
    const s = store.source(intParam((req.params as { id: string }).id));
    if (!s) throw notFound('Source');
    return { ...s, items: store.items(s.project_id, { source_id: s.id }), project_key: store.project(s.project_id)!.key };
  });

  app.patch('/api/sources/:id', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    if (!store.source(id)) throw notFound('Source');
    return store.updateSource(id, sourceInput.omit({ items: true }).partial().parse(req.body));
  });

  /** Create items from a source (manual split, or accepting an `items` proposal card). */
  app.post('/api/sources/:id/items', async (req) => {
    const s = store.source(intParam((req.params as { id: string }).id));
    if (!s) throw notFound('Source');
    const { items } = z.object({ items: z.array(proposedItemSchema).min(1) }).parse(req.body);
    const created = store.createProposedItems(s.project_id, items, s.id);
    for (const item of created) bus.emit({ t: 'item', item });
    return created;
  });
}
