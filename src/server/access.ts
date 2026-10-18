// Who is asking, and what they may do.
//
// A request is made by a signed-in user (password cookie, or a trusted proxy's user header), by a
// named personal token, or by an OAuth client (MCP). Every /api route needs one scope:
//   read     read anything
//   tracker  items, comments, sources, images
//   sessions start, steer and merge agent work (runs code on this machine)
//   admin    projects, repos, settings, push
// Users have every scope. Tokens have the scopes they were made with, but only `remoteTokenScopes`
// (read + tracker by default) when the request does not come from this machine, so a leaked token
// can never start agents from outside.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { Auth } from './auth.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';

export const SCOPES = ['read', 'tracker', 'sessions', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

/** `public`: no sign-in; `user`: a signed-in person only (no token or OAuth client), e.g. making tokens. */
export type RouteAccess = Scope | 'public' | 'user';

/** Every /api route and what it needs. A test checks that no route is missing. */
export const ROUTE_ACCESS: Record<string, RouteAccess> = {
  'POST /api/login': 'public',
  'POST /api/logout': 'public',
  'GET /api/me': 'public',

  'GET /api/inbox': 'read',
  'GET /api/stream': 'read',
  'GET /api/worker': 'read',
  'GET /api/accounts': 'read',
  'GET /api/projects': 'read',
  'GET /api/projects/:key': 'read',
  'GET /api/projects/:key/items': 'read',
  'GET /api/projects/:key/facets': 'read',
  'GET /api/projects/:key/file': 'read',
  'GET /api/projects/:key/sources': 'read',
  'GET /api/items/:id': 'read',
  'GET /api/items/by-key/:key': 'read',
  'GET /api/items/:id/discuss': 'read',
  'GET /api/images/:id/:name': 'read',
  'GET /api/sources/:id': 'read',
  'GET /api/sessions': 'read',
  'GET /api/sessions/:id': 'read',
  'GET /api/sessions/:id/attachments/:name': 'read',
  'GET /api/prs/:id': 'read',
  'GET /api/assistant': 'read',

  'POST /api/projects/:key/items': 'tracker',
  'PATCH /api/items/:id': 'tracker',
  'DELETE /api/items/:id': 'tracker',
  'POST /api/items/:id/comments': 'tracker',
  'POST /api/items/:id/images': 'tracker',
  'DELETE /api/images/:id': 'tracker',
  'POST /api/projects/:key/sources': 'tracker',
  'PATCH /api/sources/:id': 'tracker',
  'POST /api/sources/:id/items': 'tracker',

  'POST /api/projects/:key/batches': 'sessions',
  'POST /api/projects/:key/planner': 'sessions',
  'POST /api/assistant/messages': 'sessions',
  'POST /api/assistant/new': 'sessions',
  'POST /api/items/:id/discuss': 'sessions',
  'POST /api/items/:id/discuss/new': 'sessions',
  'POST /api/inputs/:id/answer': 'sessions',
  'POST /api/sessions/:id/messages': 'sessions',
  'POST /api/sessions/:id/interrupt': 'sessions',
  'POST /api/sessions/:id/finish': 'sessions',
  'POST /api/sessions/:id/start-now': 'sessions',
  'POST /api/sessions/:id/pause': 'sessions',
  'POST /api/sessions/:id/move': 'sessions',
  'POST /api/sessions/:id/resume': 'sessions',
  'POST /api/sessions/:id/sync-prs': 'sessions',
  'POST /api/sessions/:id/prs': 'sessions',
  'POST /api/sessions/:id/accept-items': 'sessions',
  'POST /api/sessions/:id/apply-update': 'sessions',
  'POST /api/sessions/:id/dismiss-proposal': 'sessions',
  'POST /api/prs/:id/merge': 'sessions',
  'POST /api/prs/:id/resolve-conflicts': 'sessions',
  'POST /api/cleanup': 'sessions',
  'POST /api/cleanup/check': 'sessions',

  'POST /api/projects': 'admin',
  'PATCH /api/projects/:key': 'admin',
  'POST /api/projects/:key/repos': 'admin',
  'PATCH /api/repos/:id': 'admin',
  'DELETE /api/repos/:id': 'admin',
  'GET /api/settings': 'admin',
  'PATCH /api/settings': 'admin',
  'GET /api/push/devices': 'admin',
  'POST /api/push/subscribe': 'admin',
  'POST /api/push/unsubscribe': 'admin',
  'POST /api/push/keep-only': 'admin',
  'POST /api/push/test': 'admin',

  'GET /api/tokens': 'user',
  'POST /api/tokens': 'user',
  'DELETE /api/tokens/:id': 'user',
  'GET /api/workers': 'read',
  'POST /api/workers': 'user',
  'PATCH /api/workers/:id': 'user',
  'DELETE /api/workers/:id': 'user',
  'PUT /api/settings/default-worker': 'user',
  'GET /api/oauth/grants': 'user',
  'DELETE /api/oauth/grants/:id': 'user',
};

export interface Principal {
  kind: 'user' | 'token' | 'oauth';
  /** user name, token name or OAuth client name */
  name: string;
  scopes: Set<Scope>;
  /** the request came from this machine (not through the proxy or the LAN) */
  local: boolean;
  token_id?: number;
}

export interface ApiToken {
  id: number;
  name: string;
  prefix: string;
  scopes: Scope[];
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();

// ---------- addresses ----------

/** IPv4-mapped IPv6 ("::ffff:1.2.3.4") as plain IPv4. */
export function plainIp(ip: string | undefined): string {
  return (ip ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
}

export function isLoopback(ip: string | undefined) {
  const p = plainIp(ip);
  return p === '::1' || /^127\./.test(p);
}

const v4 = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;

/** Is `ip` one of `list` (single addresses or IPv4 CIDRs)? */
export function ipInList(ip: string | undefined, list: string[]) {
  const p = plainIp(ip);
  return list.some((entry) => {
    const [base, bits] = entry.split('/');
    if (bits === undefined) return plainIp(base) === p;
    if (isIP(base) !== 4 || isIP(p) !== 4) return false;
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (v4(base) & mask) === (v4(p) & mask);
  });
}

// ---------- access ----------

export class Access {
  private cfg: Config;
  private db: Db;
  private auth: Auth;

  constructor(cfg: Config, db: Db, auth: Auth) {
    this.cfg = cfg;
    this.db = db;
    this.auth = auth;
  }

  private from(req: FastifyRequest) {
    const ip = req.socket.remoteAddress;
    let proxy = ipInList(ip, this.cfg.trustedProxies);
    if (proxy && this.cfg.proxySecret) {
      // the proxy's host is shared (other containers have its address): the proxy proves itself
      const got = Buffer.from(String(req.headers[this.cfg.proxySecretHeader] ?? ''));
      const want = Buffer.from(this.cfg.proxySecret);
      proxy = got.length === want.length && timingSafeEqual(got, want);
    }
    return { local: isLoopback(ip), proxy };
  }

  /**
   * Proxy mode turns away anything that is neither from this machine nor from the proxy, for every
   * path (app, API, worker socket): the port must not be a way around the proxy's sign-in.
   */
  refused(req: FastifyRequest): boolean {
    if (this.cfg.authMode !== 'proxy') return false;
    const f = this.from(req);
    return !f.local && !f.proxy;
  }

  /** A person signed in through the browser, or null. Tokens and OAuth clients are not people. */
  browserUser(req: FastifyRequest): string | null {
    if (this.cfg.authMode === 'off') return 'local';
    const f = this.from(req);
    if (this.cfg.authMode === 'proxy') {
      if (f.proxy) {
        const user = String(req.headers[this.cfg.authHeader] ?? '').trim();
        if (!user) return null;
        if (this.cfg.authUsers.length && !this.cfg.authUsers.includes(user)) return null;
        return user;
      }
      // the password login is the way in from this machine when the proxy is down
      if (!f.local || (!this.cfg.appPassword && !this.cfg.appPasswordHash)) return null;
    }
    return this.auth.hasSessionCookie(req) ? 'owner' : null;
  }

  /** Who is making this request, or null (not signed in, or a bad token). */
  principal(req: FastifyRequest): Principal | null {
    const { local } = this.from(req);
    const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (bearer) return this.tokenPrincipal(bearer, local);
    const user = this.browserUser(req);
    return user ? { kind: 'user', name: user, scopes: new Set(SCOPES), local } : null;
  }

  private limit(scopes: Scope[], local: boolean): Set<Scope> {
    return new Set(local ? scopes : scopes.filter((s) => this.cfg.remoteTokenScopes.includes(s)));
  }

  private tokenPrincipal(secret: string, local: boolean): Principal | null {
    // the single token from before named tokens: kept working until it is retired in Settings
    const legacy = this.db.setting('api_token');
    if (legacy && secret.length === legacy.length && timingSafeEqual(Buffer.from(secret), Buffer.from(legacy))) {
      return { kind: 'token', name: 'legacy API token', scopes: this.limit([...SCOPES], local), local };
    }
    const row = this.db.get<{ id: number; name: string; scopes: string; expires_at: string | null; revoked_at: string | null }>(
      'SELECT id, name, scopes, expires_at, revoked_at FROM api_tokens WHERE hash = ?', sha256(secret),
    );
    if (!row || row.revoked_at || (row.expires_at && row.expires_at < now())) return null;
    this.db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), row.id);
    return { kind: 'token', name: row.name, scopes: this.limit(JSON.parse(row.scopes), local), local, token_id: row.id };
  }

  // ---------- named tokens ----------

  tokens(): ApiToken[] {
    return this.db.all<Record<string, unknown>>('SELECT * FROM api_tokens ORDER BY id DESC').map((r) => ({
      id: Number(r.id), name: String(r.name), prefix: String(r.prefix), scopes: JSON.parse(String(r.scopes)),
      created_at: String(r.created_at), expires_at: (r.expires_at as string | null) ?? null,
      last_used_at: (r.last_used_at as string | null) ?? null, revoked_at: (r.revoked_at as string | null) ?? null,
    }));
  }

  /** A new token; its secret is returned this once and only its hash is kept. */
  createToken(name: string, scopes: Scope[], expiresAt: string | null): { token: ApiToken; secret: string } {
    const secret = `dsp_${randomBytes(32).toString('base64url')}`;
    const { lastId } = this.db.run(
      'INSERT INTO api_tokens (name, prefix, hash, scopes, expires_at) VALUES (?, ?, ?, ?, ?)',
      name, secret.slice(0, 10), sha256(secret), JSON.stringify(scopes), expiresAt,
    );
    return { token: this.tokens().find((t) => t.id === Number(lastId))!, secret };
  }

  revokeToken(id: number) {
    this.db.run('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), id);
  }

  hasLegacyToken() {
    return !!this.db.setting('api_token');
  }

  retireLegacyToken() {
    this.db.run("DELETE FROM settings WHERE key = 'api_token'");
  }
}
