import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { itemInput, itemPatch } from '../../shared/types.ts';
import { HttpError, intParam, notFound, type Ctx } from './ctx.ts';

export function itemRoutes(app: FastifyInstance, { store, bus, attachments }: Ctx) {
  const project = (key: unknown) => {
    const p = store.projectByKey(String(key));
    if (!p) throw notFound('Project');
    return p;
  };
  const item = (id: unknown) => {
    const it = store.item(intParam(id));
    if (!it) throw notFound('Item');
    return it;
  };

  app.get('/api/projects/:key/items', async (req) => {
    const p = project((req.params as { key: string }).key);
    const q = req.query as { type?: string; status?: string; source_id?: string };
    return store.items(p.id, { type: q.type, status: q.status?.split(',').filter(Boolean), source_id: q.source_id ? Number(q.source_id) : undefined });
  });

  app.post('/api/projects/:key/items', async (req) => {
    const p = project((req.params as { key: string }).key);
    const input = itemInput.parse(req.body);
    if (input.effort !== null && input.effort >= p.effort_scale.length) throw new HttpError(400, 'Effort is outside the project scale');
    const created = store.createItem(p.id, input);
    bus.emit({ t: 'item', item: created });
    return created;
  });

  app.get('/api/projects/:key/facets', async (req) => store.facets(project((req.params as { key: string }).key).id));

  /** Item by human key, e.g. /api/items/by-key/HC-42 */
  app.get('/api/items/by-key/:key', async (req) => {
    const [pk, n] = String((req.params as { key: string }).key).toUpperCase().split(/-(?=\d+$)/);
    const p = project(pk);
    const it = store.itemByNumber(p.id, Number(n));
    if (!it) throw notFound('Item');
    return it;
  });

  app.get('/api/items/:id', async (req) => {
    const it = item((req.params as { id: string }).id);
    return {
      ...it,
      comments: store.comments(it.id),
      images: store.itemImages(it.id).map(({ file: _f, ...img }) => img),
      source: it.source_id ? store.source(it.source_id) : null,
      sessions: store.sessionsForItem(it.id),
      project: store.project(it.project_id),
    };
  });

  app.patch('/api/items/:id', async (req) => {
    const it = item((req.params as { id: string }).id);
    const patch = itemPatch.parse(req.body);
    const updated = store.updateItem(it.id, patch);
    bus.emit({ t: 'item', item: updated });
    return updated;
  });

  app.delete('/api/items/:id', async (req) => {
    const it = item((req.params as { id: string }).id);
    for (const img of store.itemImages(it.id)) attachments.deleteItemImage(it.id, img.file);
    store.deleteItem(it.id);
    return { ok: true };
  });

  app.post('/api/items/:id/comments', async (req) => {
    const it = item((req.params as { id: string }).id);
    // skills and scripts sign their comments (e.g. "claude"); the app's own are "you"
    const { body_md, author } = z.object({ body_md: z.string().min(1), author: z.string().trim().min(1).max(40).default('you') }).parse(req.body);
    return store.addComment(it.id, author, body_md);
  });
}
