import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolResultImages } from '../src/worker/runner.ts';
import { startServer } from './helpers.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('images in tool results', () => {
  it('picks base64 images out of a tool result', () => {
    expect(toolResultImages([{ type: 'text', text: 'x' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]))
      .toEqual([{ media_type: 'image/png', data: PNG }]);
    expect(toolResultImages('plain text')).toEqual([]);
    expect(toolResultImages([{ type: 'image', source: { type: 'url', url: 'http://x' } }])).toEqual([]);
  });

  describe('server', () => {
    let s: Awaited<ReturnType<typeof startServer>>;
    beforeAll(async () => {
      s = await startServer({ DATA_DIR: (await import('node:fs')).mkdtempSync(`${(await import('node:os')).tmpdir()}/dsp-att-`) });
    });
    afterAll(() => s.app.close());

    it('stores them as files and serves them; nothing else under that route', async () => {
      await s.call('POST', '/projects', { key: 'IM', name: 'Img' });
      const sess = s.ctx.store.createSession({ project_id: 1, kind: 'work', title: 't', status: 'running', force_plan: false, branch: 'b', initial_prompt: '', source_id: null, item_ids: [] });
      s.ctx.sessions.onWorkerMessage({ t: 'event', session_id: sess.id, body: { kind: 'tool_result', tool_use_id: 'u', is_error: false, text: '' }, images: [{ media_type: 'image/png', data: PNG }] });
      const ev = (await s.call('GET', `/sessions/${sess.id}`)).data.events.at(-1);
      expect(ev.body.images).toHaveLength(1);
      const res = await fetch(`${s.base}${ev.body.images[0].url}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(PNG, 'base64'));
      expect(JSON.stringify(ev.body)).not.toContain(PNG.slice(0, 20)); // the event holds a URL, not the bytes
      for (const bad of ['..%2F..%2Fdispatch.db', 'x.png', 'evil.sh']) {
        expect((await fetch(`${s.base}/api/sessions/${sess.id}/attachments/${bad}`)).status).toBe(404);
      }
    });
  });
});
