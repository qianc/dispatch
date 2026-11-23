import { readFileSync } from 'node:fs';
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
  pollSeconds: number;
  /** how often the open PRs of every project's GitHub repos are synced (0: only on demand) */
  prSyncSeconds: number;
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
  /** where hosted repos import from and push to (GITHUB_GIT_BASE; tests point it at a folder) */
  githubGitBase: string;
  /** GitHub's API (GITHUB_API_URL), e.g. https://github.example.com/api/v3 for an enterprise GitHub */
  githubApiUrl: string;
  proxySecretHeader: string;
  /**
   * The person who owns this install (DISPATCH_OWNER, else the first AUTH_USERS entry in proxy mode,
   * else the single user): inherits rows from before users, and alone manages projects and settings.
   * With `adoptOwner` this is only a placeholder: read the owner from Users (users.installOwner).
   */
  installOwner: string;
  /**
   * proxy mode with neither DISPATCH_OWNER nor AUTH_USERS: the first person signed in through the
   * proxy becomes the install owner (users.ts adopt()).
   */
  adoptOwner: boolean;
  /** key for secrets kept in the database (DISPATCH_SECRET_KEY); null: a generated key file */
  secretKey: string | null;
  /** GitHub OAuth App for "Connect with GitHub" (GITHUB_OAUTH_CLIENT_ID / _SECRET); null: paste a token */
  githubOAuth: { clientId: string; clientSecret: string } | null;
  /** Dispatch's own repo on GitHub, owner/name (UPDATE_REPO); null: the origin of the server's checkout (DISP-112) */
  updateRepo: string | null;
  /** the branch releases are on (UPDATE_BRANCH) */
  updateBranch: string;
  /** how often to look for a new version (UPDATE_POLL_MINUTES); 0: only on "Check now" */
  updatePollMinutes: number;
  /** the GitHub account to look with (UPDATE_GITHUB_ACCOUNT); null: the first, or none */
  updateGithubAccount: string | null;
  /** ms after its start in which the server takes no worker: the launcher still watches whether the new version holds (DISP-112) */
  settleMs: number;
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Swarm and Kubernetes pass secrets as files: NAME_FILE=/run/secrets/x fills NAME (when NAME is not
 * set itself), so the stack's environment holds no secret values.
 */
function withFileSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const [key, path] of Object.entries(env)) {
    if (!key.endsWith('_FILE') || !path) continue;
    const name = key.slice(0, -'_FILE'.length);
    if (out[name]) continue;
    try {
      out[name] = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
    } catch (e) {
      throw new Error(`${key}: cannot read ${path} (${(e as Error).message})`);
    }
  }
  return out;
}

export function loadConfig(raw = process.env): Config {
  const env = withFileSecrets(raw);
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
    pollSeconds: Number(env.GITHUB_POLL_SECONDS ?? 120),
    prSyncSeconds: Number(env.GITHUB_PR_SYNC_SECONDS ?? 300),
    publicUrl: env.PUBLIC_URL ?? 'http://localhost:3000',
    vapidSubject: env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
    authMode: env.DISABLE_AUTH === '1' ? 'off' : env.AUTH_MODE === 'proxy' ? 'proxy' : 'password',
    trustedProxies: list(env.TRUSTED_PROXIES),
    authHeader: (env.AUTH_HEADER ?? 'Remote-User').toLowerCase(),
    authUsers: list(env.AUTH_USERS),
    remoteTokenScopes: env.TOKEN_REMOTE_SCOPES !== undefined ? list(env.TOKEN_REMOTE_SCOPES) : ['read', 'tracker'],
    proxySecret: env.PROXY_SECRET || null,
    githubGitBase: (env.GITHUB_GIT_BASE ?? 'https://github.com').replace(/\/$/, ''),
    githubApiUrl: (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, ''),
    proxySecretHeader: (env.PROXY_SECRET_HEADER ?? 'X-Proxy-Secret').toLowerCase(),
    installOwner: '',
    adoptOwner: false,
    secretKey: env.DISPATCH_SECRET_KEY || null,
    githubOAuth: env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET ? { clientId: env.GITHUB_OAUTH_CLIENT_ID, clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET } : null,
    updateRepo: env.UPDATE_REPO?.trim() || null,
    updateBranch: env.UPDATE_BRANCH?.trim() || 'main',
    updatePollMinutes: Number(env.UPDATE_POLL_MINUTES ?? 30),
    updateGithubAccount: env.UPDATE_GITHUB_ACCOUNT?.trim() || null,
    settleMs: Math.max(0, Number(env.DISPATCH_SETTLE_MS) || 0),
  };
  cfg.installOwner = env.DISPATCH_OWNER?.trim() || (cfg.authMode === 'proxy' ? cfg.authUsers[0] : undefined) || (cfg.authMode === 'off' ? 'local' : 'owner');
  cfg.adoptOwner = cfg.authMode === 'proxy' && !env.DISPATCH_OWNER?.trim() && !cfg.authUsers.length;
  // the owner is never locked out of their own install (DISP-237)
  if (cfg.authUsers.length && !cfg.authUsers.includes(cfg.installOwner)) {
    console.warn(`AUTH_USERS leaves out the install owner "${cfg.installOwner}": they may use the install all the same. Add them to AUTH_USERS, or set DISPATCH_OWNER.`);
    cfg.authUsers.push(cfg.installOwner);
  }
  if (cfg.proxySecret && cfg.proxySecret.length < 24) throw new Error('PROXY_SECRET must be at least 24 characters.');
  if (env.AUTH_MODE && !['password', 'proxy'].includes(env.AUTH_MODE)) throw new Error('AUTH_MODE must be password or proxy.');
  if (cfg.authMode === 'password' && !cfg.appPassword && !cfg.appPasswordHash) {
    throw new Error('Set APP_PASSWORD or APP_PASSWORD_HASH, or AUTH_MODE=proxy with TRUSTED_PROXIES (or DISABLE_AUTH=1 for local testing only).');
  }
  if (cfg.authMode === 'proxy' && !cfg.trustedProxies.length) throw new Error('AUTH_MODE=proxy needs TRUSTED_PROXIES: the address(es) of the proxy.');
  if (cfg.updateRepo && !/^[\w.-]+\/[\w.-]+$/.test(cfg.updateRepo)) throw new Error('UPDATE_REPO must be owner/name, as on GitHub.');
  if (!/^[\w./-]+$/.test(cfg.updateBranch) || cfg.updateBranch.startsWith('-')) throw new Error('UPDATE_BRANCH must be a branch name.');
  if (!Number.isFinite(cfg.updatePollMinutes) || cfg.updatePollMinutes < 0) throw new Error('UPDATE_POLL_MINUTES must be 0 or more.');
  if (!cfg.workerToken) throw new Error('Set WORKER_TOKEN (shared secret between server and worker).');
  return cfg;
}
