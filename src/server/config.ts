import { githubAccounts, type GithubAccount } from '../shared/accounts.ts';

export interface Config {
  port: number;
  dataDir: string;
  webDist: string;
  appPassword: string | null;
  appPasswordHash: string | null;
  disableAuth: boolean;
  workerToken: string;
  githubToken: string | null;
  githubAccounts: GithubAccount[];
  maxConcurrent: number;
  pollSeconds: number;
  publicUrl: string;
  vapidSubject: string;
  /**
   * How people sign in:
   * - password: the app's own login (APP_PASSWORD / APP_PASSWORD_HASH). Works with no other infra.
   * - proxy: a trusted reverse proxy (e.g. Traefik + an SSO forward-auth) names the user in a header.
   *   Only requests from TRUSTED_PROXIES are believed; other non-local requests are refused, and the
   *   password login is left for this machine only (a way in when the proxy is down).
   * - off: no sign-in at all (DISABLE_AUTH=1; local testing only).
   */
  authMode: 'password' | 'proxy' | 'off';
  /** proxy mode: addresses (IPs or CIDRs) of the proxy */
  trustedProxies: string[];
  /** proxy mode: header with the signed-in user (lower case) */
  authHeader: string;
  /** proxy mode: users allowed in; empty = whoever the proxy lets through */
  authUsers: string[];
  /** scopes a token may use when the request does not come from this machine */
  remoteTokenScopes: string[];
  /**
   * proxy mode, optional but recommended: a secret the proxy adds to every request (header
   * PROXY_SECRET_HEADER). Everything else on the proxy's host shares its address; with the secret,
   * only the proxy itself counts as the proxy.
   */
  proxySecret: string | null;
  proxySecretHeader: string;
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env = process.env): Config {
  const cfg: Config = {
    port: Number(env.PORT ?? 3000),
    dataDir: env.DATA_DIR ?? './data',
    webDist: env.WEB_DIST ?? './dist/web',
    appPassword: env.APP_PASSWORD || null,
    appPasswordHash: env.APP_PASSWORD_HASH || null,
    disableAuth: env.DISABLE_AUTH === '1',
    workerToken: env.WORKER_TOKEN ?? '',
    githubToken: env.GITHUB_TOKEN || null,
    githubAccounts: githubAccounts(env),
    maxConcurrent: Number(env.MAX_CONCURRENT_SESSIONS ?? 3),
    pollSeconds: Number(env.GITHUB_POLL_SECONDS ?? 120),
    publicUrl: env.PUBLIC_URL ?? 'http://localhost:3000',
    vapidSubject: env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
    authMode: env.DISABLE_AUTH === '1' ? 'off' : env.AUTH_MODE === 'proxy' ? 'proxy' : 'password',
    trustedProxies: list(env.TRUSTED_PROXIES),
    authHeader: (env.AUTH_HEADER ?? 'Remote-User').toLowerCase(),
    authUsers: list(env.AUTH_USERS),
    remoteTokenScopes: env.TOKEN_REMOTE_SCOPES !== undefined ? list(env.TOKEN_REMOTE_SCOPES) : ['read', 'tracker'],
    proxySecret: env.PROXY_SECRET || null,
    proxySecretHeader: (env.PROXY_SECRET_HEADER ?? 'X-Proxy-Secret').toLowerCase(),
  };
  if (cfg.proxySecret && cfg.proxySecret.length < 24) throw new Error('PROXY_SECRET must be at least 24 characters.');
  if (env.AUTH_MODE && !['password', 'proxy'].includes(env.AUTH_MODE)) throw new Error('AUTH_MODE must be password or proxy.');
  if (cfg.authMode === 'password' && !cfg.appPassword && !cfg.appPasswordHash) {
    throw new Error('Set APP_PASSWORD or APP_PASSWORD_HASH, or AUTH_MODE=proxy with TRUSTED_PROXIES (or DISABLE_AUTH=1 for local testing only).');
  }
  if (cfg.authMode === 'proxy' && !cfg.trustedProxies.length) throw new Error('AUTH_MODE=proxy needs TRUSTED_PROXIES: the address(es) of the proxy.');
  if (!cfg.workerToken) throw new Error('Set WORKER_TOKEN (shared secret between server and worker).');
  return cfg;
}
