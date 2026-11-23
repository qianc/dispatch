// DISP-237 (fourth audit, 16-20 and 23) and DISP-248 (90, 91, 93): the remaining ways in for a
// person taken off AUTH_USERS, a paired phone, or a crafted token, link or header.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { clientIp, safeEqual, SCOPES } from '../src/server/access.ts';
import { loadConfig } from '../src/server/config.ts';
import { Db } from '../src/server/db.ts';
import { Identities } from '../src/server/identities.ts';
import { trackerTools } from '../src/server/mcp.ts';
import { SecretBox } from '../src/server/secretBox.ts';
import { Users } from '../src/server/users.ts';
import { workerFromToken } from '../src/server/workers.ts';
import type { GithubAccess } from '../src/shared/types.ts';
import { as, startMultiUser, startServer } from './helpers.ts';
import { renderPage, stubBrowser } from './web-render.ts';

beforeAll(stubBrowser);

/** bob's phone, paired: its cookie */
function pairPhone(s: Awaited<ReturnType<typeof startMultiUser>>, user = 'bob') {
  const { pair_id, code } = s.ctx.devices.start('iPhone', '127.0.0.1')!;
  s.ctx.devices.approve(code, user);
  const c = s.ctx.devices.collect(pair_id);
  if (c.status !== 'approved') throw new Error('not approved');
  return `dispatch_device=${c.secret}`;
}

describe('a person taken off AUTH_USERS (DISP-237)', () => {
  it('16: is left off the GitHub access card, and GitHub is never asked as them', async () => {
    const s = await startMultiUser({ GITHUB_TOKEN: 'ghp_sharedEnvToken01' });
    try {
      s.ctx.identities.profile = async () => ({ id: 42, login: 'bob-gh', name: 'Bob', email: 'bob@example.com', scopes: 'repo' });
      s.ctx.github.accountsInfo = async () => [{ name: 'default', login: 'alice-gh', git_name: null, git_email: null }];
      await s.call('POST', '/projects', { key: 'GH', name: 'GitHub' }, as('alice'));
      await s.call('POST', '/projects/GH/repos', { github_owner: 'me', github_name: 'gh' }, as('alice'));
      await s.call('PUT', '/me/github', { token: 'ghp_bobsOwnToken0001' }, as('bob'));
      const asked: string[] = [];
      s.ctx.github.clientForToken = (t: string) => {
        asked.push(t);
        return s.ctx.github.octo!;
      };
      s.ctx.cfg.authUsers = ['alice'];
      const r = await s.call<GithubAccess>('GET', '/projects/GH/github-access?verify=1', undefined, as('alice'));
      expect(r.data.accounts.map((a) => a.user)).toEqual(['alice']);
      expect(asked).toEqual([]);
    } finally {
      await s.app.close();
    }
  });

  it('17: their notices go to the install owner instead', async () => {
    const s = await startMultiUser();
    try {
      const notice = { title: 'X: waiting for you', body: 'secret text', url: '/s/1', tag: 't' };
      await s.ctx.notifier.send(notice, 'bob');
      expect(s.ctx.notifier.sent.at(-1)!.to).toEqual(['bob']);
      s.ctx.cfg.authUsers = ['alice'];
      await s.ctx.notifier.send(notice, 'bob');
      expect(s.ctx.notifier.sent.at(-1)!.to).toEqual(['alice']);
      await s.ctx.notifier.send(notice, ['bob', 'alice']);
      expect(s.ctx.notifier.sent.at(-1)!.to).toEqual(['alice']);
    } finally {
      await s.app.close();
    }
  });
});

describe('AUTH_USERS without the install owner (DISP-237, 18)', () => {
  it('lets the owner in all the same, with a warning at start', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfg = loadConfig({ WORKER_TOKEN: 'w', AUTH_MODE: 'proxy', TRUSTED_PROXIES: '127.0.0.1', DISPATCH_OWNER: 'carol', AUTH_USERS: 'bob' });
      expect(cfg.authUsers).toEqual(['bob', 'carol']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaves out the install owner "carol"'));
      // the owner's legacy worker is not refused
      const legacy = { id: 1, owner: 'carol' };
      expect(workerFromToken({ legacy: () => legacy } as never, cfg, 'w')).toBe(legacy);
      warn.mockClear();
      expect(loadConfig({ WORKER_TOKEN: 'w', AUTH_MODE: 'proxy', TRUSTED_PROXIES: '127.0.0.1', AUTH_USERS: 'alice,bob' }).authUsers).toEqual(['alice', 'bob']);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('a paired phone (DISP-237, 19)', () => {
  it('cannot make API tokens', async () => {
    const s = await startMultiUser();
    try {
      const cookie = pairPhone(s);
      const r = await s.app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: 'phone', scopes: ['read'] } });
      expect(r.statusCode).toBe(403);
      // a browser signed in through the proxy still can
      expect((await s.call('POST', '/tokens', { name: 'laptop', scopes: ['read'] }, as('bob'))).status).toBe(200);
    } finally {
      await s.app.close();
    }
  });

  it('cannot approve an OAuth app', async () => {
    const s = await startMultiUser();
    try {
      const cookie = pairPhone(s);
      const reg = await s.app.inject({ method: 'POST', url: '/register', payload: { client_name: 'Claude', redirect_uris: ['http://localhost:33418/callback'] } });
      const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
      const q = new URLSearchParams({ response_type: 'code', client_id: reg.json().client_id, redirect_uri: 'http://localhost:33418/callback', code_challenge: challenge, code_challenge_method: 'S256' });
      const consent = await s.app.inject({ method: 'GET', url: `/authorize?${q}`, headers: { cookie } });
      expect(consent.statusCode).toBe(401);
      expect(consent.body).not.toContain('name="request"');
      // the proxy's signed-in person gets the consent page
      expect((await s.app.inject({ method: 'GET', url: `/authorize?${q}`, headers: as('bob') })).statusCode).toBe(200);
    } finally {
      await s.app.close();
    }
  });
});

describe('the owner moving from a placeholder (DISP-237, 20)', () => {
  it('takes their GitHub connection and orchestrator defaults along', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-move-'));
    try {
      const db = new Db(join(dir, 'd.db'));
      const box = new SecretBox(randomBytes(32));
      const identities = new Identities(db, box, loadConfig({ WORKER_TOKEN: 'w', DISABLE_AUTH: '1' }));
      new Users(db, { installOwner: 'owner' }, identities).claim();
      db.run(
        "INSERT INTO github_identities (user, kind, github_id, login, git_name, git_email, token_enc, scopes) VALUES ('owner', 'pat', 7, 'me-gh', 'Me', 'me@example.com', ?, 'repo')",
        box.seal('ghp_mine', 'github:owner'),
      );
      db.setSetting('orchestrator_default:owner', '{"model":"x"}');
      new Users(db, { installOwner: 'carol' }, identities).claim();
      expect(identities.get('carol')).toMatchObject({ login: 'me-gh', token: 'ghp_mine' });
      expect(identities.get('owner')).toBeNull();
      expect(db.setting('orchestrator_default:carol')).toBe('{"model":"x"}');
      expect(db.setting('orchestrator_default:owner')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('markdown links (DISP-237, 23)', () => {
  // markdown sends `/\` on as `/%5C`, a path here; inAppHref turns away a raw one
  const evil = '[a](//evil.example/login) [c](/items/3)';
  const check = (html: string) => {
    expect(html).toMatch(/<a href="\/\/evil.example\/login" target="_blank" rel="noreferrer">/);
    expect(html).toMatch(/<a href="\/items\/3"(?! target)/);
  };
  it('Md opens //host in a new tab', async () => {
    const { Md, inAppHref } = await import('../web/src/components/ui.tsx');
    expect([inAppHref('/items/1'), inAppHref('//x'), inAppHref('/\\x'), inAppHref('https://x')]).toEqual([true, false, false, false]);
    check(renderPage(createElement(Md, { children: evil })));
  });
  it('RichMd opens //host in a new tab', async () => {
    const { RichMd } = await import('../web/src/components/RichMd.tsx');
    check(renderPage(createElement(RichMd, { ctx: { project: { id: 1, key: 'P' } }, children: evil })));
  });
});

describe('DISP-248', () => {
  it('90: MCP item tools tidy tags as the API does', async () => {
    const s = await startServer();
    try {
      await s.call('POST', '/projects', { key: 'TG', name: 'Tags' });
      const server = trackerTools(s.ctx.store, s.ctx.bus, null, { kind: 'oauth', name: 'test', scopes: new Set(SCOPES), local: true, user: 'owner' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const client = new Client({ name: 'test', version: '1' });
      await client.connect(b);
      const call = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text;
      const out = await call('add_item', { project: 'TG', title: 'x', tags: [' ui ', 'UI', '', 'api'], modules: ['m', ' M '] });
      const created = JSON.parse(out).created;
      const item = () => s.ctx.store.items(s.ctx.store.projectByKey('TG')!.id).find((i) => i.key === created)!;
      const it = item();
      expect([it.labels, it.modules]).toEqual([['ui', 'api'], ['m']]);
      await call('update_item', { key: created, add_tags: [' Api', ' new '], remove_tags: [' UI '] });
      expect(item().labels).toEqual(['api', 'new']);
    } finally {
      await s.app.close();
    }
  });

  it('91: a token with non-ASCII characters is a plain mismatch (401), not a crash', async () => {
    expect(safeEqual('abcd', 'abcd')).toBe(true);
    expect(safeEqual('abcé', 'abcd')).toBe(false);
    const s = await startServer({ WORKER_TOKEN: 'wxyz' });
    try {
      s.ctx.store.db.setSetting('api_token', 'abcd');
      const r = await s.app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: 'Bearer abcé' } });
      expect(r.statusCode).toBe(401);
      expect(workerFromToken(s.ctx.workers, s.ctx.cfg, 'wxyé')).toBeNull();
    } finally {
      await s.app.close();
    }
  });

  it('93: X-Forwarded-For entries with a port count as their address', () => {
    const req = (xff: string) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': xff } }) as never;
    expect(clientIp(req('192.0.2.1:5678'), [])).toBe('192.0.2.1');
    expect(clientIp(req('[2001:db8:1:2::1]:443'), [])).toBe('2001:db8:1:2::/64');
    // a trusted proxy that adds its port is still skipped
    expect(clientIp(req('192.0.2.1, 10.0.0.5:8080'), ['10.0.0.5'])).toBe('192.0.2.1');
  });
});
