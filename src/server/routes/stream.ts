import type { FastifyInstance } from 'fastify';
import type { Ctx } from './ctx.ts';

/** Server-sent events: every LiveEvent, to every signed-in tab. */
export function streamRoutes(app: FastifyInstance, { bus }: Ctx) {
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // the hello event lets the client tell a working stream from one a proxy is holding back
    reply.raw.write(`retry: 3000\n\ndata: ${JSON.stringify({ t: 'hello' })}\n\n`);
    const off = bus.on((e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`));
    // a real event, not an SSE comment: the client sees it and can tell a quiet stream from a dead one
    const ping = setInterval(() => reply.raw.write(`data: ${JSON.stringify({ t: 'hello' })}\n\n`), 25_000);
    req.raw.on('close', () => {
      off();
      clearInterval(ping);
    });
  });
}
