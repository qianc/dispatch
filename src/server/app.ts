import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import { Auth } from './auth.ts';
import { Bus } from './bus.ts';
import type { Config } from './config.ts';
import { Db } from './db.ts';
import { AssistantTools } from './assistant.ts';
import { Attachments } from './attachments.ts';
import { imageRoutes } from './routes/images.ts';
import { GitHub } from './github.ts';
import { Notifier } from './notify.ts';
import { SessionError, Sessions } from './sessions.ts';
import { Store } from './store.ts';
import { WorkerHub } from './workerHub.ts';
import { HttpError, type Ctx } from './routes/ctx.ts';
import { authRoutes } from './routes/auth.ts';
import { projectRoutes } from './routes/projects.ts';
import { itemRoutes } from './routes/items.ts';
import { sourceRoutes } from './routes/sources.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { prRoutes } from './routes/prs.ts';
import { pushRoutes } from './routes/push.ts';
import { streamRoutes } from './routes/stream.ts';
import { fileRoutes } from './routes/files.ts';

const PUBLIC_API = new Set(['/api/login', '/api/me']);

export async function buildApp(cfg: Config, opts: { dbFile?: string; logger?: boolean } = {}) {
  const db = new Db(opts.dbFile ?? resolve(cfg.dataDir, 'dispatch.db'));
  const store = new Store(db);
  const bus = new Bus();
  const hub = new WorkerHub();
  const auth = new Auth(cfg, db);
  const notifier = new Notifier(cfg, db, store);
  const sessions = new Sessions(store, bus, hub, notifier, cfg.maxConcurrent);
  const github = new GitHub(cfg.githubAccounts, store, bus, notifier, hub);
  const assistant = new AssistantTools(store, bus, github, sessions, hub);
  const attachments = new Attachments(cfg.dataDir);
  sessions.attachments = attachments;
  sessions.assistantRpc = (s, method, params) => assistant.call(s, method, params);
  github.onBehind = (s, repo, behind) => {
    const text = `(From Dispatch, not the owner:) before auto-merge, your branch must include the latest ${repo.default_branch}: it is ${behind} commit${behind === 1 ? '' : 's'} behind. Merge ${repo.default_branch} into your branch${repo.local_path ? '' : ` (git fetch origin, then merge origin/${repo.default_branch})`}, resolve any conflicts, re-run the tests the change touches${repo.local_path ? '' : ', and push'}. Dispatch merges once the branch is up to date and checks pass.`;
    try {
      sessions.send(s.id, text);
    } catch (e) {
      console.warn(`could not ask session ${s.id} to update its branch:`, (e as Error).message);
    }
  };
  // a finished turn often means a PR was just opened: link it (and auto-merge) without waiting for the poll
  sessions.onWorkIdle = (s) => {
    github.syncSession(s).catch((e) => console.warn('PR sync failed:', (e as Error).message));
  };
  hub.handlers = {
    onHello: (live) => sessions.onWorkerHello(live),
    onMessage: (m) => sessions.onWorkerMessage(m),
    onRpc: (id, method, params) => sessions.rpc(id, method, params),
    onDisconnect: () => sessions.onWorkerDisconnect(),
  };
  const ctx: Ctx = { cfg, store, auth, bus, hub, sessions, github, notifier, attachments };

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(websocket);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err instanceof HttpError || err instanceof SessionError) return reply.status(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number; status?: number }).statusCode ?? (err as { status?: number }).status ?? 500;
    if (status >= 500) console.error(err);
    return reply.status(status).send({ error: (err as Error).message });
  });

  // Check the matched route pattern, not req.url: the router decodes %-escapes (/%61pi/… matches /api/…).
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions.url;
    if (!route || !route.startsWith('/api/') || PUBLIC_API.has(route)) return;
    if (!auth.isAuthed(req)) return reply.status(401).send({ error: 'Not signed in' });
  });

  app.get('/worker', { websocket: true }, (socket, req) => {
    const token = String(req.headers['x-worker-token'] ?? '');
    const ok = token.length === cfg.workerToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(cfg.workerToken));
    if (!ok) return socket.close(4001, 'bad worker token');
    hub.attach(socket);
  });

  authRoutes(app, ctx);
  projectRoutes(app, ctx);
  itemRoutes(app, ctx);
  sourceRoutes(app, ctx);
  sessionRoutes(app, ctx);
  prRoutes(app, ctx);
  pushRoutes(app, ctx);
  streamRoutes(app, ctx);
  fileRoutes(app, ctx);
  imageRoutes(app, ctx);
  app.get('/api/sessions/:id/attachments/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const file = await attachments.read(Number(id), name);
    if (!file) return reply.status(404).send({ error: 'Not found' });
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    return reply.type(file.type).send(file.data);
  });

  const webRoot = resolve(cfg.webDist);
  if (existsSync(webRoot)) {
    // wildcard: files are looked up per request, so a new build is served without a restart
    await app.register(fastifyStatic, { root: webRoot, wildcard: true });
    app.setNotFoundHandler((req, reply) => {
      // a missing file (e.g. an old build's script) must 404; answering with index.html would
      // hand the browser HTML as JavaScript and leave a blank app
      const path = req.url.split('?')[0];
      if (path.startsWith('/api/') || path.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(path)) {
        return reply.status(404).send({ error: 'Not found' });
      }
      reply.header('cache-control', 'no-cache');
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => {
    github.stop();
    db.raw.close();
  });

  return { app, ctx };
}
