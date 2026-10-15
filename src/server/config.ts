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
}

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
  };
  if (!cfg.disableAuth && !cfg.appPassword && !cfg.appPasswordHash) {
    throw new Error('Set APP_PASSWORD or APP_PASSWORD_HASH (or DISABLE_AUTH=1 for local testing only).');
  }
  if (!cfg.workerToken) throw new Error('Set WORKER_TOKEN (shared secret between server and worker).');
  return cfg;
}
