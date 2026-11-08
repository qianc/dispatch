// "Your GitHub" (DISP-63): each signed-in person connects their own GitHub account, with the
// GitHub OAuth App or a pasted token. Tokens never come back out of these routes.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GithubAccessChecker } from '../githubAccess.ts';
import { HttpError, notFound, type Ctx } from './ctx.ts';

export const STATE_COOKIE = 'dsp_gh_state';
const STATE_MS = 10 * 60_000;
const SCOPES = 'repo read:user user:email';

/** Only a path in Dispatch (not "//host" or "/\host", which browsers read as another site). */
const safePath = (to: string | undefined) => (to && to.startsWith('/') && !to.startsWith('//') && !to.startsWith('/\\') ? to : '/settings');

/** `to` with `?github=connected`, before any #fragment. */
function withConnected(to: string) {
  const [path, hash] = to.split(/#(.*)/s, 2);
  return `${path}${path.includes('?') ? '&' : '?'}github=connected${hash !== undefined ? `#${hash}` : ''}`;
}

export function githubRoutes(app: FastifyInstance, { cfg, identities, users, github, sessions, store }: Ctx) {
  /** OAuth sign-ins under way: state → who started it and where to go back */
  const states = new Map<string, { user: string; to: string; exp: number }>();
  const userOf = (req: FastifyRequest) => req.principal!.user!;
  /** a new connection may let sessions that wait for one go on */
  const connected = () => sessions.dispatch();

  const view = async (user: string) => {
    const info = identities.info(user);
    const owner = users.isOwner(user);
    return {
      connected: !!info,
      login: info?.login ?? null,
      git_name: info?.git_name ?? null,
      git_email: info?.git_email ?? null,
      kind: info?.kind ?? null,
      verified_at: info?.verified_at ?? null,
      last_error: info?.last_error ?? null,
      oauth_available: !!cfg.githubOAuth,
      /** the install owner's actions use the env accounts while not connected */
      uses_env_when_unconnected: owner,
      env_accounts: owner ? (await github.accountsInfo()).map((a) => ({ name: a.name, login: a.login })) : [],
    };
  };

  app.get('/api/me/github', async (req) => view(userOf(req)));
  app.put('/api/me/github', async (req) => {
    const { token } = z.object({ token: z.string().trim().min(1).max(500) }).parse(req.body);
    const user = userOf(req);
    await identities.connect(user, token, 'pat');
    connected();
    return view(user);
  });
  app.delete('/api/me/github', async (req) => {
    const user = userOf(req);
    await identities.disconnect(user);
    return view(user);
  });

  // who can act on GitHub in a project, and can the caller; ?verify=1 asks GitHub each account's permission
  const access = new GithubAccessChecker({
    store, github, identities, installOwner: cfg.installOwner,
    identity: (user, project) => sessions.identity!(user, project),
  });
  app.get('/api/projects/:key/github-access', async (req) => {
    const project = store.projectByKey((req.params as { key: string }).key);
    if (!project) throw notFound('Project');
    const verify = ['1', 'true'].includes(String((req.query as { verify?: string }).verify ?? ''));
    return access.view(project, req.principal!.user, verify);
  });

  app.get('/api/github/oauth/start', async (req, reply) => {
    const oauth = cfg.githubOAuth;
    if (!oauth) throw new HttpError(404, 'GitHub sign-in is not set up (GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET).');
    const t = Date.now();
    for (const [k, v] of states) if (v.exp < t) states.delete(k);
    const state = randomBytes(24).toString('base64url');
    states.set(state, { user: userOf(req), to: safePath((req.query as { to?: string }).to), exp: t + STATE_MS });
    reply.setCookie(STATE_COOKIE, state, {
      path: '/api/github/oauth', httpOnly: true, sameSite: 'lax', maxAge: STATE_MS / 1000,
      secure: cfg.publicUrl.startsWith('https://'),
    });
    const q = new URLSearchParams({
      client_id: oauth.clientId,
      redirect_uri: `${cfg.publicUrl.replace(/\/$/, '')}/api/github/oauth/callback`,
      scope: SCOPES,
      state,
    });
    return reply.redirect(`${identities.webBase}/login/oauth/authorize?${q}`);
  });

  app.get('/api/github/oauth/callback', async (req, reply: FastifyReply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    const fail = (msg: string) => reply.redirect(`/settings?github_error=${encodeURIComponent(msg)}#your-github`);
    const st = q.state ? states.get(q.state) : undefined;
    if (q.state) states.delete(q.state);
    reply.clearCookie(STATE_COOKIE, { path: '/api/github/oauth' });
    if (!st || st.exp < Date.now()) return fail('This GitHub sign-in expired. Try again.');
    if (req.cookies[STATE_COOKIE] !== q.state || userOf(req) !== st.user) return fail('This GitHub sign-in was started elsewhere. Try again.');
    if (q.error) return fail(q.error_description || q.error);
    if (!q.code) return fail('GitHub sent no sign-in code. Try again.');
    try {
      const token = await identities.exchange(q.code);
      await identities.connect(st.user, token, 'oauth');
    } catch (e) {
      return fail((e as Error).message);
    }
    connected();
    return reply.redirect(withConnected(st.to));
  });
}
