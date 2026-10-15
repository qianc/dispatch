import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COOKIE } from '../auth.ts';
import { HttpError, type Ctx } from './ctx.ts';

export function authRoutes(app: FastifyInstance, { auth, cfg, notifier, hub, github, store }: Ctx) {
  const db = store.db;
  app.post('/api/login', async (req, reply) => {
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
  app.get('/api/me', async (req) => ({
    authed: auth.isAuthed(req),
    auth_disabled: cfg.disableAuth,
    vapid_public_key: notifier.publicKey,
  }));
  app.get('/api/settings', async () => ({ api_token: auth.apiToken, github: cfg.githubAccounts.length > 0 }));

  /** Accounts by name and status only: credentials stay in the server's and worker's env. */
  app.get('/api/accounts', async () => ({
    claude: hub.claudeAccounts,
    github: await github.accountsInfo(),
    assistant_claude_account: db.setting('assistant_claude_account') ?? null,
  }));

  app.patch('/api/settings', async (req) => {
    const { assistant_claude_account } = z.object({ assistant_claude_account: z.string().nullable() }).parse(req.body);
    const known = hub.claudeAccounts.map((a) => a.name);
    if (assistant_claude_account && known.length && !known.includes(assistant_claude_account)) throw new HttpError(400, `Unknown Claude account "${assistant_claude_account}"`);
    if (assistant_claude_account) db.setSetting('assistant_claude_account', assistant_claude_account);
    else db.run("DELETE FROM settings WHERE key = 'assistant_claude_account'");
    return { assistant_claude_account };
  });
}
