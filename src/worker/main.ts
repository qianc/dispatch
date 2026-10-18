// Worker: connects to its servers (WORKER_CONFIG, or one from the env), runs Claude sessions and git commands.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadWorkerConfig } from './config.ts';
import { expandDirs, type RunnerOptions } from './runner.ts';
import { ServerLink, Slots } from './serverLink.ts';
import { setAgentPath } from './toolPath.ts';
import { claudeAccounts, claudeEnv, githubAccounts, githubEnv, pick, type ClaudeAccountInfo } from '../shared/accounts.ts';

const env = process.env;
// agents' PATH: extra tool folders first; under WSL also Windows' PATH (powershell.exe, …)
const addedToPath = setAgentPath(env);
if (addedToPath.length) console.log(`PATH for agents: added ${addedToPath.join(', ')}`);
const FAKE = env.RUNNER === 'fake';
const opts: RunnerOptions = {
  pluginDirs: (env.AGENT_PLUGIN_DIRS ?? '').split(':').filter(Boolean),
  settingSources: (env.AGENT_SETTING_SOURCES ?? 'user,project').split(',').filter(Boolean) as RunnerOptions['settingSources'],
  model: env.AGENT_MODEL || undefined,
  idleCloseMs: Number(env.IDLE_CLOSE_MINUTES ?? 10) * 60_000,
  // per-session environment: the session's Claude account and the project's GitHub account
  sessionEnv: (spec) => ({
    ...claudeEnv(spec.claude_account ? pick(clAccounts, spec.claude_account) : undefined, process.env, (name) => join(configRoot, name)),
    ...githubEnv(pick(ghAccounts, spec.github_account)),
  }),
  accountLabel: (name) => (name ? pick(clAccounts, name) : undefined)?.label ?? name ?? 'default',
  loginHint: (name) => {
    const a = name ? pick(clAccounts, name) : clAccounts[0];
    const dir = a?.config_dir ?? (a?.kind === 'machine' ? '~/.claude' : join(configRoot, a?.name ?? 'default'));
    return a?.kind === 'oauth_token' ? `Create a new token with \`claude setup-token\` and update CLAUDE_ACCOUNT_${(a.name).toUpperCase()}_OAUTH_TOKEN.`
      : a?.kind === 'api_key' ? 'Check the API key in the worker env.'
      : `On the worker machine run \`CLAUDE_CONFIG_DIR=${dir} claude\`, then /login. After that, send the session a message to resume.`;
  },
  // local-only repos (agents push branches into them): off unless LOCAL_REPO_DIRS is set
  assistantModel: env.ASSISTANT_MODEL || 'haiku',
  discussModel: env.DISCUSS_MODEL || env.ASSISTANT_MODEL || 'haiku',
  assistantReadDirs: expandDirs(env.ASSISTANT_READ_DIRS ?? ''),
};

// Accounts (names and credentials from env; see src/shared/accounts.ts)
const ghAccounts = githubAccounts(env);
const clAccounts = claudeAccounts(env);
const configRoot = resolve(env.WORKSPACES_DIR ?? './data/workspaces', 'claude-config');

// Let git and gh (ours and the agent's) authenticate to GitHub without writing a token to disk.
// Each repo's / session's account sets DISPATCH_GH_TOKEN; the first account is the fallback.
if (ghAccounts.length) {
  env.GITHUB_TOKEN ??= ghAccounts[0].token;
  env.GH_TOKEN ??= ghAccounts[0].token;
  const n = Number(env.GIT_CONFIG_COUNT ?? 0);
  env[`GIT_CONFIG_KEY_${n}`] = 'credential.https://github.com.helper';
  env[`GIT_CONFIG_VALUE_${n}`] = '!f() { echo username=x-access-token; echo "password=${DISPATCH_GH_TOKEN:-$GITHUB_TOKEN}"; }; f';
  env.GIT_CONFIG_COUNT = String(n + 1);
}

/** Which Claude accounts this worker has, and whether a login is present (for the app; no secrets). */
function claudeAccountInfo(): ClaudeAccountInfo[] {
  return clAccounts.map((a) => {
    const dir = a.config_dir ?? (a.kind === 'machine' ? join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? '', '.claude')) : null);
    const logged_in = a.kind === 'oauth_token' || a.kind === 'api_key' ? true : dir ? existsSync(join(dir, '.credentials.json')) : null;
    return { name: a.name, label: a.label, kind: a.kind, logged_in, config_dir: dir };
  });
}

const cfg = loadWorkerConfig(env);
const slots = new Slots(cfg.max_concurrent);
const links = cfg.servers.map((entry, i) => new ServerLink(entry, {
  fake: FAKE,
  opts,
  workspacesDir: env.WORKSPACES_DIR ?? './data/workspaces',
  first: i === 0,
  slots,
  claudeAccounts: claudeAccountInfo,
  githubAccounts: ghAccounts.map((a) => a.name),
  gitEnv: (repo) => githubEnv(pick(ghAccounts, repo.github_account)),
  remoteBase: env.GIT_REMOTE_BASE ?? 'https://github.com',
}));
slots.links = links;
for (const l of links) l.connect();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const l of links) l.closeAll();
    process.exit(0);
  });
}
