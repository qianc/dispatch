// Worker: connects to the server, runs Claude sessions and git commands.
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { RpcMethod, ServerToWorker, StartSpec, WorkerCommand, WorkerToServer } from '../shared/protocol.ts';
import { FakeRunner } from './fakeRunner.ts';
import { ClaudeRunner, expandDirs, insideDirs, type AgentRunner, type RunnerDeps, type RunnerOptions } from './runner.ts';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { run, Workspaces } from './workspace.ts';
import { claudeAccounts, claudeEnv, githubAccounts, githubEnv, pick, type ClaudeAccountInfo } from '../shared/accounts.ts';

const env = process.env;
const SERVER = env.SERVER_WS_URL ?? 'ws://localhost:3000/worker';
const TOKEN = env.WORKER_TOKEN ?? '';
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

if (!TOKEN) throw new Error('Set WORKER_TOKEN');

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

const localRepoDirs = expandDirs(env.LOCAL_REPO_DIRS ?? '');
const workspaces = new Workspaces(env.WORKSPACES_DIR ?? './data/workspaces', env.GIT_REMOTE_BASE ?? 'https://github.com', (repo) => githubEnv(pick(ghAccounts, repo.github_account)));
const runners = new Map<number, AgentRunner>();
/** Sessions whose workspace is still being prepared; messages for them wait here. */
const starting = new Map<number, string[]>();
/** Messages produced while the server connection is down; flushed on reconnect so nothing is lost. */
const outbox: WorkerToServer[] = [];
const rpcWaiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let ws: WebSocket | null = null;

function send(msg: WorkerToServer) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else if (msg.t !== 'rpc') outbox.push(msg); // rpc calls time out on their own and are retried by the agent
}

function rpcFor(sessionId: number) {
  return (method: RpcMethod, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const req_id = randomUUID();
      rpcWaiting.set(req_id, { resolve, reject });
      send({ t: 'rpc', req_id, session_id: sessionId, method, params });
      setTimeout(() => {
        if (rpcWaiting.delete(req_id)) reject(new Error('Dispatch server did not answer in time'));
      }, 60_000);
    });
}

/** Folders an item's discussion may read: repo checkouts, plus the folder its imported source came from. */
async function discussContext(spec: StartSpec) {
  const dirs: string[] = [];
  if (spec.repos.length) {
    await workspaces.prepare(spec); // read-only detached checkouts (branch is null)
    dirs.push(...spec.repos.map((r) => workspaces.repoDir(spec.session_id, r)));
  }
  const src = spec.source?.title;
  if (src && isAbsolute(src) && insideDirs(src, opts.assistantReadDirs, '/')) dirs.push(dirname(src));
  // folders of the owner's real checkout that git does not carry into a session (repo setting)
  const extra: string[] = [];
  for (const r of spec.repos) {
    if (!r.local_path) continue;
    for (const d of r.read_dirs ?? []) {
      const abs = resolve(r.local_path, d);
      if (existsSync(abs) && insideDirs(abs, [r.local_path], '/')) extra.push(abs);
    }
  }
  const context: { label: string; text: string }[] = [];
  if (extra.length) {
    context.push({
      label: 'More folders you may read',
      text: [
        "These folders are in the owner's own checkout and are not in git, so they are not in the checkouts above. Read, Glob and Grep work there too. Images you Read are shown to the owner.",
        ...extra.map((d) => `- ${d}`),
        'They can hold material the owner keeps out of git on purpose. Quote from it only what the question needs.',
      ].join('\n'),
    });
  }
  for (const d of dirs) {
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const f = resolve(d, name);
      if (existsSync(f)) context.push({ label: `${name} from ${d}`, text: (await readFile(f, 'utf8')).slice(0, 30_000) });
    }
  }
  const cwd = dirs[0] ?? join(workspaces.root, 'assistant');
  await mkdir(cwd, { recursive: true });
  return { dirs: [...dirs, ...extra], context, cwd };
}

async function launch(spec: StartSpec, text: string) {
  // spec and text may be adjusted below (attached worktrees, setup notes)
  const id = spec.session_id;
  const live = runners.get(id);
  if (live) return live.push(text);
  const waiting = starting.get(id);
  if (waiting) return void waiting.push(text); // still preparing: deliver after start
  starting.set(id, []);
  try {
    let cwd: string;
    let extra: Pick<RunnerDeps, 'readDirs' | 'context'> = {};
    // the fake runner cannot clone GitHub repos, but local ones are real git (as for work sessions)
    if (spec.kind === 'discuss' && (!FAKE || spec.repos.every((r) => r.local_path))) {
      const c = await discussContext(spec);
      cwd = c.cwd;
      extra = { readDirs: c.dirs, context: c.context };
    } else if (FAKE) cwd = process.cwd();
    else if (spec.kind === 'assistant') {
      // the assistant reads only allow-listed folders; give it an empty working dir
      cwd = join(workspaces.root, 'assistant');
      await mkdir(cwd, { recursive: true });
    } else {
      const created: { repo: StartSpec['repos'][number]; wt: string }[] = [];
      cwd = await workspaces.prepare(spec, created);
      // the prompt needs to know which worktrees live in the owner's repo (no push needed there)
      spec = { ...spec, repos: spec.repos.map((r) => ({ ...r, attached: Workspaces.isAttached(workspaces.repoDir(spec.session_id, r), r) })) };
      // per-repo setup for new worktrees (venv, npm ci, ...), before the agent starts
      for (const { repo, wt } of created.filter((c) => c.repo.setup_command)) {
        send({ t: 'event', session_id: id, body: { kind: 'system', text: `Setting up ${repo.github_name}: ${repo.setup_command}` } });
        const res = await workspaces.setup(repo, wt);
        send({ t: 'event', session_id: id, body: { kind: res.ok ? 'system' : 'error', text: res.ok ? `Setup of ${repo.github_name} done.` : `Setup of ${repo.github_name} failed:\n${res.output}` } });
        if (!res.ok) text = `Note from Dispatch: the worktree setup command \`${repo.setup_command}\` failed in ${repo.github_name}. Its output:\n\n${res.output}\n\nFix the environment first if your work needs it.\n\n${text}`;
      }
    }
    const deps: RunnerDeps = {
      emit: send,
      rpc: rpcFor(id),
      cwd,
      onClosed: () => {
        if (runners.get(id) === runner) runners.delete(id);
      },
      ...extra,
    };
    const runner: AgentRunner = FAKE ? new FakeRunner(spec, deps) : new ClaudeRunner(spec, deps, opts);
    const queued = starting.get(id) ?? [];
    starting.delete(id);
    runners.set(id, runner);
    runner.start(text);
    for (const t of queued) runner.push(t);
  } catch (e) {
    starting.delete(id);
    console.error(`session ${id} failed to start`, e);
    send({ t: 'status', session_id: id, status: 'failed', error: `Could not start: ${(e as Error).message}` });
  }
}

async function command(cmd: WorkerCommand): Promise<unknown> {
  // the fake runner still does real git for files and local repos; it only skips GitHub pushes/merges
  const local = 'repo' in cmd && !!cmd.repo?.local_path;
  if (FAKE && !local && !['read_file', 'inspect_local_repo'].includes(cmd.c)) return { ok: true };
  switch (cmd.c) {
    case 'push_branch':
      await workspaces.pushBranch(cmd.repo, cmd.session_id, cmd.branch);
      return { ok: true };
    case 'merge_local':
      return workspaces.mergeLocal(cmd.repo, cmd.branch, cmd.message);
    case 'branch_status':
      return workspaces.branchStatus(cmd.repo, cmd.branch);
    case 'branch_diff':
      return workspaces.branchDiff(cmd.repo, cmd.branch);
    case 'inspect_local_repo': {
      const path = resolve(cmd.path.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
      if (!localRepoDirs.length) throw new Error('Local repos are turned off. Set LOCAL_REPO_DIRS on the worker to the folders that may hold them.');
      if (!insideDirs(path, localRepoDirs, '/')) throw new Error(`${path} is outside LOCAL_REPO_DIRS (${localRepoDirs.join(', ')})`);
      const top = await run('git', ['rev-parse', '--show-toplevel'], path);
      if (top.code !== 0) throw new Error(`${path} is not a git repository`);
      // run() merges stdout and stderr, so only trust output from commands that succeeded
      const ok = async (args: string[]) => {
        const r = await run('git', args, path);
        return r.code === 0 ? r.out.trim() : '';
      };
      const branch = (await ok(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '')
        || (await ok(['branch', '--show-current'])) || 'main';
      const deny = (await ok(['config', '--get', 'receive.denyCurrentBranch'])) || 'refuse';
      return { path: top.out.trim(), name: top.out.trim().split('/').pop(), default_branch: branch.trim(), receive_deny_current_branch: deny };
    }
    case 'read_file': {
      if (cmd.repo) return { base64: (await workspaces.readRepoFile(cmd.repo, cmd.path)).toString('base64') };
      if (!cmd.base_dir) throw new Error('read_file needs a repo or a base_dir');
      const full = resolve(cmd.base_dir, cmd.path);
      if (!insideDirs(full, opts.assistantReadDirs, '/')) throw new Error(`${full} is outside ASSISTANT_READ_DIRS`);
      const buf = await readFile(full);
      if (buf.length > 10 * 1024 * 1024) throw new Error('File is larger than 10 MB');
      return { base64: buf.toString('base64') };
    }
  }
}

async function onMessage(msg: ServerToWorker) {
  switch (msg.t) {
    case 'start':
      return launch(msg.spec, msg.spec.resume_note ?? msg.spec.prompt);
    case 'send':
      return launch({ ...msg.spec, resume: msg.spec.resume }, msg.text);
    case 'answer':
      return runners.get(msg.session_id)?.answer(msg.local_id, msg.answer);
    case 'interrupt':
      return runners.get(msg.session_id)?.interrupt();
    case 'close': {
      starting.delete(msg.session_id);
      const r = runners.get(msg.session_id);
      r?.close();
      if (msg.cleanup && !FAKE) await workspaces.cleanup(msg.session_id, msg.repos).catch((e) => console.warn('cleanup failed', e));
      return;
    }
    case 'rpc_result': {
      const p = rpcWaiting.get(msg.req_id);
      if (!p) return;
      rpcWaiting.delete(msg.req_id);
      return msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
    }
    case 'cmd':
      try {
        send({ t: 'cmd_result', req_id: msg.req_id, ok: true, data: await command(msg.cmd) });
      } catch (e) {
        send({ t: 'cmd_result', req_id: msg.req_id, ok: false, error: (e as Error).message });
      }
      return;
  }
}

function connect(delay = 1000) {
  const sock = new WebSocket(SERVER, { headers: { 'x-worker-token': TOKEN } });
  sock.on('open', () => {
    ws = sock;
    delay = 1000;
    console.log(`worker connected to ${SERVER}${FAKE ? ' (fake runner)' : ''}`);
    ws.send(JSON.stringify({ t: 'hello', live: [...runners.keys(), ...starting.keys()], claude_accounts: claudeAccountInfo() } satisfies WorkerToServer));
    for (const m of outbox.splice(0)) ws.send(JSON.stringify(m));
  });
  sock.on('message', (data) => {
    let msg: ServerToWorker;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    onMessage(msg).catch((e) => console.error('worker handler failed', msg.t, e));
  });
  sock.on('close', (code, reason) => {
    if (ws === sock) ws = null;
    if (code === 4001) console.error('server rejected the worker token');
    else if (code !== 1000) console.warn(`worker disconnected (${code} ${reason}); retrying`);
    setTimeout(() => connect(Math.min(delay * 2, 30_000)), delay);
  });
  sock.on('error', () => undefined);
}

connect();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const r of runners.values()) r.close();
    process.exit(0);
  });
}
