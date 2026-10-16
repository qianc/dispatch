import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './helpers.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('images on items', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let dataDir: string;
  const upload = (itemId: number, body: Buffer | string, query = 'name=shot.png', type = 'image/png') =>
    fetch(`${s.base}/api/items/${itemId}/images?${query}`, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : new Uint8Array(body) });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'dsp-img-'));
    s = await startServer({ DATA_DIR: dataDir });
    await s.call('POST', '/projects', { key: 'IMG', name: 'Images' });
  });
  afterAll(() => s.app.close());

  it('stores an uploaded image, lists it on the item, and serves it with its own type', async () => {
    const it = (await s.call('POST', '/projects/IMG/items', { title: 'Legend overlaps' })).data;
    const res = await upload(it.id, PNG, 'name=legend%20overlap.png', 'application/octet-stream');
    expect(res.status).toBe(200);
    const img = await res.json();
    expect(img).toMatchObject({ item_id: it.id, comment_id: null, name: 'legend overlap.png', mime: 'image/png', size: PNG.length, author: 'you' });
    expect(img.file).toBeUndefined(); // the server's file name stays on the server

    const detail = (await s.call('GET', `/items/${it.id}`)).data;
    expect(detail.images).toEqual([img]);
    const got = await fetch(`${s.base}${img.url}`);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await got.arrayBuffer())).toEqual(PNG);
  });

  it('keeps only real images, told apart by content', async () => {
    const it = (await s.call('POST', '/projects/IMG/items', { title: 'Bad uploads' })).data;
    expect((await upload(it.id, '<svg onload="alert(1)"></svg>', 'name=x.svg', 'image/svg+xml')).status).toBe(415);
    expect((await upload(it.id, 'just some text, not an image', 'name=x.png')).status).toBe(415);
    expect((await upload(it.id, Buffer.alloc(0))).status).toBe(400);
    expect((await upload(9999, PNG)).status).toBe(404);
    expect((await s.call('GET', `/items/${it.id}`)).data.images).toEqual([]);
  });

  it('puts images on a comment of the same item only, and signs them', async () => {
    const it = (await s.call('POST', '/projects/IMG/items', { title: 'With comment' })).data;
    const other = (await s.call('POST', '/projects/IMG/items', { title: 'Other' })).data;
    const c = (await s.call('POST', `/items/${it.id}/comments`, { body_md: 'After the fix', author: 'claude' })).data;
    expect((await upload(other.id, PNG, `comment_id=${c.id}`)).status).toBe(400);
    const img = await (await upload(it.id, PNG, `name=after.png&comment_id=${c.id}&author=claude`)).json();
    expect(img).toMatchObject({ comment_id: c.id, author: 'claude' });
  });

  it('deletes an image and its file, and an item takes its images with it', async () => {
    const it = (await s.call('POST', '/projects/IMG/items', { title: 'Delete me' })).data;
    const a = await (await upload(it.id, PNG)).json();
    await upload(it.id, PNG);
    const dir = join(dataDir, 'attachments', 'items', String(it.id));
    expect(readdirSync(dir)).toHaveLength(2);
    expect((await s.call('DELETE', `/images/${a.id}`)).status).toBe(200);
    expect(readdirSync(dir)).toHaveLength(1);
    expect((await fetch(`${s.base}${a.url}`)).status).toBe(404);
    await s.call('DELETE', `/items/${it.id}`);
    expect(existsSync(dir) ? readdirSync(dir) : []).toHaveLength(0);
  });

  it("lets an agent on the project see an item's images, also from a read-only discussion", async () => {
    const it = (await s.call('POST', '/projects/IMG/items', { title: 'Agent sees it' })).data;
    const img = await (await upload(it.id, PNG, 'name=bug.png')).json();
    const project = s.ctx.store.projectByKey('IMG')!;
    for (const kind of ['work', 'discuss'] as const) {
      const sess = s.ctx.store.createSession({ project_id: project.id, kind, title: 't', status: 'running', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [it.id] });
      const item = (await s.ctx.sessions.rpc(sess.id, 'get_item', { key: it.key })) as { images: { id: number; name: string }[] };
      expect(item.images).toEqual([expect.objectContaining({ id: img.id, name: 'bug.png' })]);
      expect(await s.ctx.sessions.rpc(sess.id, 'get_image', { id: img.id })).toEqual({ name: 'bug.png', mime: 'image/png', data: PNG.toString('base64') });
    }
    // not from another project
    await s.call('POST', '/projects', { key: 'OTH', name: 'Other' });
    const other = s.ctx.store.createSession({ project_id: s.ctx.store.projectByKey('OTH')!.id, kind: 'work', title: 't', status: 'running', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [] });
    await expect(s.ctx.sessions.rpc(other.id, 'get_image', { id: img.id })).rejects.toThrow(/No image/);
  });

  it('needs sign-in to upload or view', async () => {
    const locked = await startServer({ DISABLE_AUTH: '', APP_PASSWORD: 'pw', DATA_DIR: mkdtempSync(join(tmpdir(), 'dsp-img2-')) });
    try {
      expect((await fetch(`${locked.base}/api/items/1/images`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array(PNG) })).status).toBe(401);
      expect((await fetch(`${locked.base}/api/images/1/x.png`)).status).toBe(401);
    } finally {
      await locked.app.close();
    }
  });
});
