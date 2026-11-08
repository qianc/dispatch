import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromOwnOrigin } from '../src/server/access.ts';
import { as, startMultiUser, startServer } from './helpers.ts';

// A browser sends the SSO cookie to Dispatch from any page on the same site, also from a sibling
// subdomain behind the same proxy. Changes are accepted only from Dispatch's own origin.
describe('requests from other sites', () => {
  const req = (method: string, headers: Record<string, string>) => ({ method, headers });

  it("tells Dispatch's own pages from other sites by the browser's headers", () => {
    expect(fromOwnOrigin(req('POST', {}))).toBe(true); // not a browser
    expect(fromOwnOrigin(req('POST', { 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(fromOwnOrigin(req('POST', { 'sec-fetch-site': 'none' }))).toBe(true);
    expect(fromOwnOrigin(req('POST', { 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(fromOwnOrigin(req('POST', { 'sec-fetch-site': 'cross-site', origin: 'https://d.example' }))).toBe(false);
    // older browsers: the Origin header against the host asked for
    expect(fromOwnOrigin(req('POST', { origin: 'https://d.example', host: 'd.example' }))).toBe(true);
    expect(fromOwnOrigin(req('POST', { origin: 'https://other.example', host: 'd.example' }))).toBe(false);
    expect(fromOwnOrigin(req('POST', { origin: 'null', host: 'd.example' }))).toBe(false);
    // reads are not changes
    expect(fromOwnOrigin(req('GET', { 'sec-fetch-site': 'cross-site' }))).toBe(true);
  });

  it("refuses a signed-in browser's change from another site, and lets tokens through", async () => {
    const s = await startMultiUser();
    try {
      const sibling = { ...as('alice'), 'sec-fetch-site': 'same-site' };
      expect((await s.call('POST', '/projects', { key: 'X1', name: 'x' }, sibling)).status).toBe(403);
      expect((await s.call('POST', '/projects', { key: 'X1', name: 'x' }, { ...as('alice'), origin: 'https://sibling.example' })).status).toBe(403);
      expect((await s.call('GET', '/projects', undefined, sibling)).status).toBe(200);
      expect((await s.call('POST', '/projects', { key: 'X1', name: 'x' }, { ...as('alice'), 'sec-fetch-site': 'same-origin' })).status).toBe(200);
      expect((await s.call('POST', '/projects', { key: 'X2', name: 'x' }, { ...as('alice'), origin: s.base })).status).toBe(200);
      // a token is not a cookie: another site cannot send it along, so it is not held to this
      const { secret } = (await s.call('POST', '/tokens', { name: 'ci', scopes: ['tracker'] }, as('alice'))).data;
      expect((await s.call('POST', '/projects/X1/items', { title: 'from a script' }, { authorization: `Bearer ${secret}`, 'sec-fetch-site': 'cross-site' })).status).toBe(200);
    } finally {
      await s.app.close();
    }
  });
});

// The proxy routes a request with the device cookie around its sign-in, so a user header on such a
// request is the client's own. Dispatch believes the device alone.
describe('a paired device behind the proxy', () => {
  it('counts for the device only: a user header on its request is ignored', async () => {
    const s = await startMultiUser();
    try {
      const forged = { ...as('alice'), cookie: 'dispatch_device=dsd_forged' };
      expect((await s.call('GET', '/me', undefined, forged)).data).toMatchObject({ authed: false });
      expect((await s.call('POST', '/projects', { key: 'D1', name: 'd' }, forged)).status).toBe(401);
      // a real device is the person who approved it, whatever header comes with it
      const start = (await s.call('POST', '/devices/pair')).data;
      expect((await s.call('POST', '/devices/approve', { code: start.code }, as('alice'))).status).toBe(200);
      const res = await fetch(`${s.base}/api/devices/pair/${start.pair_id}`);
      const cookie = String(res.headers.get('set-cookie')).split(';')[0];
      expect(cookie).toMatch(/^dispatch_device=dsd_/);
      expect((await s.call('GET', '/me', undefined, { cookie, ...as('bob') })).data).toMatchObject({ authed: true, user: 'alice' });
    } finally {
      await s.app.close();
    }
  });
});

describe('response headers', () => {
  it('forbid framing and sniffing on every response, the consent page included', async () => {
    const s = await startServer();
    try {
      for (const url of [`${s.base}/api/me`, `${s.base}/authorize?client_id=nope`]) {
        const res = await fetch(url);
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('referrer-policy')).toBe('same-origin');
      }
    } finally {
      await s.app.close();
    }
  });

  it('sandboxes an SVG read from a repo, so a script in it runs as nobody', async () => {
    // its own data folder: the hosted repo must not meet another test's r1.git under ./data
    const s = await startServer({ DATA_DIR: mkdtempSync(join(tmpdir(), 'dsp-svg-data-')) });
    try {
      await s.call('POST', '/projects', { key: 'SV', name: 'svg' });
      const repo = (await s.call('POST', '/projects/SV/repos', { hosted: { name: 'app' } })).data;
      const dir = mkdtempSync(join(tmpdir(), 'dsp-svg-'));
      const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
      const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' });
      git('clone', '--quiet', s.ctx.hosted.dir(repo), '.');
      writeFileSync(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      writeFileSync(join(dir, 'README.md'), '# app\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'files');
      git('push', '--quiet', 'origin', 'main');
      const svg = await fetch(`${s.base}/api/projects/SV/file?path=logo.svg`);
      expect(svg.status).toBe(200);
      expect(svg.headers.get('content-type')).toBe('image/svg+xml');
      expect(svg.headers.get('content-security-policy')).toBe("sandbox; frame-ancestors 'none'");
      expect(svg.headers.get('x-content-type-options')).toBe('nosniff');
      const md = await fetch(`${s.base}/api/projects/SV/file?path=README.md`);
      expect(md.status).toBe(200);
      expect(md.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    } finally {
      await s.app.close();
    }
  });
});
