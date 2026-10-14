import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COOKIE } from '../auth.ts';
import { HttpError, type Ctx } from './ctx.ts';

export function authRoutes(app: FastifyInstance, { auth, cfg, notifier }: Ctx) {
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
  app.get('/api/settings', async () => ({ api_token: auth.apiToken, github: !!cfg.githubToken }));
}
