import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { COOKIE } from '../auth.ts';
import { DEVICE_COOKIE } from '../devices.ts';
import { SCOPES, isLoopback } from '../access.ts';
import { HttpError, type Ctx } from './ctx.ts';

export function authRoutes(app: FastifyInstance, { auth, access, cfg, notifier, hub, github, store, devices, users }: Ctx) {
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
  app.post('/api/logout', async (req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    // signing out on a paired device ends that device's session
    const device = access.device(req);
    if (device) devices.revoke(device.id);
    if (req.cookies[DEVICE_COOKIE]) reply.clearCookie(DEVICE_COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/me', async (req, reply) => {
    const user = access.browserUser(req);
    // a revoked or expired device cookie: clear it, so the app offers pairing again
    if (req.cookies[DEVICE_COOKIE] && !access.device(req)) reply.clearCookie(DEVICE_COOKIE, { path: '/' });
    return {
      authed: !!user,
      user,
      is_owner: users.isOwner(user),
      install_owner: user ? cfg.installOwner : null,
      auth_mode: cfg.authMode,
      auth_disabled: cfg.authMode === 'off',
      /** the password form makes sense here (else: sign in through the proxy) */
      password_login: passwordHere(req),
      vapid_public_key: notifier.publicKey,
    };
  });
  app.get('/api/settings', async () => ({ github: cfg.githubAccounts.length > 0, legacy_token: access.hasLegacyToken(), auth_mode: cfg.authMode }));

  // ---------- named personal tokens (a signed-in person only, never a token) ----------
  // each person manages their own; the install owner sees and revokes all
  const mine = (req: FastifyRequest) => users.manages(req.principal!.user);
  app.get('/api/tokens', async (req) => access.tokens(mine(req)));
  app.post('/api/tokens', async (req) => {
    const user = req.principal!.user!;
    const b = z.object({
      name: z.string().trim().min(1).max(60),
      scopes: z.array(z.enum(SCOPES)).min(1).default(['tracker']),
      expires_days: z.number().int().min(1).max(3650).nullable().default(null),
    }).parse(req.body);
    if (b.scopes.includes('admin') && !users.isOwner(user)) throw new HttpError(400, `Only the install owner (${cfg.installOwner}) can make a token with the admin scope.`);
    const scopes = [...new Set(b.scopes.includes('tracker') ? [...b.scopes, 'read' as const] : b.scopes)];
    const expires = b.expires_days ? new Date(Date.now() + b.expires_days * 86_400_000).toISOString() : null;
    return access.createToken(b.name, scopes, expires, user);
  });
  app.delete('/api/tokens/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const user = mine(req);
    if (id === 'legacy') {
      if (user !== undefined) throw new HttpError(403, `Only the install owner (${cfg.installOwner}) can retire the legacy token.`);
      access.retireLegacyToken();
    } else {
      if (!access.tokens(user).some((t) => t.id === Number(id))) throw new HttpError(404, 'Token not found');
      access.revokeToken(Number(id));
    }
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
