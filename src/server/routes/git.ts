// Git over HTTP for hosted repos: workers clone, fetch and push at /git/r<id>.git with their worker
// token (Authorization: Bearer …). git http-backend does the protocol; this only lets the right
// requests through and streams them.
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from './ctx.ts';

/** The smart-HTTP endpoints git uses; nothing else in the repo folder is served. */
const ENDPOINTS = new Set(['info/refs', 'git-upload-pack', 'git-receive-pack']);
const BODY_TYPES = ['application/x-git-upload-pack-request', 'application/x-git-receive-pack-request'];

export function gitRoutes(app: FastifyInstance, { cfg, store, workers, hosted }: Ctx) {
  // keep the request body as a stream: packs can be large
  app.addContentTypeParser(BODY_TYPES, (_req, payload, done) => done(null, payload));

  /** The worker this request comes from, or null. Personal tokens and browser sessions do not count. */
  const workerOf = (req: FastifyRequest) => {
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) return null;
    if (cfg.workerToken && token.length === cfg.workerToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(cfg.workerToken))) return workers.legacy();
    return workers.verify(token);
  };

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const { repo: name, '*': rest } = req.params as { repo: string; '*': string };
    const id = /^r(\d+)\.git$/.exec(name)?.[1];
    if (!id || !ENDPOINTS.has(rest)) return reply.status(404).send({ error: 'Not found' });
    const worker = workerOf(req);
    if (!worker) return reply.status(401).header('www-authenticate', 'Bearer realm="dispatch git"').send({ error: 'A worker token is needed' });
    const repo = store.repo(Number(id));
    if (!repo || repo.kind !== 'hosted' || !hosted.exists(repo)) return reply.status(404).send({ error: 'Not found' });

    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    const cgi = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: hosted.root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: `/${name}/${rest}`,
        REQUEST_METHOD: req.method,
        QUERY_STRING: query,
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: `worker:${worker.name}`,
        REMOTE_ADDR: req.ip,
        ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {}),
        ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
      },
    });
    const body = req.body as NodeJS.ReadableStream | undefined;
    if (body && typeof (body as { pipe?: unknown }).pipe === 'function') body.pipe(cgi.stdin);
    else cgi.stdin.end();

    reply.hijack();
    const res = reply.raw;
    let head = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n') >= 0 ? head.indexOf('\r\n\r\n') : head.indexOf('\n\n');
      if (end < 0) return;
      const sep = head[end] === 0x0d ? 4 : 2;
      let status = 200;
      for (const line of head.subarray(0, end).toString('latin1').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const key = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]) || 200;
        else res.setHeader(key, value);
      }
      res.writeHead(status);
      headersDone = true;
      const restBytes = head.subarray(end + sep);
      if (restBytes.length) res.write(restBytes);
    });
    let errText = '';
    cgi.stderr.on('data', (d) => (errText += d));
    cgi.on('close', (code) => {
      if (!headersDone) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`git failed${code ? ` (${code})` : ''}`);
        if (errText) console.warn('git http-backend:', errText.trim().slice(0, 500));
        return;
      }
      res.end();
    });
    req.raw.on('aborted', () => cgi.kill());
  };

  app.route({ method: ['GET', 'POST'], url: '/git/:repo/*', handler });
}
