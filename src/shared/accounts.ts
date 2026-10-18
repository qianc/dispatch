// Accounts from the environment. Secrets stay in env (from your password manager); the database and the web app
// only ever see account names, labels and status.
//
//   GITHUB_ACCOUNTS=personal,work
//   GITHUB_ACCOUNT_WORK_TOKEN=github_pat_…   GITHUB_ACCOUNT_WORK_GIT_NAME=…   GITHUB_ACCOUNT_WORK_GIT_EMAIL=…
//   (without GITHUB_ACCOUNTS: GITHUB_TOKEN + GIT_AUTHOR_NAME/EMAIL form one account named "default")
//
//   CLAUDE_ACCOUNTS=private,work
//   CLAUDE_ACCOUNT_WORK_CONFIG_DIR=~/.claude-dispatch/work   (log in once: CLAUDE_CONFIG_DIR=… claude, then /login)
//   CLAUDE_ACCOUNT_PRIVATE_OAUTH_TOKEN=…   (claude setup-token)   or   CLAUDE_ACCOUNT_X_API_KEY=…
//   CLAUDE_ACCOUNT_X_LABEL="Work"
//   (without CLAUDE_ACCOUNTS: one account "default" = this machine's login / CLAUDE_CODE_OAUTH_TOKEN, unchanged)

export interface GithubAccount {
  name: string;
  token: string;
  git_name: string | null;
  git_email: string | null;
}

export type ClaudeAccountKind = 'config_dir' | 'oauth_token' | 'api_key' | 'machine';

export interface ClaudeAccount {
  name: string;
  label: string;
  kind: ClaudeAccountKind;
  config_dir?: string;
  oauth_token?: string;
  api_key?: string;
}

/** What the server and the web app may know about a Claude account. */
export interface ClaudeAccountInfo {
  name: string;
  label: string;
  kind: ClaudeAccountKind;
  /** null when it cannot be told without trying */
  logged_in: boolean | null;
  config_dir: string | null;
}

type Env = Record<string, string | undefined>;

const envKey = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const home = (p: string, env: Env) => p.replace(/^~(?=$|\/)/, env.HOME ?? '~');

export function githubAccounts(env: Env): GithubAccount[] {
  const names = list(env.GITHUB_ACCOUNTS);
  if (!names.length) {
    return env.GITHUB_TOKEN
      ? [{ name: 'default', token: env.GITHUB_TOKEN, git_name: env.GIT_AUTHOR_NAME ?? null, git_email: env.GIT_AUTHOR_EMAIL ?? null }]
      : [];
  }
  return names.map((name) => {
    const k = `GITHUB_ACCOUNT_${envKey(name)}_`;
    const token = env[`${k}TOKEN`];
    if (!token) throw new Error(`GITHUB_ACCOUNTS lists "${name}" but ${k}TOKEN is not set`);
    return { name, token, git_name: env[`${k}GIT_NAME`] ?? null, git_email: env[`${k}GIT_EMAIL`] ?? null };
  });
}

export function claudeAccounts(env: Env): ClaudeAccount[] {
  const names = list(env.CLAUDE_ACCOUNTS);
  if (!names.length) {
    const kind: ClaudeAccountKind = env.CLAUDE_CODE_OAUTH_TOKEN ? 'oauth_token' : env.ANTHROPIC_API_KEY ? 'api_key' : 'machine';
    return [{ name: 'default', label: 'Default Claude login', kind }];
  }
  return names.map((name) => {
    const k = `CLAUDE_ACCOUNT_${envKey(name)}_`;
    const label = env[`${k}LABEL`] ?? name.charAt(0).toUpperCase() + name.slice(1);
    const config_dir = env[`${k}CONFIG_DIR`] ? home(env[`${k}CONFIG_DIR`]!, env) : undefined;
    const oauth_token = env[`${k}OAUTH_TOKEN`];
    const api_key = env[`${k}API_KEY`];
    const kind: ClaudeAccountKind = oauth_token ? 'oauth_token' : api_key ? 'api_key' : config_dir ? 'config_dir' : 'machine';
    if (kind === 'machine') throw new Error(`CLAUDE_ACCOUNTS lists "${name}" but none of ${k}CONFIG_DIR, ${k}OAUTH_TOKEN, ${k}API_KEY is set`);
    return { name, label, kind, config_dir, oauth_token, api_key };
  });
}

/**
 * Environment for a Claude process on this account. The legacy "default" account leaves the
 * environment as it is (existing sessions resume from ~/.claude). Others get their own config
 * folder, so work and private transcripts, memory and logins never mix.
 */
export function claudeEnv(account: ClaudeAccount | undefined, base: Env, fallbackConfigDir: (name: string) => string): Env {
  // the legacy single account (no CLAUDE_ACCOUNTS) runs with the environment as it is
  if (!account || (account.name === 'default' && !account.config_dir)) return { ...base };
  const env: Env = { ...base };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  env.CLAUDE_CONFIG_DIR = account.config_dir ?? fallbackConfigDir(account.name);
  if (account.oauth_token) env.CLAUDE_CODE_OAUTH_TOKEN = account.oauth_token;
  if (account.api_key) env.ANTHROPIC_API_KEY = account.api_key;
  return env;
}

/** Git and gh environment for a GitHub account: token for pushes and gh, and the commit identity. */
export function githubEnv(account: GithubAccount | undefined): Env {
  if (!account) return {};
  const env: Env = { DISPATCH_GH_TOKEN: account.token, GH_TOKEN: account.token };
  if (account.git_name) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = account.git_name;
  if (account.git_email) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = account.git_email;
  return env;
}

/** The account a session or repo uses: the named one, else the first. */
export function pick<T extends { name: string }>(accounts: T[], name: string | null | undefined): T | undefined {
  return (name && accounts.find((a) => a.name === name)) || accounts[0];
}
