import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './helpers.ts';

describe('tracker API', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'HC', name: 'Homecontrol', effort_scale: ['1', '2', '3', '5', '8'] });
  });
  afterAll(() => s.app.close());

  it('numbers items per project and returns keys', async () => {
    const a = await s.call('POST', '/projects/HC/items', { title: 'First' });
    const b = await s.call('POST', '/projects/HC/items', { title: 'Second', type: 'bug', importance: 4, effort: 3 });
    expect(a.data.key).toBe('HC-1');
    expect(b.data).toMatchObject({ key: 'HC-2', type: 'bug', importance: 4, effort: 3 });
    const byKey = await s.call('GET', '/items/by-key/hc-2');
    expect(byKey.data.title).toBe('Second');
  });

  it('validates importance (1–4) and effort against the project scale', async () => {
    expect((await s.call('POST', '/projects/HC/items', { title: 'x', importance: 5 })).status).toBe(400);
    expect((await s.call('POST', '/projects/HC/items', { title: 'x', effort: 5 })).status).toBe(400);
  });

  it('requires exactly 4 importance labels', async () => {
    const r = await s.call('POST', '/projects', { key: 'BAD', name: 'Bad', importance_scale: ['a', 'b', 'c'] });
    expect(r.status).toBe(400);
  });

  it('captures a retro with reporter and version, and links split items back to it', async () => {
    const r = await s.call('POST', '/projects/HC/sources', {
      kind: 'retro', title: 'Skill retro', body_md: '- A broke\n- B slow', reporter: 'alex', version_tag: 'v2.1.0', skill_name: 'deck-builder',
      items: [{ type: 'bug', title: 'A broke', importance: 3 }],
    });
    expect(r.status).toBe(200);
    expect(r.data.items[0]).toMatchObject({ source_id: r.data.id, status: 'triage' });
    const more = await s.call('POST', `/sources/${r.data.id}/items`, { items: [{ title: 'B slow', importance: 2, effort: 1 }] });
    expect(more.data[0].source_id).toBe(r.data.id);
    const src = await s.call('GET', `/sources/${r.data.id}`);
    expect(src.data).toMatchObject({ reporter: 'alex', version_tag: 'v2.1.0', skill_name: 'deck-builder' });
    expect(src.data.items.map((i: { title: string }) => i.title).sort()).toEqual(['A broke', 'B slow']);
    const item = await s.call('GET', `/items/${r.data.items[0].id}`);
    expect(item.data.source.title).toBe('Skill retro');
  });

  it('refuses to start a batch without a repo', async () => {
    const r = await s.call('POST', '/projects/HC/batches', { item_ids: [1] });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/repo/);
  });
});

describe('auth', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    s = await startServer({ DISABLE_AUTH: '0', APP_PASSWORD: 'pw' });
  });
  afterAll(() => s.app.close());

  it('blocks the API without a session, allows login and bearer token', async () => {
    expect((await s.call('GET', '/projects')).status).toBe(401);
    expect((await s.call('POST', '/login', { password: 'nope' })).status).toBe(401);
    const res = await fetch(`${s.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    expect((await s.call('GET', '/projects', undefined, { cookie })).status).toBe(200);
    expect((await s.call('GET', '/projects', undefined, { authorization: `Bearer ${s.ctx.auth.apiToken}` })).status).toBe(200);
    expect((await s.call('GET', '/projects', undefined, { authorization: 'Bearer wrong' })).status).toBe(401);
  });
});

describe('password hash', () => {
  it('accepts APP_PASSWORD_HASH from hash-password.ts', async () => {
    const { hashPassword } = await import('../src/server/auth.ts');
    const hash = hashPassword('s3cret');
    expect(hash).not.toContain('$');
    const s = await startServer({ DISABLE_AUTH: '0', APP_PASSWORD_HASH: hash });
    expect((await s.call('POST', '/login', { password: 's3cret' })).status).toBe(200);
    expect((await s.call('POST', '/login', { password: 'nope' })).status).toBe(401);
    await s.app.close();
  });
});
