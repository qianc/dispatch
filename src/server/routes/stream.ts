import type { FastifyInstance } from 'fastify';
import type { Ctx } from './ctx.ts';
import type { LiveEvent } from '../../shared/types.ts';

/** Server-sent events: every LiveEvent, to every signed-in tab; notices only to the tabs of the people they are for. */
export function streamRoutes(app: FastifyInstance, { bus }: Ctx) {
  app.get('/api/stream', (req, reply) => {
    const user = req.principal?.user ?? null;
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // the hello event lets the client tell a working stream from one a proxy is holding back
    reply.raw.write(`retry: 3000\n\ndata: ${JSON.stringify({ t: 'hello' })}\n\n`);
    const off = bus.on((e) => {
      const out = forUser(e, user);
      if (out) reply.raw.write(`data: ${JSON.stringify(out)}\n\n`);
    });
    // a real event, not an SSE comment: the client sees it and can tell a quiet stream from a dead one
    const ping = setInterval(() => reply.raw.write(`data: ${JSON.stringify({ t: 'hello' })}\n\n`), 25_000);
    req.raw.on('close', () => {
      off();
      clearInterval(ping);
    });
  });
}

/** The event as `user`'s tab gets it: a notice for other people is not sent, and who it is for stays on the server (DISP-65). */
export function forUser(e: LiveEvent, user: string | null): LiveEvent | null {
  if (e.t !== 'notice') return e;
  if (e.to && (!user || !e.to.includes(user))) return null;
  return { t: 'notice', notice: e.notice };
}
