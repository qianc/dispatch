import { describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { startServer } from './helpers.ts';

describe('server shutdown', () => {
  // a deploy stops the server with SIGTERM and kills it 15 s later; open live streams must not
  // hold app.close() (and so the database close) past that
  it('closes while a live stream is open', async () => {
    const { app, port } = await startServer();
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/stream' }, (res) => {
        res.once('data', () => resolve());
        res.on('error', () => undefined);
      });
      req.on('error', () => undefined);
      req.once('error', reject);
      req.end();
    });
    const t0 = Date.now();
    await app.close();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
