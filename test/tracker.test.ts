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

  it('stores tags and modules, de-duplicated, and suggests them per project', async () => {
    const a = (await s.call('POST', '/projects/HC/items', { title: 'Tagged', labels: ['UX', ' ux ', 'perf', ''], modules: ['charts'] })).data;
    expect(a).toMatchObject({ labels: ['UX', 'perf'], modules: ['charts'] });
    await s.call('POST', '/projects/HC/items', { title: 'Also', labels: ['ux'], modules: ['charts', 'export'] });
    const f = (await s.call('GET', '/projects/HC/facets')).data;
    expect(f.modules).toEqual([{ name: 'charts', count: 2 }, { name: 'export', count: 1 }]);
    expect(f.tags[0]).toMatchObject({ count: 2 }); // UX and ux count as one
    const patched = (await s.call('PATCH', `/items/${a.id}`, { modules: [] })).data;
    expect(patched.modules).toEqual([]);
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
    const { secret } = s.ctx.access.createToken('test', ['read'], null);
    expect((await s.call('GET', '/projects', undefined, { authorization: `Bearer ${secret}` })).status).toBe(200);
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

describe('auth bypass attempts', () => {
  it('protects routes reached through percent-encoded paths', async () => {
    const s = await startServer({ DISABLE_AUTH: '0', APP_PASSWORD: 'pw' });
    for (const url of ['/%61pi/projects', '/%61pi/settings', '/api/%70rojects', '/%61%70%69/settings']) {
      const r = await s.app.inject({ method: 'GET', url });
      expect(r.statusCode, url).not.toBe(200);
      expect(r.body).not.toContain('dsp_');
    }
    expect((await s.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(200);
    await s.app.close();
  });
});

describe('static files', () => {
  it('404s missing assets instead of answering with index.html', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(`${tmpdir()}/dsp-web-`);
    writeFileSync(`${dir}/index.html`, '<!doctype html><title>x</title>');
    const s = await startServer({ WEB_DIST: dir });
    expect((await s.app.inject({ url: '/assets/index-OLD.js' })).statusCode).toBe(404);
    expect((await s.app.inject({ url: '/icon-old.png' })).statusCode).toBe(404);
    const page = await s.app.inject({ url: '/items/3' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    await s.app.close();
  });
});

describe('partial updates leave other fields alone', () => {
  it('marking an item, editing a project/repo/source changes only what was sent', async () => {
    const s = await startServer();
    await s.call('POST', '/projects', { key: 'PT', name: 'Patch', description: 'keep me', importance_scale: ['a', 'b', 'c', 'd'], effort_scale: ['1', '2', '3'] });
    const src = (await s.call('POST', '/projects/PT/sources', { kind: 'user_report', title: 'Src', body_md: 'text', reporter: 'alex', version_tag: 'v1' })).data;
    const it = (await s.call('POST', '/projects/PT/items', {
      type: 'bug', title: 'T', body_md: 'Full description', status: 'todo', importance: 4, effort: 2, source_id: src.id, labels: ['ux'], modules: ['charts'],
    })).data;
    const marked = (await s.call('PATCH', `/items/${it.id}`, { marked: true })).data;
    expect(marked).toMatchObject({ marked: true, type: 'bug', body_md: 'Full description', status: 'todo', importance: 4, effort: 2, source_id: src.id, labels: ['ux'], modules: ['charts'] });
    const p = (await s.call('PATCH', '/projects/PT', { default_force_plan: true })).data;
    expect(p).toMatchObject({ description: 'keep me', importance_scale: ['a', 'b', 'c', 'd'], effort_scale: ['1', '2', '3'], default_force_plan: true });
    const repo = (await s.call('POST', '/projects/PT/repos', { github_owner: 'me', github_name: 'r', default_branch: 'develop' })).data;
    expect((await s.call('PATCH', `/repos/${repo.id}`, { check_command: 'npm test' })).data).toMatchObject({ default_branch: 'develop', check_command: 'npm test' });
    expect((await s.call('PATCH', `/sources/${src.id}`, { title: 'Renamed' })).data).toMatchObject({ kind: 'user_report', body_md: 'text', reporter: 'alex', version_tag: 'v1' });
    await s.app.close();
  });
});
