import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageMarkers, withImageMarkers } from '../src/shared/chatImages.ts';
import { userContent } from '../src/worker/runner.ts';
import { startServer, startWorker, stopWorker, waitFor, OWNER } from './helpers.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const FILE = '0123abcd-0000-4000-8000-000000000001.png';

describe('images pasted into a chat (DISP-34)', () => {
  it('names the images in the text, and sends them to Claude as image blocks after it', async () => {
    const text = withImageMarkers('See this', [FILE]);
    expect(text).toBe(`See this\n\n[pasted image ${FILE}]`);
    expect(imageMarkers(text)).toEqual([FILE]);
    expect(await userContent('plain', async () => { throw new Error('not asked'); })).toBe('plain');
    expect(await userContent(text, async (f) => ({ mime: 'image/png', data: f === FILE ? PNG : '' }))).toEqual([
      { type: 'text', text },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ]);
    // an image that cannot be fetched does not lose the message
    const [, note] = (await userContent(text, async () => { throw new Error('gone'); })) as { text: string }[];
    expect(note.text).toMatch(/could not be loaded: gone/);
  });

  describe('with a worker', () => {
    let s: Awaited<ReturnType<typeof startServer>>;
    let worker: ChildProcess;
    beforeAll(async () => {
      s = await startServer({ DATA_DIR: mkdtempSync(`${tmpdir()}/dsp-chimg-`) });
      worker = startWorker(s.port);
      await s.call('POST', '/projects', { key: 'PI', name: 'Paste' });
      await s.call('POST', '/projects/PI/items', { title: 'Login breaks' });
      await waitFor(() => s.ctx.hub.connected, 'worker connection');
    });
    afterAll(async () => {
      await stopWorker(worker);
      await s.app.close();
    });

    const upload = (body: Buffer, type = 'image/png') =>
      fetch(`${s.base}/api/chat-images`, { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(body) });

    it('the session reads a pasted image and attaches it to an item', async () => {
      const p = s.ctx.store.projectByKey('PI')!;
      const sess = s.ctx.store.createSession({ started_by: OWNER,
        project_id: p.id, kind: 'work', title: 't', status: 'idle', force_plan: false, branch: 'dispatch/pi-1-t', initial_prompt: '', source_id: null, item_ids: [],
        worker_id: s.ctx.workers.legacy().id,
      });
      // not an image: refused
      expect((await upload(Buffer.from('#!/bin/sh'), 'application/octet-stream')).status).toBe(415);
      const up = await upload(Buffer.from(PNG, 'base64'));
      expect(up.status).toBe(200);
      const { file } = await up.json();
      const url = `/api/sessions/${sess.id}/attachments/${file}`;
      // an unknown image, or none at all with no text: refused
      expect((await s.call('POST', `/sessions/${sess.id}/messages`, { text: 'x', images: ['0123abcd-0000-4000-8000-00000000ffff.png'] })).status).toBe(400);
      expect((await s.call('POST', `/sessions/${sess.id}/messages`, { text: ' ', images: [] })).status).toBe(400);

      expect((await s.call('POST', `/sessions/${sess.id}/messages`, { text: 'attach it to PI-1', images: [file] })).status).toBe(200);
      const d = await waitFor(async () => {
        const x = (await s.call('GET', `/sessions/${sess.id}`)).data;
        return x.events.some((e: { body: { text?: string } }) => e.body.text?.startsWith('(fake) I see 1 pasted image')) && x;
      }, 'the reply');
      // the owner's message shows the text and the image, not the marker
      const mine = d.events.find((e: { body: { kind: string } }) => e.body.kind === 'user').body;
      expect(mine).toEqual({ kind: 'user', text: 'attach it to PI-1', images: [{ url, media_type: 'image/png' }] });
      expect(d.events.find((e: { body: { text?: string } }) => e.body.text?.startsWith('(fake) I see')).body.text).toContain(`image/png ${Buffer.from(PNG, 'base64').length} bytes. Attached the first to PI-1.`);
      const item = (await s.call('GET', `/items/${s.ctx.store.itemByNumber(p.id, 1)!.id}`)).data;
      expect(item.images).toEqual([expect.objectContaining({ name: 'screenshot.png', author: 'claude', mime: 'image/png' })]);
    });

    it('only a message with an image may have no text', async () => {
      const p = s.ctx.store.projectByKey('PI')!;
      const sess = s.ctx.store.createSession({ started_by: OWNER,
        project_id: p.id, kind: 'work', title: 't2', status: 'idle', force_plan: false, branch: 'dispatch/pi-2-t', initial_prompt: '', source_id: null, item_ids: [],
        worker_id: s.ctx.workers.legacy().id,
      });
      const { file } = await (await upload(Buffer.from(PNG, 'base64'))).json();
      expect((await s.call('POST', `/sessions/${sess.id}/messages`, { text: '', images: [file] })).status).toBe(200);
      await waitFor(async () => (await s.call('GET', `/sessions/${sess.id}`)).data.events.some((e: { body: { text?: string } }) => e.body.text === '(fake) I see 1 pasted image(s): image/png 70 bytes.'), 'the reply');
    });

    it('the first message of a new Assistant chat can be a screenshot: it files a bug with the image', async () => {
      const { file } = await (await upload(Buffer.from(PNG, 'base64'))).json();
      const sess = (await s.call('POST', '/assistant/messages', { text: 'log a bug in PI', images: [file] })).data;
      expect(sess.kind).toBe('assistant');
      const d = await waitFor(async () => {
        const x = (await s.call('GET', `/sessions/${sess.id}`)).data;
        return x.events.some((e: { body: { text?: string } }) => e.body.text?.includes('Attached the first to PI-2')) && x;
      }, 'the reply');
      expect(d.events[0].body).toEqual({ kind: 'user', text: 'log a bug in PI', images: [{ url: `/api/sessions/${sess.id}/attachments/${file}`, media_type: 'image/png' }] });
      const p = s.ctx.store.projectByKey('PI')!;
      const bug = (await s.call('GET', `/items/${s.ctx.store.itemByNumber(p.id, 2)!.id}`)).data;
      expect(bug).toMatchObject({ type: 'bug', title: '(fake) Error from the screenshot' });
      expect(bug.images).toEqual([expect.objectContaining({ author: 'claude', mime: 'image/png' })]);
      // the image moved into the chat: it cannot be sent again from the waiting area to another chat
      expect((await s.call('POST', '/items/' + bug.id + '/discuss', { text: 'x', images: [file] })).status).toBe(400);
      // the assistant also reads items, their images, and comments, in any project
      const c = (await s.ctx.sessions.rpc(sess.id, 'add_comment', { key: 'PI-2', body: 'Seen again today.' })) as { id: number };
      const got = (await s.ctx.sessions.rpc(sess.id, 'get_item', { key: 'pi-2' })) as { comments: { body_md: string }[]; images: { id: number }[] };
      expect(got.comments.map((x) => x.body_md)).toEqual(['Seen again today.']);
      expect(await s.ctx.sessions.rpc(sess.id, 'get_image', { id: got.images[0].id })).toMatchObject({ mime: 'image/png', data: PNG });
      expect(c.id).toBeGreaterThan(0);
    });
  });
});
