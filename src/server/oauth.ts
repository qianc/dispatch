// OAuth 2.1 for MCP clients (Claude on any machine): dynamic client registration, authorization
// code + PKCE (S256), refresh-token rotation, revocation. The person approving is whoever the app
// already trusts in the browser: the proxy's user header, or the password session. /authorize
// therefore checks that itself, so reaching this port directly gets no code. Secrets are stored as
// SHA-256 only.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { sha256, type Access, type Principal, type Scope } from './access.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';

/** What an MCP client may ever get: reading and editing the tracker, never agent sessions. */
export const OAUTH_SCOPES: Scope[] = ['read', 'tracker'];
const ACCESS_TTL_S = 24 * 3600;
const REFRESH_TTL_S = 60 * 24 * 3600;
const CODE_TTL_MS = 10 * 60_000;
const MAX_CLIENTS = 200;

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface Client { client_id: string; name: string; redirect_uris: string[] }
interface Pending { client: Client; redirect_uri: string; challenge: string; scopes: Scope[]; state: string | null; user: string; expires: number }
interface Code { client_id: string; redirect_uri: string; challenge: string; scopes: Scope[]; user: string; expires: number }

export interface OAuthGrantInfo { id: number; client_id: string; client_name: string; user: string; scopes: Scope[]; created_at: string; last_used_at: string | null; refresh_expires_at: string; revoked_at: string | null }

/** Redirect URIs a client may register: https, or a loopback http address (native apps such as Claude Code). */
export function allowedRedirect(uri: string) {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return !u.username && !u.password;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

export class OAuth {
  private db: Db;
  private cfg: Config;
  private access: Access;
  private pending = new Map<string, Pending>();
  private codes = new Map<string, Code>();

  constructor(cfg: Config, db: Db, access: Access) {
    this.cfg = cfg;
    this.db = db;
    this.access = access;
  }

  private get issuer() {
    return this.cfg.publicUrl.replace(/\/$/, '');
  }

  metadata() {
    const i = this.issuer;
    return {
      issuer: i,
      authorization_endpoint: `${i}/authorize`,
      token_endpoint: `${i}/token`,
      registration_endpoint: `${i}/register`,
      revocation_endpoint: `${i}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: OAUTH_SCOPES,
    };
  }

  resourceMetadata() {
    return { resource: `${this.issuer}/mcp`, authorization_servers: [this.issuer], scopes_supported: OAUTH_SCOPES, bearer_methods_supported: ['header'] };
  }

  private client(id: string): Client | null {
    const r = this.db.get<{ client_id: string; name: string; redirect_uris: string }>('SELECT * FROM oauth_clients WHERE client_id = ?', id);
    return r ? { client_id: r.client_id, name: r.name, redirect_uris: JSON.parse(r.redirect_uris) } : null;
  }

  private issue(clientId: string, user: string, scopes: Scope[]) {
    const access_token = `dsa_${randomBytes(32).toString('base64url')}`;
    const refresh_token = `dsr_${randomBytes(32).toString('base64url')}`;
    this.db.run(
      'INSERT INTO oauth_grants (client_id, user, scopes, access_hash, access_expires_at, refresh_hash, refresh_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      clientId, user, JSON.stringify(scopes), sha256(access_token), iso(ACCESS_TTL_S * 1000), sha256(refresh_token), iso(REFRESH_TTL_S * 1000),
    );
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token, scope: scopes.join(' ') };
  }

  /** The OAuth client behind an access token, for /mcp. */
  verify(token: string): Principal | null {
    const r = this.db.get<{ id: number; scopes: string; access_expires_at: string; revoked_at: string | null; name: string }>(
      'SELECT g.id, g.scopes, g.access_expires_at, g.revoked_at, c.name FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id WHERE g.access_hash = ?', sha256(token),
    );
    if (!r || r.revoked_at || r.access_expires_at < new Date().toISOString()) return null;
    this.db.run('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?', new Date().toISOString(), r.id);
    return { kind: 'oauth', name: r.name, scopes: new Set(JSON.parse(r.scopes)), local: false };
  }

  grants(): OAuthGrantInfo[] {
    return this.db.all<Record<string, unknown>>(
      `SELECT g.id, g.client_id, c.name AS client_name, g.user, g.scopes, g.created_at, g.last_used_at, g.refresh_expires_at, g.revoked_at
       FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id
       WHERE g.revoked_at IS NULL AND g.refresh_expires_at > ? ORDER BY g.id DESC`, new Date().toISOString(),
    ).map((r) => ({ ...(r as unknown as OAuthGrantInfo), scopes: JSON.parse(String(r.scopes)) }));
  }

  /** Revoke a grant and every grant of the same client and user (all its refreshed generations). */
  revokeGrant(id: number) {
    const g = this.db.get<{ client_id: string; user: string }>('SELECT client_id, user FROM oauth_grants WHERE id = ?', id);
    if (g) this.db.run('UPDATE oauth_grants SET revoked_at = ? WHERE client_id = ? AND user = ? AND revoked_at IS NULL', new Date().toISOString(), g.client_id, g.user);
  }

  routes(app: FastifyInstance) {
    const fail = (reply: FastifyReply, status: number, error: string, description: string) => reply.status(status).send({ error, error_description: description });

    app.get('/.well-known/oauth-authorization-server', async () => this.metadata());
    app.get('/.well-known/oauth-protected-resource', async () => this.resourceMetadata());
    app.get('/.well-known/oauth-protected-resource/mcp', async () => this.resourceMetadata());

    app.post('/register', async (req, reply) => {
      const b = z.object({ client_name: z.string().max(100).optional(), redirect_uris: z.array(z.string()).min(1).max(10) }).passthrough().safeParse(req.body);
      if (!b.success) return fail(reply, 400, 'invalid_client_metadata', 'client_name and redirect_uris are needed');
      const bad = b.data.redirect_uris.find((u) => !allowedRedirect(u));
      if (bad) return fail(reply, 400, 'invalid_redirect_uri', `Not allowed: ${bad} (https, or http on localhost)`);
      const count = Number(this.db.get<{ n: number }>('SELECT count(*) AS n FROM oauth_clients')!.n);
      if (count >= MAX_CLIENTS) return fail(reply, 429, 'too_many_clients', 'Client registration is full; revoke old clients in Settings');
      const client_id = `mcp_${randomBytes(16).toString('base64url')}`;
      const name = (b.data.client_name ?? 'MCP client').trim() || 'MCP client';
      this.db.run('INSERT INTO oauth_clients (client_id, name, redirect_uris) VALUES (?, ?, ?)', client_id, name, JSON.stringify(b.data.redirect_uris));
      return reply.status(201).send({ client_id, client_name: name, redirect_uris: b.data.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    });

    // Step 1: who is approving, and what. Shows a consent page; nothing is granted on GET.
    app.get('/authorize', async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const client = q.client_id ? this.client(q.client_id) : null;
      if (!client) return reply.status(400).type('text/html').send(page('Unknown app', '<p>This app is not registered with Dispatch. Add the connector again.</p>'));
      if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) return reply.status(400).type('text/html').send(page('Wrong return address', '<p>The app asked to return somewhere it did not register.</p>'));
      const back = (params: Record<string, string>) => {
        const u = new URL(q.redirect_uri!);
        for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
        if (q.state) u.searchParams.set('state', q.state);
        return reply.redirect(u.toString());
      };
      if (q.response_type !== 'code') return back({ error: 'unsupported_response_type' });
      if (!q.code_challenge || q.code_challenge_method !== 'S256') return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' });
      const user = this.access.browserUser(req);
      if (!user) {
        if (this.cfg.authMode === 'proxy') return reply.status(401).type('text/html').send(page('Not signed in', '<p>Open this through the sign-in proxy.</p>'));
        // the app's own login, then back here
        return reply.redirect(`/?next=${encodeURIComponent(req.url)}`);
      }
      const requested = (q.scope ?? '').split(/\s+/).filter((s): s is Scope => (OAUTH_SCOPES as string[]).includes(s));
      const scopes: Scope[] = requested.length ? [...new Set<Scope>(['read', ...requested])] : OAUTH_SCOPES;
      const id = randomBytes(18).toString('base64url');
      this.pending.set(id, { client, redirect_uri: q.redirect_uri, challenge: q.code_challenge, scopes, state: q.state ?? null, user, expires: Date.now() + CODE_TTL_MS });
      const host = new URL(q.redirect_uri).host;
      return reply.type('text/html').header('cache-control', 'no-store').send(page(`Allow ${client.name}?`, `
        <p><b>${esc(client.name)}</b> wants to ${scopes.includes('tracker') ? '<b>read and edit</b>' : '<b>read</b>'} your Dispatch tracker: projects, items, comments, sources and images.</p>
        <p>It cannot start agent sessions, merge, or change settings. You can revoke it any time in Settings → Connected apps.</p>
        <p class="muted">Signed in as ${esc(user)}. It returns to ${esc(host)}.</p>
        <form method="post" action="/authorize">
          <input type="hidden" name="request" value="${id}">
          <button name="decision" value="allow" class="primary">Allow</button>
          <button name="decision" value="deny">Deny</button>
        </form>`));
    });

    // Step 2: the decision, from the same person (re-checked: a POST alone proves nothing).
    app.post('/authorize', async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, string>;
      const p = this.pending.get(String(b.request ?? ''));
      this.pending.delete(String(b.request ?? ''));
      const user = this.access.browserUser(req);
      if (!p || p.expires < Date.now() || !user || user !== p.user) return reply.status(400).type('text/html').send(page('Expired', '<p>This approval expired. Start the connection again from the app.</p>'));
      const u = new URL(p.redirect_uri);
      if (p.state) u.searchParams.set('state', p.state);
      if (b.decision !== 'allow') {
        u.searchParams.set('error', 'access_denied');
        return reply.redirect(u.toString());
      }
      const code = randomBytes(32).toString('base64url');
      this.codes.set(code, { client_id: p.client.client_id, redirect_uri: p.redirect_uri, challenge: p.challenge, scopes: p.scopes, user: p.user, expires: Date.now() + CODE_TTL_MS });
      u.searchParams.set('code', code);
      return reply.redirect(u.toString());
    });

    app.post('/token', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const b = (req.body ?? {}) as Record<string, string>;
      if (b.grant_type === 'authorization_code') {
        const c = this.codes.get(String(b.code ?? ''));
        this.codes.delete(String(b.code ?? ''));
        if (!c || c.expires < Date.now()) return fail(reply, 400, 'invalid_grant', 'Unknown or expired code');
        if (c.client_id !== b.client_id || c.redirect_uri !== b.redirect_uri) return fail(reply, 400, 'invalid_grant', 'Code was issued to another client or return address');
        const verifier = String(b.code_verifier ?? '');
        if (createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return fail(reply, 400, 'invalid_grant', 'PKCE check failed');
        return this.issue(c.client_id, c.user, c.scopes);
      }
      if (b.grant_type === 'refresh_token') {
        const g = this.db.get<{ id: number; client_id: string; user: string; scopes: string; refresh_expires_at: string; revoked_at: string | null }>(
          'SELECT id, client_id, user, scopes, refresh_expires_at, revoked_at FROM oauth_grants WHERE refresh_hash = ?', sha256(String(b.refresh_token ?? '')),
        );
        if (!g || g.revoked_at || g.refresh_expires_at < new Date().toISOString() || (b.client_id && b.client_id !== g.client_id)) {
          return fail(reply, 400, 'invalid_grant', 'Unknown, used or expired refresh token');
        }
        // rotate: the old pair stops working
        this.db.run('UPDATE oauth_grants SET revoked_at = ? WHERE id = ?', new Date().toISOString(), g.id);
        return this.issue(g.client_id, g.user, JSON.parse(g.scopes));
      }
      return fail(reply, 400, 'unsupported_grant_type', 'authorization_code or refresh_token');
    });

    app.post('/revoke', async (req) => {
      const t = String(((req.body ?? {}) as Record<string, string>).token ?? '');
      this.db.run('UPDATE oauth_grants SET revoked_at = ? WHERE (access_hash = ? OR refresh_hash = ?) AND revoked_at IS NULL', new Date().toISOString(), sha256(t), sha256(t));
      return {}; // RFC 7009: always 200
    });

    // Settings → Connected apps
    app.get('/api/oauth/grants', async () => this.grants());
    app.delete('/api/oauth/grants/:id', async (req) => {
      this.revokeGrant(Number((req.params as { id: string }).id));
      return { ok: true };
    });
  }
}

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Dispatch</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:28rem;margin:12vh auto;padding:0 1.2rem;color:#1b1b1f;background:#f4f4f6}
h1{font-size:1.3rem}.muted{color:#6b6b73;font-size:.9rem}button{font:inherit;padding:.6rem 1.2rem;border-radius:.6rem;border:1px solid #dedee3;background:#fff;margin-right:.5rem}
.primary{background:#4f50e6;color:#fff;border-color:#4f50e6}@media(prefers-color-scheme:dark){body{background:#111113;color:#ededef}button{background:#222226;color:#ededef;border-color:#2c2c31}.primary{background:#6e6ff0;border-color:#6e6ff0}}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}
