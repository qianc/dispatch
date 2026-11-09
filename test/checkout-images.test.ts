import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES } from '../src/shared/chatImages.ts';
import { attachImage, checkoutImage } from '../src/worker/mcp.ts';
import { startServer, OWNER } from './helpers.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SHOT = '.superpowers/screenshots/collab-17-account-dev.png';

describe('attach_image from a file in the session checkout (DISP-74)', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsp-ckimg-'));
  const cwd = join(base, 'checkout');
  beforeAll(() => {
    mkdirSync(join(cwd, '.superpowers/screenshots'), { recursive: true });
    writeFileSync(join(cwd, SHOT), PNG);
    writeFileSync(join(cwd, 'notes.txt'), 'not an image, but long enough to sniff');
    writeFileSync(join(cwd, 'fake.png'), 'plain text with a .png name');
    writeFileSync(join(cwd, 'huge.png'), PNG);
    truncateSync(join(cwd, 'huge.png'), MAX_IMAGE_BYTES + 1);
    writeFileSync(join(base, 'secret.png'), PNG);
    symlinkSync(join(base, 'secret.png'), join(cwd, 'link.png'));
    symlinkSync(SHOT, join(cwd, 'inside-link.png'));
  });

  describe('the worker checks the path', () => {
    it('reads an image in the checkout, by a path from its root or an absolute one', async () => {
      const img = await checkoutImage(cwd, SHOT);
      expect(img).toMatchObject({ path: SHOT, mime: 'image/png' });
      expect(img.data.equals(PNG)).toBe(true);
      expect((await checkoutImage(cwd, join(cwd, SHOT))).path).toBe(SHOT);
      // a symlink that stays inside the checkout is fine
      expect((await checkoutImage(cwd, 'inside-link.png')).mime).toBe('image/png');
    });

    it('refuses a path outside the checkout', async () => {
      await expect(checkoutImage(cwd, '../secret.png')).rejects.toThrow(/outside the session checkout/);
      await expect(checkoutImage(cwd, join(base, 'secret.png'))).rejects.toThrow(/outside the session checkout/);
    });

    it('refuses a symlink that points outside the checkout', async () => {
      await expect(checkoutImage(cwd, 'link.png')).rejects.toThrow(/symlink to a file outside the session checkout/);
    });

    it('refuses a file that is not a PNG, JPEG, GIF or WebP, whatever its name', async () => {
      await expect(checkoutImage(cwd, 'notes.txt')).rejects.toThrow(/notes\.txt is not an image: only PNG, JPEG, GIF and WebP/);
      await expect(checkoutImage(cwd, 'fake.png')).rejects.toThrow(/not an image/);
    });

    it('refuses a file over the size limit of pasted images, and names the limit', async () => {
      await expect(checkoutImage(cwd, 'huge.png')).rejects.toThrow(/huge\.png is too large: .* the limit is 15 MB/);
    });

    it('says when the file is not there', async () => {
      await expect(checkoutImage(cwd, 'missing.png')).rejects.toThrow(/File not found: missing\.png/);
      await expect(checkoutImage(cwd, '.superpowers')).rejects.toThrow(/not a file/);
    });
  });

  describe('the tool', () => {
    it('names both inputs: a pasted image or a file in the checkout', () => {
      const t = attachImage(async () => null, cwd);
      expect(t.description).toMatch(/pasted into this chat/);
      expect(t.description).toMatch(/file in your session checkout/);
      expect(Object.keys(t.inputSchema)).toEqual(expect.arrayContaining(['key', 'image', 'path', 'name', 'comment_id']));
    });

    it('sends the checked file to the server; a refusal comes back as an error, without a call', async () => {
      const calls: unknown[] = [];
      const t = attachImage(async (_m, p) => {
        calls.push(p);
        return { attached: 1, item: 'PI-1', name: 'collab-17-account-dev.png' };
      }, cwd);
      const done = await t.handler({ key: 'PI-1', path: SHOT } as never, {});
      expect(done.isError).toBeUndefined();
      expect(calls).toEqual([{ key: 'PI-1', path: SHOT, data: PNG.toString('base64') }]);
      const refused = await t.handler({ key: 'PI-1', path: 'link.png' } as never, {});
      expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/outside the session checkout/) }] });
      // a pasted image still goes as before
      await t.handler({ key: 'PI-1', image: 'x.png' } as never, {});
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual({ key: 'PI-1', image: 'x.png' });
    });
  });

  describe('the server', () => {
    let s: Awaited<ReturnType<typeof startServer>>;
    let sessionId: number;
    beforeAll(async () => {
      s = await startServer({ DATA_DIR: mkdtempSync(`${tmpdir()}/dsp-ckimg-srv-`) });
      await s.call('POST', '/projects', { key: 'PI', name: 'Paste' });
      await s.call('POST', '/projects', { key: 'OT', name: 'Other' });
      await s.call('POST', '/projects/PI/items', { title: 'Account page' });
      await s.call('POST', '/projects/OT/items', { title: 'Not ours' });
      const p = s.ctx.store.projectByKey('PI')!;
      sessionId = s.ctx.store.createSession({ started_by: OWNER,
        project_id: p.id, kind: 'work', title: 't', status: 'idle', force_plan: false, branch: 'dispatch/pi-1-t', initial_prompt: '', source_id: null, item_ids: [],
        worker_id: s.ctx.workers.legacy().id,
      }).id;
    });
    afterAll(async () => {
      await s.app.close();
    });

    it('stores the image with the item, under its file name, and the item\'s comments name the file and its path', async () => {
      const r = await s.ctx.sessions.rpc(sessionId, 'attach_image', { key: 'PI-1', path: SHOT, data: PNG.toString('base64') });
      expect(r).toMatchObject({ item: 'PI-1', name: 'collab-17-account-dev.png' });
      const p = s.ctx.store.projectByKey('PI')!;
      const item = (await s.call('GET', `/items/${s.ctx.store.itemByNumber(p.id, 1)!.id}`)).data;
      expect(item.images).toEqual([expect.objectContaining({ name: 'collab-17-account-dev.png', author: 'claude', mime: 'image/png', comment_id: null })]);
      expect(item.comments.at(-1).body_md).toBe(`Attached the image \`collab-17-account-dev.png\` from the file \`${SHOT}\` in the session checkout.`);
      // served the same way as a pasted image
      const img = item.images[0];
      const got = await fetch(`${s.base}/api/images/${img.id}/${img.name}`);
      expect(got.status).toBe(200);
      expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
    });

    it('checks the type and the size again', async () => {
      await expect(s.ctx.sessions.rpc(sessionId, 'attach_image', { key: 'PI-1', path: 'a.txt', data: Buffer.from('hello, not an image').toString('base64') })).rejects.toThrow(/not an image/);
      await expect(s.ctx.sessions.rpc(sessionId, 'attach_image', { key: 'PI-1', path: 'big.png', data: Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]).toString('base64') })).rejects.toThrow(/too large: the limit is 15 MB/);
    });

    it('attaches only to an item the session may change', async () => {
      await expect(s.ctx.sessions.rpc(sessionId, 'attach_image', { key: 'OT-1', path: SHOT, data: PNG.toString('base64') })).rejects.toThrow(/OT-1 is not in project PI/);
      const p = s.ctx.store.projectByKey('PI')!;
      const discuss = s.ctx.store.createSession({ started_by: OWNER,
        project_id: p.id, kind: 'discuss', title: 'd', status: 'idle', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [],
        worker_id: s.ctx.workers.legacy().id,
      });
      await expect(s.ctx.sessions.rpc(discuss.id, 'attach_image', { key: 'PI-1', path: SHOT, data: PNG.toString('base64') })).rejects.toThrow(/discussion cannot attach/);
    });
  });
});
