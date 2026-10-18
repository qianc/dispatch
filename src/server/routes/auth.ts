import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COOKIE } from '../auth.ts';
import { SCOPES, isLoopback } from '../access.ts';
import { HttpError, type Ctx } from './ctx.ts';

export function authRoutes(app: FastifyInstance, { auth, access, cfg, notifier, hub, github, store }: Ctx) {
  const db = store.db;
  const passwordSet = !!(cfg.appPassword || cfg.appPasswordHash);
  /** Where the password login may be used: anywhere in password mode; only from this machine behind a proxy. */
  const passwordHere = (req: { socket: { remoteAddress?: string } }) => passwordSet && (cfg.authMode === 'password' || isLoopback(req.socket.remoteAddress));

  app.post('/api/login', async (req, reply) => {
    if (!passwordHere(req)) throw new HttpError(403, 'Sign in through the proxy.');
    const { password } = z.object({ password: z.string() }).parse(req.body);
    if (!auth.checkPassword(password)) {
      await new Promise((r) => setTimeout(r, 500));
      throw new HttpError(401, 'Wrong password');
    }
    auth.issueCookie(reply);
    return { ok: true };
  });
  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/me', async (req) => {
    const user = access.browserUser(req);
    return {
      authed: !!user,
      user,
      auth_mode: cfg.authMode,
      auth_disabled: cfg.authMode === 'off',
      /** the password form makes sense here (else: sign in through the proxy) */
      password_login: passwordHere(req),
      vapid_public_key: notifier.publicKey,
    };
  });
  app.get('/api/settings', async () => ({ github: cfg.githubAccounts.length > 0, legacy_token: access.hasLegacyToken(), auth_mode: cfg.authMode }));

  // ---------- named personal tokens (a signed-in person only, never a token) ----------
  app.get('/api/tokens', async () => access.tokens());
  app.post('/api/tokens', async (req) => {
    const b = z.object({
      name: z.string().trim().min(1).max(60),
      scopes: z.array(z.enum(SCOPES)).min(1).default(['tracker']),
      expires_days: z.number().int().min(1).max(3650).nullable().default(null),
    }).parse(req.body);
    const scopes = [...new Set(b.scopes.includes('tracker') ? [...b.scopes, 'read' as const] : b.scopes)];
    const expires = b.expires_days ? new Date(Date.now() + b.expires_days * 86_400_000).toISOString() : null;
    return access.createToken(b.name, scopes, expires);
  });
  app.delete('/api/tokens/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    if (id === 'legacy') access.retireLegacyToken();
    else access.revokeToken(Number(id));
    return { ok: true };
  });

  /** Accounts by name and status only: credentials stay in the server's and worker's env. */
  app.get('/api/accounts', async () => ({
    claude: hub.claudeAccounts(),
    github: await github.accountsInfo(),
    assistant_claude_account: db.setting('assistant_claude_account') ?? null,
  }));

  app.patch('/api/settings', async (req) => {
    const { assistant_claude_account } = z.object({ assistant_claude_account: z.string().nullable() }).parse(req.body);
    const known = hub.claudeAccounts().map((a) => a.name);
    if (assistant_claude_account && known.length && !known.includes(assistant_claude_account)) throw new HttpError(400, `Unknown Claude account "${assistant_claude_account}"`);
    if (assistant_claude_account) db.setSetting('assistant_claude_account', assistant_claude_account);
    else db.run("DELETE FROM settings WHERE key = 'assistant_claude_account'");
    return { assistant_claude_account };
  });
}
