// Worker: connects to its servers (WORKER_CONFIG, or one from the env), runs Claude sessions and git commands.
import { join, resolve } from 'node:path';
import { loadWorkerConfig } from './config.ts';
import { migrateLegacyLayout } from './layout.ts';
import { expandDirs, linkAgentSkills, type RunnerOptions } from './runner.ts';
import { ServerLink, Slots } from './serverLink.ts';
import { setAgentPath } from './toolPath.ts';
import { Logins } from './login.ts';
import { claudeAccounts, claudeConfigDir, claudeEnv, githubAccounts, githubEnv, pick, sessionGithubEnv, type ClaudeAccountInfo } from '../shared/accounts.ts';
import { Secrets } from './secrets.ts';

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
  // per-session environment: the session's Claude account, and its starter's own GitHub account
  // (DISP-63) or else the project's env account
  sessionEnv: (spec) => {
    const base = claudeEnv(spec.claude_account ? pick(clAccounts, spec.claude_account) : undefined, process.env, (name) => join(configRoot, name));
    // a user's session gets no token of this machine's env accounts (theirs replaces GH_TOKEN and co.)
    if (spec.github) for (const k of Object.keys(base)) if (/^GITHUB_ACCOUNT_.+_TOKEN$/.test(k)) delete base[k];
    return { ...base, ...sessionGithubEnv(spec, ghAccounts) };
  },
  accountLabel: (name) => (name ? pick(clAccounts, name) : undefined)?.label ?? name ?? 'default',
  // how to sign in again, and noted for the login check (DISP-60)
  loginFailed: (name, error, detail) => logins.failedNow(name, error, detail),
  // local-only repos (agents push branches into them): off unless LOCAL_REPO_DIRS is set
  assistantModel: env.ASSISTANT_MODEL || 'haiku',
  discussModel: env.DISCUSS_MODEL || env.ASSISTANT_MODEL || 'haiku',
  assistantReadDirs: expandDirs(env.ASSISTANT_READ_DIRS ?? ''),
  agentSkillsDir: linkAgentSkills(expandDirs(env.AGENT_SKILLS ?? ''), resolve(env.WORKSPACES_DIR ?? './data/workspaces', 'agent-skills')),
};

// Accounts (names and credentials from env; see src/shared/accounts.ts)
const ghAccounts = githubAccounts(env);
const clAccounts = claudeAccounts(env);
const configRoot = resolve(env.WORKSPACES_DIR ?? './data/workspaces', 'claude-config');
// whether each account is signed in: reads the config folder the sessions run with
const logins = new Logins(clAccounts, process.env, configRoot);

// Let git and gh (ours and the agent's) authenticate to GitHub without writing a token to disk.
// Each repo's / session's account sets DISPATCH_GH_TOKEN; the first account is the fallback. Also
// with no env account: a user's session brings its own token (DISP-63). No token: no answer, so git
// asks no one rather than sending an empty password.
if (ghAccounts.length) {
  env.GITHUB_TOKEN ??= ghAccounts[0].token;
  env.GH_TOKEN ??= ghAccounts[0].token;
}
{
  const n = Number(env.GIT_CONFIG_COUNT ?? 0);
  env[`GIT_CONFIG_KEY_${n}`] = 'credential.https://github.com.helper';
  env[`GIT_CONFIG_VALUE_${n}`] = '!f() { t="${DISPATCH_GH_TOKEN:-$GITHUB_TOKEN}"; [ -n "$t" ] && { echo username=x-access-token; echo "password=$t"; }; }; f';
  env.GIT_CONFIG_COUNT = String(n + 1);
}

// every secret this worker knows: scrubbed from all it sends (DISP-63); users' tokens are added as they come
const secrets = new Secrets();
for (const a of ghAccounts) secrets.add(a.token);
for (const a of clAccounts) {
  secrets.add(a.oauth_token);
  secrets.add(a.api_key);
}
for (const k of ['WORKER_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) secrets.add(env[k]);

/** Which Claude accounts this worker has, and whether each is signed in (for the app; no secrets). */
function claudeAccountInfo(): ClaudeAccountInfo[] {
  return clAccounts.map((a) => logins.info(a.name));
}

const cfg = loadWorkerConfig(env);
const workspacesDir = env.WORKSPACES_DIR ?? './data/workspaces';
// older workers kept the first server's folders in WORKSPACES_DIR itself: move them to its own folder,
// with Claude's transcripts for them, before any session starts (DISP-62)
if (cfg.servers.length) {
  const configDirs = [claudeConfigDir(undefined, env, (n) => join(configRoot, n)), ...clAccounts.map((a) => claudeConfigDir(a, env, (n) => join(configRoot, n)))];
  await migrateLegacyLayout(workspacesDir, cfg.servers[0].name, configDirs);
}
const slots = new Slots(cfg.max_concurrent);
for (const s of cfg.servers) secrets.add(s.token);
const links = cfg.servers.map((entry) => new ServerLink(entry, {
  fake: FAKE,
  opts,
  workspacesDir,
  slots,
  claudeAccounts: claudeAccountInfo,
  checkLogin: (name) => logins.info(name),
  githubAccounts: ghAccounts.map((a) => a.name),
  gitEnv: (repo) => githubEnv(pick(ghAccounts, repo.github_account)),
  remoteBase: env.GIT_REMOTE_BASE ?? 'https://github.com',
  secrets,
}));
slots.links = links;
for (const l of links) l.connect();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const l of links) l.closeAll();
    process.exit(0);
  });
}
