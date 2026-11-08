import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEVICE_COOKIE, DEVICE_DAYS, deviceName } from '../devices.ts';
import { HttpError, type Ctx } from './ctx.ts';

/** Pairing a phone's home-screen app (see devices.ts). */
export function deviceRoutes(app: FastifyInstance, { access, cfg, devices, users }: Ctx) {
  const mine = (req: FastifyRequest) => users.manages(req.principal!.user);

  // the phone, not signed in: start a pairing and show its code
  app.post('/api/devices/pair', async (req) => {
    if (access.device(req)) return { authed: true };
    return devices.start(deviceName(req.headers['user-agent']));
  });

  // the phone polls; once approved it gets its cookie, once
  app.get('/api/devices/pair/:pairId', async (req, reply) => {
    const r = devices.collect((req.params as { pairId: string }).pairId);
    if (r.status !== 'approved') return r;
    reply.setCookie(DEVICE_COOKIE, r.secret, {
      path: '/', httpOnly: true, sameSite: 'lax', maxAge: DEVICE_DAYS * 86_400,
      secure: cfg.publicUrl.startsWith('https://'),
    });
    return { status: 'approved' };
  });

  // a person signed in through the proxy (or the password) approves the code shown on the phone
  app.post('/api/devices/approve', async (req) => {
    const user = access.browserUser(req, { devices: false });
    if (!user) throw new HttpError(403, 'Approve from a signed-in browser, not from a paired device.');
    const { code } = z.object({ code: z.string().trim().min(4).max(20) }).parse(req.body);
    const device = devices.approve(code, user);
    if (!device) throw new HttpError(404, 'No pairing with that code. Codes last 10 minutes: start again on the phone.');
    return device;
  });

  app.get('/api/devices', async (req) => devices.list(mine(req)));
  app.delete('/api/devices/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const user = mine(req);
    const owner = devices.userOf(id);
    if (owner === undefined || (user !== undefined && owner !== user)) throw new HttpError(404, 'Device not found');
    devices.revoke(id);
    return { ok: true };
  });
}
