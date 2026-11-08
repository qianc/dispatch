import Fastify, { type FastifyRequest } from 'fastify';
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
import { projectRules } from './projectRules.ts';
import { Attachments } from './attachments.ts';
import { imageRoutes } from './routes/images.ts';
import { Janitor } from './janitor.ts';
import { Access, ROUTE_ACCESS, type Principal } from './access.ts';
import { Devices } from './devices.ts';
import { OAuth } from './oauth.ts';
import { mcpRoutes } from './mcp.ts';
import { GitHub } from './github.ts';
import { Notifier } from './notify.ts';
import { SessionError, Sessions } from './sessions.ts';
import { Store } from './store.ts';
import { WorkerHub } from './workerHub.ts';
import { checkPlacements } from './repos.ts';
import { HttpError, type Ctx } from './routes/ctx.ts';
import { authRoutes } from './routes/auth.ts';
import { deviceRoutes } from './routes/devices.ts';
import { projectRoutes } from './routes/projects.ts';
import { itemRoutes } from './routes/items.ts';
import { sourceRoutes } from './routes/sources.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { prRoutes } from './routes/prs.ts';
import { pushRoutes } from './routes/push.ts';
import { streamRoutes } from './routes/stream.ts';
import { fileRoutes } from './routes/files.ts';
import { workerRoutes } from './routes/workers.ts';
import { releaseRoutes } from './routes/releases.ts';
import { Workers } from './workers.ts';
import { Users } from './users.ts';
import { Identities } from './identities.ts';
import { SecretBox, keyMatches, loadKey } from './secretBox.ts';
import { githubRoutes } from './routes/github.ts';
import { connectUrl, needsGithub, resolveGithubIdentity, safePath, type IdentityDeps } from './identity.ts';
import type { Session } from '../shared/types.ts';
import { HostedGit } from './hosted.ts';
import { gitRoutes } from './routes/git.ts';
import { scheduleRoutes } from './routes/schedules.ts';
import { Scheduler } from './scheduler.ts';
import { disabledMessage, refusedWrite } from './projectLock.ts';
import { readOnlyMessage, refusedSession } from './sessionGuard.ts';


declare module 'fastify' {
  interface FastifyRequest {
    /** who made this /api request (set by the access hook) */
    principal?: Principal;
  }
}

export async function buildApp(cfg: Config, opts: { dbFile?: string; logger?: boolean } = {}) {
  const dbFile = opts.dbFile ?? resolve(cfg.dataDir, 'dispatch.db');
  const db = new Db(dbFile);
  // after the database: it made the data folder the key file goes into
  const secretKey = loadKey(cfg, dbFile);
  const users = new Users(db, cfg);
  users.claim();
  // people's own GitHub tokens, sealed with the secret key (DISP-63)
  const box = new SecretBox(secretKey.key);
  const identities = new Identities(db, box, cfg);
  if (!keyMatches(db, box)) {
    console.warn('The secret key changed: GitHub tokens stored with the old key cannot be read (Settings → Your GitHub says "connect again"). Start with the old key to read them again.');
  }
  const store = new Store(db);
  const workers = new Workers(db);
  const hosted = new HostedGit(cfg.dataDir);
  const bus = new Bus();
  const hub = new WorkerHub();
  // a local repo goes to each worker with that worker's own path for it (DISP-45)
  hub.localize = (workerId, repo) => {
    const p = (repo.placements ?? store.repo(repo.id)?.placements)?.find((x) => x.worker_id === workerId);
    return p ? { ...repo, local_path: p.local_path, worker_id: workerId } : repo;
  };
  const auth = new Auth(cfg, db);
  const notifier = new Notifier(cfg, db, store, bus);
  const sessions = new Sessions(store, bus, hub, notifier, workers, users);
  // as whom each session acts on GitHub (DISP-63): its starter, the owner's env accounts, or the shared one
  const identityDeps: IdentityDeps = {
    identities,
    get installOwner() {
      return users.installOwner;
    },
    envAccounts: cfg.githubAccounts, oauth: !!cfg.githubOAuth,
    workerAccounts: (id) => (hub.facts(id) ?? workers.get(id)?.facts)?.github_accounts ?? [],
  };
  sessions.identity = (startedBy, project, workerId) => resolveGithubIdentity(identityDeps, { started_by: startedBy }, project, workerId);
  // never kept from a worker's messages: the starter's own token and the server's env accounts' (DISP-63)
  sessions.secretsOf = (s) => {
    const cred = s.started_by ? identities.get(s.started_by) : null;
    return [...cfg.githubAccounts.map((a) => a.token), ...(cred && 'token' in cred ? [cred.token] : [])];
  };
  // as Sessions.identityFor: a session with no user may use its worker's own env account
  const sessionIdentity = (s: Session) => {
    const project = s.project_id ? store.project(s.project_id) : undefined;
    return project && needsGithub(store, project) ? resolveGithubIdentity(identityDeps, s, project, s.worker_id ?? undefined) : null;
  };
  const github = new GitHub(cfg.githubAccounts, store, bus, notifier, hub, identities, sessionIdentity, cfg.githubApiUrl);
  github.gitBase = cfg.githubGitBase;
  github.hosted = hosted;
  const assistant = new AssistantTools(store, bus, github, sessions, hub, users);
  assistant.rules = (p) => projectRules({ store, hub, hosted }, p);
  const attachments = new Attachments(cfg.dataDir);
  sessions.attachments = attachments;
  sessions.assistantRpc = (s, method, params) => assistant.call(s, method, params);
  github.onBehind = (s, repo, behind) => {
    const text = `(From Dispatch, not the owner:) before auto-merge, your branch in ${repo.github_name} must include the latest ${repo.default_branch}: it is ${behind} commit${behind === 1 ? '' : 's'} behind. Merge ${repo.default_branch} into your branch${repo.kind === 'hosted' ? ` (merge origin/${repo.default_branch}: Dispatch fetched it; do not fetch or push)` : repo.local_path ? '' : ` (git fetch origin, then merge origin/${repo.default_branch})`}, resolve any conflicts, re-run the tests the change touches${repo.local_path || repo.kind === 'hosted' ? '' : ', and push'}. Dispatch merges once the branch is up to date and checks pass.`;
    try {
      sessions.send(s.id, text);
    } catch (e) {
      console.warn(`could not ask session ${s.id} to update its branch:`, (e as Error).message);
    }
  };
  // a finished turn often means a PR was just opened: link it (and auto-merge) without waiting for the poll
  const janitor = new Janitor(store, hub, github, bus);
  github.onPrChange = () => sessions.dispatch();
  sessions.onFinished = (s, status, removeAll) => janitor.onFinished(s, status, removeAll);
  sessions.onTurnCheck = (s, repo, msg) => github.checks.turn(s.id, repo, msg);
  sessions.onWorkIdle = async (s) => {
    const before = github.toldCount(s.id);
    await github.syncSession(s).catch((e) => console.warn('PR sync failed:', (e as Error).message));
    return github.toldCount(s.id) > before;
  };
  let closing = false;
  hub.handlers = {
    onHello: (workerId, live, facts) => {
      workers.seen(workerId, facts);
      sessions.onWorkerHello(workerId, live);
      // are its local repo copies still there? (sessions only go to workers whose copies are ok)
      void checkPlacements(store, hub, workerId)
        .then(() => !closing && store.placementsOn(workerId).forEach(({ repo }) => bus.emit({ t: 'project', key: store.project(repo.project_id)!.key })))
        .catch((e) => console.warn('checking local repo copies failed:', (e as Error).message));
      // look for leftovers soon after the worker is (back) online
      setTimeout(() => void janitor.check().catch((e) => console.warn('cleanup check failed:', (e as Error).message)), 30_000).unref();
    },
    onMessage: (workerId, m) => sessions.onWorkerMessage(workerId, m),
    onRpc: (workerId, id, method, params) => sessions.rpc(id, method, params, workerId),
    onRefused: (workerId, id, reason) => sessions.onRefused(workerId, id, reason),
    onSlots: () => sessions.dispatch(),
    // after app.close() the database is gone: links closing then have nothing to update
    onDisconnect: (workerId) => !closing && sessions.onWorkerDisconnect(workerId),
  };
  const devices = new Devices(db);
  const access = new Access(cfg, db, auth, devices, users);
  const scheduler = new Scheduler(store, sessions, bus);
  const ctx: Ctx = { cfg, store, auth, access, devices, users, identities, secretKeyFile: secretKey.generatedFile, bus, hub, workers, hosted, sessions, github, notifier, attachments, janitor, scheduler };
  if (!opts.dbFile || opts.dbFile !== ':memory:') {
    janitor.start();
    scheduler.start();
  }

  // forceCloseConnections: live streams (/api/stream) never end on their own, so close() would wait
  // for them forever; a deploy then SIGKILLs the server with the database still open
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024, forceCloseConnections: true });
  /** every route, as "METHOD /path" (a test checks each /api one has an access rule) */
  const routes: string[] = [];
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) routes.push(`${m} ${r.url}`);
  });
  await app.register(cookie);
  await app.register(websocket);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err instanceof SessionError) return reply.status(err.status).send({ error: err.message, ...err.extra, ...connectBack(req, err.extra) });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number; status?: number }).statusCode ?? (err as { status?: number }).status ?? 500;
    if (status >= 500) console.error(err);
    return reply.status(status).send({ error: (err as Error).message });
  });

  /**
   * A person's missing GitHub connection: connecting brings them back to the page they are on (the
   * web app sends it as x-dispatch-path), when that is a path in Dispatch.
   */
  const connectBack = (req: FastifyRequest, extra: Record<string, unknown>) => {
    if (extra.code !== 'github_not_connected' && extra.code !== 'github_token_unreadable') return {};
    const from = safePath(String(req.headers['x-dispatch-path'] ?? ''));
    return from ? { connect_url: connectUrl(!!cfg.githubOAuth, from) } : {};
  };

  // Proxy mode: the port is no way around the proxy's sign-in. Only this machine and the proxy get in.
  app.addHook('onRequest', async (req, reply) => {
    if (access.refused(req)) return reply.status(403).send({ error: 'Use the proxy address to reach Dispatch.' });
  });

  // Every /api route needs its scope (ROUTE_ACCESS). Check the matched route pattern, not req.url:
  // the router decodes %-escapes (/%61pi/… matches /api/…).
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions.url;
    if (!route || !route.startsWith('/api/')) return;
    const need = ROUTE_ACCESS[`${req.method} ${route}`] ?? (req.method === 'HEAD' ? ROUTE_ACCESS[`GET ${route}`] : undefined) ?? 'admin';
    if (need === 'public') return;
    const who = access.principal(req);
    if (!who) return reply.status(401).send({ error: 'Not signed in' });
    if (who.kind === 'token') console.log(`token "${who.name}"${who.local ? '' : ' (remote)'}: ${req.method} ${req.url.split('?')[0]}`);
    if (need === 'user' ? who.kind !== 'user' : !who.scopes.has(need)) {
      return reply.status(403).send({ error: need === 'user' ? 'Only a signed-in person can do this, not a token.' : `This needs the "${need}" scope${who.kind === 'token' && !who.local ? ' (tokens used from another machine are limited to read and tracker)' : ''}.` });
    }
    // projects and install settings: the install owner only (or the legacy token, which acts for the install)
    if (need === 'admin' && !who.legacy && !users.isOwner(who.user)) {
      return reply.status(403).send({ error: `Only the install owner (${users.installOwner}) can change this.` });
    }
    if (who.kind === 'user') users.touch(who.name);
    req.principal = who;
  });

  // A disabled project is read-only (DISP-59): its write routes are refused, whoever asks.
  app.addHook('preHandler', async (req, reply) => {
    const route = req.routeOptions.url;
    if (!route || !route.startsWith('/api/')) return;
    const p = refusedWrite(store, req.method, route, req.params as Record<string, string>);
    if (p) return reply.status(423).send({ error: disabledMessage(p) });
  });

  // Other people's sessions are read-only (DISP-63): only the starter drives one; the install owner may also stop it.
  app.addHook('preHandler', async (req, reply) => {
    const route = req.routeOptions.url;
    if (!route || !route.startsWith('/api/') || !req.principal) return;
    const s = refusedSession(store, req.principal, req.method, route, req.params as Record<string, string>, req.body, users.installOwner);
    if (s) return reply.status(403).send({ error: readOnlyMessage(s) });
  });

  // "Sign in again": behind a sign-in proxy this path goes through its login, then back into the app
  app.get('/signin', async (req, reply) => {
    return reply.redirect(safePath((req.query as { to?: string }).to) ?? '/');
  });

  // OAuth clients send forms (application/x-www-form-urlencoded)
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });
  // MCP for Claude on other machines: OAuth (/authorize, /token, …) and the tracker tools at /mcp
  const oauth = new OAuth(cfg, db, access);
  oauth.routes(app);
  mcpRoutes(app, { store, bus, attachments, oauth, publicUrl: cfg.publicUrl, rules: assistant.rules });

  app.get('/worker', { websocket: true }, (socket, req) => {
    // a worker's own token (dsw_…), or the server's WORKER_TOKEN for the legacy worker
    const token = String(req.headers['x-worker-token'] ?? '');
    const legacy = !!cfg.workerToken && token.length === cfg.workerToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(cfg.workerToken));
    const worker = legacy ? workers.legacy() : workers.verify(token);
    if (!worker) return socket.close(4001, 'bad worker token');
    hub.attach(socket, worker);
  });

  authRoutes(app, ctx);
  deviceRoutes(app, ctx);
  projectRoutes(app, ctx);
  itemRoutes(app, ctx);
  sourceRoutes(app, ctx);
  sessionRoutes(app, ctx);
  prRoutes(app, ctx);
  pushRoutes(app, ctx);
  streamRoutes(app, ctx);
  fileRoutes(app, ctx);
  workerRoutes(app, ctx);
  releaseRoutes(app, ctx);
  gitRoutes(app, ctx);
  imageRoutes(app, ctx);
  scheduleRoutes(app, ctx);
  githubRoutes(app, ctx);
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
    closing = true;
    janitor.stop();
    scheduler.stop();
    github.stop();
    ctx.sessions.stop();
    db.raw.close();
  });

  return { app, ctx, routes };
}
