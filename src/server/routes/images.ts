import type { FastifyInstance } from 'fastify';
import { HttpError, intParam, notFound, type Ctx } from './ctx.ts';

const MAX_BYTES = 15 * 1024 * 1024;

/**
 * Images on items. Upload: POST the raw file (any image/* or application/octet-stream body) to
 * /api/items/:id/images?name=shot.png[&comment_id=7][&author=claude]. Only PNG, JPEG, GIF and WebP
 * are kept, told apart by their content.
 */
export function imageRoutes(app: FastifyInstance, { store, bus, attachments }: Ctx) {
  app.register(async (scoped) => {
    // raw bodies, only in this scope
    const raw = (_req: unknown, body: Buffer | string, done: (err: Error | null, body?: unknown) => void) => done(null, body);
    scoped.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_BYTES }, raw);
    scoped.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: MAX_BYTES }, raw);

    scoped.post('/api/items/:id/images', { bodyLimit: MAX_BYTES }, async (req) => {
      const it = store.item(intParam((req.params as { id: string }).id));
      if (!it) throw notFound('Item');
      const q = req.query as { name?: string; comment_id?: string; author?: string };
      const body = req.body;
      if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Send the image file as the request body.');
      const commentId = q.comment_id ? Number(q.comment_id) : null;
      if (commentId !== null && !store.comments(it.id).some((c) => c.id === commentId)) throw new HttpError(400, 'That comment is not on this item.');
      const saved = attachments.saveItemImage(it.id, body);
      if (!saved) throw new HttpError(415, 'Only PNG, JPEG, GIF and WebP images can be attached.');
      const name = (q.name ?? '').replace(/[/\\\0]/g, '').trim().slice(0, 120) || `image.${saved.file.split('.').pop()}`;
      const author = (q.author ?? 'you').trim().slice(0, 40) || 'you';
      const { file: _file, ...img } = store.addItemImage({ item_id: it.id, comment_id: commentId, name, file: saved.file, mime: saved.mime, size: body.length, author });
      bus.emit({ t: 'item', item: store.item(it.id)! });
      return img;
    });
  });

  app.get('/api/images/:id/:name', async (req, reply) => {
    const img = store.itemImage(intParam((req.params as { id: string }).id));
    const data = img && (await attachments.readItemImage(img.item_id, img.file));
    if (!img || !data) return reply.status(404).send({ error: 'Not found' });
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.header('x-content-type-options', 'nosniff');
    return reply.type(img.mime).send(data);
  });

  app.delete('/api/images/:id', async (req) => {
    const img = store.itemImage(intParam((req.params as { id: string }).id));
    if (!img) throw notFound('Image');
    store.deleteItemImage(img.id);
    attachments.deleteItemImage(img.item_id, img.file);
    bus.emit({ t: 'item', item: store.item(img.item_id)! });
    return { ok: true };
  });
}
