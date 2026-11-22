// One server this worker serves: its connection, its sessions (ids are per server), its workspaces
// and what it may use. The worker's slots are shared by all its links (see Slots).
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import WebSocket from 'ws';
import type { ClaudeAccountInfo } from '../shared/accounts.ts';
import type { GithubCred, RpcMethod, SelfUpdateAnswer, ServerToWorker, StartSpec, WorkerCommand, WorkerToServer } from '../shared/protocol.ts';
import { CHAT_KINDS, type Repo, type WorkerFacts, type WorkerVersion } from '../shared/types.ts';
import { serverAppUrl, serverGithubAccount, type ServerEntry } from './config.ts';
import { FakeRunner } from './fakeRunner.ts';
import { serverRoot } from './layout.ts';
import { Secrets } from './secrets.ts';
import { ClaudeRunner, insideDirs, type AgentRunner, type RunnerDeps, type RunnerOptions } from './runner.ts';
import { runServerUpdate, type ServerUpdateOptions } from './serverUpdate.ts';
import { checkRetries, TurnCheck } from './turnCheck.ts';
import { checkTimeoutMs, hostedGitBase, run, Workspaces } from './workspace.ts';

/** CLAUDE.md / AGENTS.md of these folders, as prompt context. */
async function ruleFiles(dirs: string[], names = ['CLAUDE.md', 'AGENTS.md']) {
  const out: { label: string; text: string }[] = [];
  for (const d of dirs) {
    for (const name of names) {
      const f = resolve(d, name);
      if (existsSync(f)) out.push({ label: `${name} from ${d}`, text: (await readFile(f, 'utf8')).slice(0, 30_000) });
    }
  }
  return out;
}

/** Agent sessions running on this worker, over all servers. Chats take no slot (as on the server). */
export class Slots {
  readonly max: number;
  private busy = new Set<string>();
  /** the worker is about to update itself: no slot is free, for any server (DISP-112) */
  private draining = false;
  links: ServerLink[] = [];

  constructor(max: number) {
    this.max = max;
  }

  get free() {
    return this.draining ? 0 : Math.max(0, this.max - this.busy.size);
  }

  /** Take no new agent session (true), or take them again (false). */
  drain(on: boolean) {
    if (this.draining === on) return;
    this.draining = on;
    for (const l of this.links) l.sendSlots();
  }

  has(key: string) {
    return this.busy.has(key);
  }

  set(key: string, busy: boolean) {
    const before = this.busy.size;
    if (busy) this.busy.add(key);
    else this.busy.delete(key);
    if (this.busy.size !== before) for (const l of this.links) l.sendSlots();
  }
}

export interface LinkShared {
  fake: boolean;
  /** runner options; the link sets its own read dirs */
  opts: RunnerOptions;
  /** each server's folders are WORKSPACES_DIR/servers/<name>, whatever its place in worker.json (DISP-62) */
  workspacesDir: string;
  slots: Slots;
  claudeAccounts: () => ClaudeAccountInfo[];
  /** whether a Claude account is signed in now (DISP-60) */
  checkLogin?: (name: string | null) => ClaudeAccountInfo;
  /** a short title for an orchestration's goal, on a Claude account (DISP-110) */
  makeTitle?: (goal: string, projects: string[], account: string | null) => Promise<string>;
  githubAccounts: string[];
  gitEnv: ConstructorParameters<typeof Workspaces>[2];
  remoteBase: string;
  /** every secret the worker knows: scrubbed from all it sends (DISP-63) */
  secrets?: Secrets;
  /** the commit this worker runs, and whether it can update itself (DISP-112) */
  version?: WorkerVersion;
  /** a server asks the worker to update itself (see updateGate.ts) */
  selfUpdate?: (from: ServerLink, sha: string, updateId: number) => Promise<SelfUpdateAnswer>;
  /** how a server's update command runs here (see serverUpdate.ts) */
  serverUpdate?: ServerUpdateOptions;
}

export class ServerLink {
  readonly entry: ServerEntry;
  private shared: LinkShared;
  private opts: RunnerOptions;
  readonly workspaces: Workspaces;
  private runners = new Map<number, AgentRunner>();
  /** sessions whose workspace is still being prepared; messages for them wait here */
  private starting = new Map<number, string[]>();
  private kinds = new Map<number, StartSpec['kind']>();
  /** work sessions' checks before a turn is reported done (DISP-15); kept across runner restarts */
  private turnChecks = new Map<number, TurnCheck>();
  /** sessions that act as their starter's own GitHub account (DISP-63): memory only, until the session closes */
  private creds = new Map<number, GithubCred>();
  private secrets: Secrets;
  /** messages produced while the server connection is down; flushed on reconnect so nothing is lost */
  private outbox: WorkerToServer[] = [];
  private rpcWaiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** what runs now for the server besides sessions (commands, deploys, pushes), by what it is (DISP-112) */
  private jobs = new Map<string, number>();
  private ws: WebSocket | null = null;
  private stopped = false;
  /** the worker stops for its own update: the link is down until it is back (DISP-112) */
  private paused = false;
  /** counts the pauses: a connection from before one is not used after it */
  private epoch = 0;
  /** the commit the server said it runs, in its answer to our last hello (DISP-112) */
  serverVersion: string | null = null;
  /** The server pings every 20 s (workerHub). Hearing nothing for this long means the connection
   * is dead but not closed (laptop slept, NAT entry gone): drop it and reconnect. */
  silenceMs = 60_000;

  constructor(entry: ServerEntry, shared: LinkShared) {
    this.entry = entry;
    this.shared = shared;
    this.secrets = shared.secrets ?? new Secrets();
    const root = serverRoot(shared.workspacesDir, entry.name);
    // this server's hosted repos are at its own address, with this worker's token for it
    // git for a repo of this server: the project's GitHub account, else the first this server is allowed here
    const gitEnv = (repo: Repo) => shared.gitEnv?.({ ...repo, github_account: serverGithubAccount(entry, repo.github_account) }) ?? {};
    this.workspaces = new Workspaces(root, shared.remoteBase, gitEnv, { base: hostedGitBase(entry.url), token: entry.token }, entry.repo_env_dir);
    // agents get no git access to hosted repos: they commit, and the worker pushes hosted branches
    // (pushHostedBranches). Their env is the worker's own, so a WORKER_TOKEN set there reaches them
    // too; the README accepts that (an agent can read what the worker process can).
    // agents report to the server that started them (DISPATCH_URL beats a repo's or machine's default)
    const appUrl = serverAppUrl(entry.url);
    const sessionEnv = shared.opts.sessionEnv;
    this.opts = {
      ...shared.opts,
      assistantReadDirs: entry.read_dirs,
      sessionEnv: (spec) => ({ ...(sessionEnv ? sessionEnv(spec) : process.env), DISPATCH_URL: appUrl }),
    };
  }

  private slotKey(id: number) {
    return `${this.entry.name}:${id}`;
  }

  /** Count `fn` as work that a restart of the worker would cut off. */
  private async job<T>(what: string, fn: () => Promise<T>): Promise<T> {
    this.jobs.set(what, (this.jobs.get(what) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (this.jobs.get(what) ?? 1) - 1;
      if (n > 0) this.jobs.set(what, n);
      else this.jobs.delete(what);
    }
  }

  /**
   * What this worker does for this server now that a restart would cut off; empty: it is in wait
   * mode for it (DISP-112). A session at the end of its turn, or waiting for the usage limit, is not
   * in the list: it goes on after a restart.
   */
  busyReasons(): string[] {
    const out: string[] = [];
    for (const id of this.starting.keys()) out.push(`session ${id} is starting`);
    for (const [id, r] of this.runners) {
      const a = r.activity();
      if (a) out.push(`session ${id} ${a}`);
    }
    for (const [id, tc] of this.turnChecks) if (tc.running) out.push(`session ${id} runs its check`);
    out.push(...this.jobs.keys());
    // results that wait for the server (a deploy's, a turn's end) are only in memory
    if (this.outbox.length) out.push(`${this.outbox.length} message${this.outbox.length === 1 ? ' for the server waits' : 's for the server wait'} to be sent`);
    return out;
  }

  /** What this server is told about the worker: only the accounts and folders it may use. */
  async facts(): Promise<WorkerFacts> {
    const claude = this.shared.claudeAccounts().filter((a) => this.allowedClaude(a.name));
    return {
      os: `${process.platform}${process.env.WSL_DISTRO_NAME ? ' (WSL)' : ''}`,
      hostname: hostname(),
      slots: this.shared.slots.max,
      free_slots: this.shared.slots.free,
      claude_accounts: claude,
      github_accounts: this.shared.githubAccounts.filter((a) => this.allowedGithub(a)),
      local_repo_dirs: this.entry.local_repo_dirs,
      releases: this.entry.releases,
      repo_envs: await this.workspaces.overlays().catch(() => []),
      // runs a session as its user's own GitHub account (DISP-63); knows the update messages (DISP-112)
      caps: ['github_cred', 'self_update'],
      ...(this.version() ? { version: this.version() } : {}),
    };
  }

  /** The worker's version, and whether it has a command that updates this server. */
  private version(): WorkerVersion | undefined {
    const v = this.shared.version;
    if (!this.entry.server_update_command) return v;
    return { ...(v ?? { sha: null, updatable: false }), server_update: true };
  }

  private allowedClaude(name: string | null) {
    return !this.entry.claude_accounts || this.entry.claude_accounts.includes(name ?? 'default');
  }

  private allowedGithub(name: string | null) {
    return !this.entry.github_accounts || (name !== null && this.entry.github_accounts.includes(name));
  }

  send(msg: WorkerToServer) {
    if (msg.t === 'status' && !CHAT_KINDS.includes(this.kinds.get(msg.session_id) ?? 'work')) {
      // a session holds a slot while it works; a finished turn frees it
      if (msg.status === 'running') this.shared.slots.set(this.slotKey(msg.session_id), true);
      if (['idle', 'failed', 'completed', 'stopped'].includes(msg.status)) this.shared.slots.set(this.slotKey(msg.session_id), false);
    }
    msg = this.secrets.scrub(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    // rpc calls time out on their own and are retried by the agent; old progress is of no use
    else if (msg.t !== 'rpc' && msg.t !== 'slots' && msg.t !== 'cmd_progress' && !(msg.t === 'session_check' && msg.progress)) this.outbox.push(msg);
  }

  sendSlots() {
    if (this.ws?.readyState === WebSocket.OPEN) this.write(this.ws, { t: 'slots', free: this.shared.slots.free });
  }

  /** Every message to the server goes out scrubbed of the secrets this worker knows (DISP-63). */
  private write(sock: WebSocket, msg: WorkerToServer) {
    sock.send(JSON.stringify(this.secrets.scrub(msg)));
  }

  /** A user's GitHub credential for a session (DISP-63): remembered while it lives, its token never sent back. */
  private remember(sessionId: number, cred: GithubCred | null | undefined) {
    if (!cred) return void this.creds.delete(sessionId);
    this.secrets.add(cred.token);
    this.creds.set(sessionId, cred);
  }

  private rpcFor(sessionId: number) {
    return (method: RpcMethod, params: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const req_id = randomUUID();
        this.rpcWaiting.set(req_id, { resolve, reject });
        this.send({ t: 'rpc', req_id, session_id: sessionId, method, params });
        setTimeout(() => {
          if (this.rpcWaiting.delete(req_id)) reject(new Error('Dispatch server did not answer in time'));
        }, 60_000);
      });
  }

  /** Folders an item's discussion may read: repo checkouts, plus the folder its imported source came from. */
  private async discussContext(spec: StartSpec) {
    const dirs: string[] = [];
    if (spec.repos.length) {
      await this.workspaces.prepare(spec); // read-only detached checkouts (branch is null)
      dirs.push(...spec.repos.map((r) => this.workspaces.repoDir(spec.session_id, r)));
    }
    // only the folder the Assistant's markdown import recorded; a title is caller-set text (DISP-152)
    const base = spec.source?.base_dir;
    if (base && isAbsolute(base) && insideDirs(base, this.opts.assistantReadDirs, '/')) dirs.push(base);
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
          "These folders are in the owner's own checkout and are not in git, so they are NOT in your checkout above. You may Read, Glob and Grep them, with these absolute paths:",
          ...extra.map((d) => `- ${d}`),
          '',
          '- When the owner names a file or folder (often a path relative to one of these folders, like `cvdd/renders/x.png`) and it is not in your checkout, look in these folders: Glob with `path` set to the folder. Do not say you cannot find a file before you have searched them.',
          '- Images you Read are shown to the owner in the chat, so Read an image when they ask to see it.',
          '- These folders can hold material the owner keeps out of git on purpose. Quote from it only what the question needs.',
        ].join('\n'),
      });
    }
    context.push(...(await ruleFiles(dirs)));
    const cwd = dirs[0] ?? join(this.workspaces.root, 'assistant');
    await mkdir(cwd, { recursive: true });
    return { dirs: [...dirs, ...extra], context, cwd };
  }

  /** A work session's branches of hosted repos, pushed to the server (the agent has no access itself). */
  async pushHostedBranches(spec: StartSpec) {
    if (!spec.branch) return;
    for (const repo of spec.repos.filter((r) => r.kind === 'hosted')) {
      try {
        await this.workspaces.pushBranch(repo, spec.session_id, spec.branch, spec.github);
      } catch (e) {
        this.send({ t: 'event', session_id: spec.session_id, body: { kind: 'error', text: `Could not push ${spec.branch} of ${repo.github_name} to Dispatch: ${(e as Error).message}` } });
      }
    }
  }

  /** Before a turn: fetch hosted repos, so the agent can merge origin/<base> without network access. */
  private async fetchHosted(spec: StartSpec) {
    for (const repo of spec.repos.filter((r) => r.kind === 'hosted')) {
      await this.workspaces.refresh(repo).catch((e) => console.warn(`fetch of ${repo.github_name} failed:`, (e as Error).message));
    }
  }

  /** Why this server may not run this spec here, or null. */
  private refusal(spec: StartSpec): string | null {
    // the server names the model; 'default' would leave it to Claude Code, which can change it any day (DISP-117)
    if (!CHAT_KINDS.includes(spec.kind) && spec.options.model === 'default') return `No model set for this session: server ${this.entry.name} sent none. Set the default model in the server's Settings, or update the server.`;
    if (!this.allowedClaude(spec.claude_account)) return `This worker does not allow the Claude account "${spec.claude_account ?? 'default'}" for server ${this.entry.name}.`;
    // a session as its user's own GitHub account uses none of this worker's (DISP-63)
    if (!spec.github && spec.github_account && !this.allowedGithub(spec.github_account)) return `This worker does not allow the GitHub account "${spec.github_account}" for server ${this.entry.name}.`;
    const outside = spec.repos.find((r) => r.local_path && !insideDirs(r.local_path, this.entry.local_repo_dirs, '/'));
    if (outside) return `${outside.local_path} is outside the folders this worker allows for server ${this.entry.name}.`;
    if (spec.kind === 'release' && !this.releaseCapability(spec)) return `This worker does not offer releases of ${spec.release?.cap_repo ?? 'this repo'} (${spec.release?.label_prefix ?? '?'}) for server ${this.entry.name}.`;
    return null;
  }

  /** The release in this worker's own config that a release spec runs under. */
  private releaseCapability(spec: StartSpec) {
    const r = spec.release;
    return r ? this.entry.releases.find((c) => c.repo === r.cap_repo && c.label_prefix === r.label_prefix) : undefined;
  }

  async launch(spec: StartSpec, text: string, isStart: boolean) {
    // spec and text may be adjusted below (attached worktrees, setup notes)
    const id = spec.session_id;
    this.kinds.set(id, spec.kind);
    this.remember(id, spec.github);
    const live = this.runners.get(id);
    if (live) {
      this.turnChecks.get(id)?.ownerTurn();
      // counted as work: a restart during the fetch would lose the message
      if (!this.shared.fake) await this.job(`session ${id} gets a message`, () => this.fetchHosted(spec));
      return live.push(text);
    }
    const waiting = this.starting.get(id);
    if (waiting) return void waiting.push(text); // still preparing: deliver after start
    const refused = this.refusal(spec);
    if (refused) return this.send({ t: 'status', session_id: id, status: 'failed', error: refused });
    // a release runs the command and notes of this worker's own config, never what a server sends
    const cap = spec.kind === 'release' ? this.releaseCapability(spec) : undefined;
    if (cap && spec.release) spec = { ...spec, release: { ...spec.release, command: cap.command, notes: cap.notes } };
    // the agent's gh and git: the project's GitHub account, else the first this server is allowed
    // here; a user's own account (DISP-63) instead of any
    if (!spec.github) spec = { ...spec, github_account: serverGithubAccount(this.entry, spec.github_account) };
    // the worker owns its slots: a new agent session waits when they are all taken (by any server)
    if (isStart && !CHAT_KINDS.includes(spec.kind) && !this.shared.slots.has(this.slotKey(id)) && this.shared.slots.free <= 0) {
      if (this.ws?.readyState === WebSocket.OPEN) this.write(this.ws, { t: 'refused', session_id: id, reason: 'busy' });
      return;
    }
    const queued: string[] = [];
    this.starting.set(id, queued);
    // a close while the workspace is prepared ends the start: nothing more runs for it (DISP-146)
    const stopped = new Error('closed while starting');
    const goOn = <T>(v: T) => {
      if (this.starting.get(id) !== queued) throw stopped;
      return v;
    };
    // the slot is taken from the moment the start is accepted: setup (clone, npm ci) can take minutes
    const holdsSlot = isStart && !CHAT_KINDS.includes(spec.kind);
    if (holdsSlot) this.shared.slots.set(this.slotKey(id), true);
    try {
      let cwd: string;
      let extra: Pick<RunnerDeps, 'readDirs' | 'context'> = {};
      // the fake runner cannot clone GitHub repos, but local ones are real git (as for work sessions)
      if (spec.kind === 'discuss' && (!this.shared.fake || spec.repos.every((r) => r.local_path))) {
        const c = goOn(await this.discussContext(spec));
        cwd = c.cwd;
        extra = { readDirs: c.dirs, context: c.context };
      } else if (spec.kind === 'release' && (!this.shared.fake || spec.repos.every((r) => r.local_path))) {
        cwd = goOn(await this.workspaces.prepareRelease(spec));
        extra = { context: goOn(await ruleFiles([cwd], ['AGENTS.md', '.dispatch.md'])) };
      } else if (this.shared.fake) cwd = process.cwd();
      else if (spec.kind === 'assistant') {
        // the assistant reads only allow-listed folders; give it an empty working dir
        cwd = join(this.workspaces.root, 'assistant');
        goOn(await mkdir(cwd, { recursive: true }));
      } else {
        const created: { repo: StartSpec['repos'][number]; wt: string }[] = [];
        cwd = goOn(await this.workspaces.prepare(spec, created));
        // a planner files items: it gets the project's own rules for them (CLAUDE.md of every repo, not only the cwd's)
        if (spec.kind === 'planner' || spec.kind === 'orchestrator') extra = { context: goOn(await ruleFiles(spec.repos.map((r) => this.workspaces.repoDir(spec.session_id, r)))) };
        // the prompt needs to know which worktrees live in the owner's repo (no push needed there)
        spec = { ...spec, repos: spec.repos.map((r) => ({ ...r, attached: Workspaces.isAttached(this.workspaces.repoDir(spec.session_id, r), r) })) };
        // per-repo setup for new worktrees, before the agent starts: this machine's env files
        // (DISP-44), then the setup command (venv, npm ci, ...)
        for (const { repo, wt } of created.filter((c) => c.repo.setup_command || this.workspaces.overlayDir(c.repo))) {
          if (repo.setup_command) this.send({ t: 'event', session_id: id, body: { kind: 'system', text: `Setting up ${repo.github_name}: ${repo.setup_command}` } });
          const res = goOn(await this.workspaces.prepareTree(repo, wt, spec.github));
          const files = res.copied.length ? ` Env files from this worker: ${res.copied.join(', ')}.` : '';
          this.send({ t: 'event', session_id: id, body: { kind: res.ok ? 'system' : 'error', text: res.ok ? `Setup of ${repo.github_name} done.${files}` : `Setup of ${repo.github_name} failed:\n${res.output}` } });
          if (!res.ok) text = `Note from Dispatch: setting up the worktree of ${repo.github_name} failed:\n\n${res.output}\n\nFix the environment first if your work needs it.\n\n${text}`;
        }
      }
      const hostedWork = spec.kind === 'work' && !!spec.branch && spec.repos.some((r) => r.kind === 'hosted') && !this.shared.fake;
      const deps: RunnerDeps = {
        // a finished turn of work on a hosted repo: push its branch first, so the server sees it
        emit: (m) => {
          if (hostedWork && m.t === 'status' && m.status === 'idle') void this.job(`session ${id} pushes its branch`, () => this.pushHostedBranches(spec)).finally(() => this.send(m));
          else this.send(m);
        },
        rpc: this.rpcFor(id),
        cwd,
        ...(this.turnCheck(spec) ? { beforeIdle: () => this.turnCheck(spec)!.gate() } : {}),
        onClosed: () => {
          if (this.runners.get(id) === runner) this.runners.delete(id);
          this.shared.slots.set(this.slotKey(id), false);
        },
        ...extra,
      };
      const runner: AgentRunner = this.shared.fake ? new FakeRunner(spec, deps, this.opts) : new ClaudeRunner(spec, deps, this.opts);
      goOn(null);
      this.starting.delete(id);
      this.runners.set(id, runner);
      runner.start(text);
      for (const t of queued) runner.push(t);
    } catch (e) {
      // closed meanwhile: close has freed the slot and tidied; a new start of the session owns what is left
      if (this.starting.get(id) !== queued) {
        if (holdsSlot && !this.starting.has(id) && !this.runners.has(id)) this.shared.slots.set(this.slotKey(id), false);
        return;
      }
      this.starting.delete(id);
      if (holdsSlot) this.shared.slots.set(this.slotKey(id), false);
      console.error(`[${this.entry.name}] session ${id} failed to start`, e);
      this.send({ t: 'status', session_id: id, status: 'failed', error: `Could not start: ${(e as Error).message}` });
    }
  }

  /**
   * A work session's check before its turn is reported done (DISP-15): when the batch wants it
   * and a repo has a check command. Not in fake mode: there are no worktrees to check.
   */
  private turnCheck(spec: StartSpec): TurnCheck | null {
    const id = spec.session_id;
    const repos = spec.repos.filter((r) => r.check_command);
    if (spec.kind !== 'work' || !spec.branch || !spec.options.turn_check || !repos.length || this.shared.fake) return null;
    let tc = this.turnChecks.get(id);
    if (!tc) {
      tc = new TurnCheck({
        sessionId: id, repos, retries: checkRetries(), timeoutMin: Math.round(checkTimeoutMs() / 60_000),
        state: (repo) => this.workspaces.turnState(repo, id),
        check: (repo, onProgress, signal) => this.workspaces.sessionCheck(repo, id, onProgress, signal, this.creds.get(id)),
        send: (m) => this.send(m),
      });
      this.turnChecks.set(id, tc);
    }
    return tc;
  }

  /** `onProgress`: a long command's progress, sent to the server as it runs */
  async command(cmd: WorkerCommand, onProgress?: (data: unknown) => void): Promise<unknown> {
    const ws = this.workspaces;
    // the fake runner still does real git for files and local repos; it only skips GitHub pushes/merges
    const local = 'repo' in cmd && !!cmd.repo?.local_path;
    // every local folder a command touches must be on this server's list (tidy and leftovers carry several)
    const folders = [...('repo' in cmd && cmd.repo ? [cmd.repo] : []), ...('repos' in cmd ? cmd.repos : [])].flatMap((r) => (r.local_path ? [r.local_path] : []));
    const outside = folders.find((f) => !insideDirs(f, this.entry.local_repo_dirs, '/'));
    if (outside) throw new Error(`${outside} is outside the folders this worker allows for server ${this.entry.name}`);
    // leftovers / tidy only look at real folders, so they run in fake mode too
    if (this.shared.fake && !local && !['read_file', 'inspect_local_repo', 'leftovers', 'tidy', 'check_login', 'make_title', 'self_update'].includes(cmd.c)) return { ok: true };
    switch (cmd.c) {
      case 'self_update':
        if (!this.shared.selfUpdate) return { state: 'refused', reason: 'This worker cannot update itself.' } satisfies SelfUpdateAnswer;
        return this.shared.selfUpdate(this, cmd.sha, cmd.update_id);
      case 'check_login':
        if (!this.allowedClaude(cmd.account)) throw new Error(`Claude account ${cmd.account ?? 'default'} is not one this worker uses for server ${this.entry.name}`);
        if (!this.shared.checkLogin) throw new Error('This worker cannot check logins');
        return this.shared.checkLogin(cmd.account);
      case 'make_title':
        if (!this.allowedClaude(cmd.account)) throw new Error(`Claude account ${cmd.account ?? 'default'} is not one this worker uses for server ${this.entry.name}`);
        if (!this.shared.makeTitle) throw new Error('This worker cannot write titles');
        return { title: await this.shared.makeTitle(cmd.goal, cmd.projects, cmd.account) };
      case 'release_version':
        return ws.releaseVersion(cmd.repo);
      case 'leftovers':
        return ws.leftovers(cmd.session_id, cmd.repos, cmd.branch, cmd.merged_repo_ids);
      case 'tidy':
        return ws.tidy(cmd.session_id, cmd.repos, cmd.branch, { deleteMerged: cmd.delete_merged, force: cmd.force, mergedHint: cmd.merged_repo_ids });
      case 'push_branch':
        // github null: the server chose the env accounts on purpose; absent (an older server): the session's
        await ws.pushBranch(cmd.repo, cmd.session_id, cmd.branch, 'github' in cmd ? cmd.github : this.creds.get(cmd.session_id));
        return { ok: true };
      case 'merge_local':
        return ws.mergeLocal(cmd.repo, cmd.branch, cmd.message, onProgress, cmd.items, cmd.github);
      case 'branch_status':
        return ws.branchStatus(cmd.repo, cmd.branch);
      case 'branch_diff':
        return ws.branchDiff(cmd.repo, cmd.branch, cmd.merged_sha);
      case 'inspect_local_repo': {
        const path = resolve(cmd.path.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
        const allowed = this.entry.local_repo_dirs;
        if (!allowed.length) throw new Error('Local repos are turned off. Set LOCAL_REPO_DIRS (or local_repo_dirs in WORKER_CONFIG) on the worker to the folders that may hold them.');
        if (!insideDirs(path, allowed, '/')) throw new Error(`${path} is outside ${this.entry.name === 'default' ? 'LOCAL_REPO_DIRS' : `local_repo_dirs of server ${this.entry.name}`} (${allowed.join(', ')})`);
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
        // the first commit names the repo: the same repo on another machine has the same one (DISP-45)
        const root_sha = (await ok(['rev-list', '--max-parents=0', 'HEAD'])).split('\n').filter(Boolean).sort()[0] ?? null;
        return { path: top.out.trim(), name: top.out.trim().split('/').pop(), default_branch: branch.trim(), receive_deny_current_branch: deny, root_sha };
      }
      case 'read_file': {
        if (cmd.repo) return { base64: (await ws.readRepoFile(cmd.repo, cmd.path)).toString('base64') };
        if (!cmd.base_dir) throw new Error('read_file needs a repo or a base_dir');
        const full = resolve(cmd.base_dir, cmd.path);
        if (!insideDirs(full, this.opts.assistantReadDirs, '/')) throw new Error(`${full} is outside the folders this worker allows reading`);
        const buf = await readFile(full);
        if (buf.length > 10 * 1024 * 1024) throw new Error('File is larger than 10 MB');
        return { base64: buf.toString('base64') };
      }
    }
  }

  private async onMessage(msg: ServerToWorker) {
    // a user's token that comes with a command is a secret from now on (DISP-63)
    if (msg.t === 'cmd' && 'github' in msg.cmd) this.secrets.add(msg.cmd.github?.token);
    if (msg.t === 'deploy') this.secrets.add(msg.github?.token);
    if ((msg.t === 'start' || msg.t === 'send') && msg.spec.github) this.secrets.add(msg.spec.github.token);
    switch (msg.t) {
      case 'start':
        return this.launch(msg.spec, msg.spec.resume_note ?? msg.spec.prompt, true);
      case 'send':
        return this.launch({ ...msg.spec, resume: msg.spec.resume }, msg.text, false);
      case 'answer':
        return this.runners.get(msg.session_id)?.answer(msg.local_id, msg.answer);
      case 'interrupt':
        this.turnChecks.get(msg.session_id)?.cancel();
        return this.runners.get(msg.session_id)?.interrupt();
      case 'close': {
        this.starting.delete(msg.session_id);
        this.turnChecks.get(msg.session_id)?.cancel();
        this.turnChecks.delete(msg.session_id);
        this.creds.delete(msg.session_id);
        const r = this.runners.get(msg.session_id);
        r?.close();
        this.shared.slots.set(this.slotKey(msg.session_id), false);
        if (msg.cleanup && !this.shared.fake) await this.job(`session ${msg.session_id} is tidied`, () => this.workspaces.cleanup(msg.session_id, msg.repos)).catch((e) => console.warn('cleanup failed', e));
        return;
      }
      case 'rpc_result': {
        const p = this.rpcWaiting.get(msg.req_id);
        if (!p) return;
        this.rpcWaiting.delete(msg.req_id);
        return msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
      }
      case 'cmd':
        try {
          const progress = (data: unknown) => this.send({ t: 'cmd_progress', req_id: msg.req_id, data });
          // the question whether the worker can update now is itself no work
          const data = msg.cmd.c === 'self_update' ? await this.command(msg.cmd) : await this.job(`a command runs (${msg.cmd.c})`, () => this.command(msg.cmd, progress));
          this.send({ t: 'cmd_result', req_id: msg.req_id, ok: true, data });
        } catch (e) {
          this.send({ t: 'cmd_result', req_id: msg.req_id, ok: false, error: (e as Error).message });
        }
        return;
      case 'deploy':
        return this.deploy(msg.session_id, msg.repo, 'github' in msg ? msg.github ?? null : this.creds.get(msg.session_id));
      case 'welcome':
        this.serverVersion = msg.version;
        return;
      case 'server_update':
        return this.serverUpdate(msg);
    }
  }

  private serverUpdating = false;

  /**
   * Update the server with this machine's own command, and say how it ended: over the link when
   * the server is back, so the result also waits in the outbox while it restarts (DISP-112).
   */
  private async serverUpdate(msg: Extract<ServerToWorker, { t: 'server_update' }>) {
    const result = (r: { ok: boolean; rolled_back: boolean; error?: string; log_tail?: string }) =>
      this.send({ t: 'update_result', update_id: msg.update_id, target: 'server', from: msg.prev, to: msg.sha, ...r });
    const command = this.entry.server_update_command;
    if (!command) return result({ ok: false, rolled_back: false, error: `This worker has no command that updates server ${this.entry.name} (server_update_command in its config).` });
    if (this.serverUpdating) return result({ ok: false, rolled_back: false, error: 'This worker already runs an update of the server.' });
    this.serverUpdating = true;
    try {
      const opts = this.shared.serverUpdate ?? { branch: 'main', timeoutMs: 20 * 60_000, healthMs: 5 * 60_000 };
      result(await this.job('the server is updated', () => runServerUpdate({ command, sha: msg.sha, prev: msg.prev, serverVersion: () => this.serverVersion }, opts)));
    } catch (e) {
      result({ ok: false, rolled_back: false, error: (e as Error).message });
    } finally {
      this.serverUpdating = false;
    }
  }

  /** Deploys per repo, one after the other: two merges in a row must not deploy at the same time. */
  private deploys = new Map<number, Promise<void>>();

  /** Run a repo's deploy command and report the result, also after a reconnect (DISP-37). */
  private deploy(sessionId: number, repo: Repo, cred: GithubCred | null | undefined) {
    const result = (r: { ok: boolean; sha: string | null; output: string; duration_ms: number }) =>
      this.send({ t: 'deploy_result', session_id: sessionId, repo_id: repo.id, ...r });
    const go = async () => {
      if (repo.local_path && !insideDirs(repo.local_path, this.entry.local_repo_dirs, '/')) {
        return result({ ok: false, sha: null, output: `${repo.local_path} is outside the folders this worker allows for server ${this.entry.name}`, duration_ms: 0 });
      }
      // the fake runner pushes nothing to GitHub, so only a local repo has a merge to deploy
      if (!repo.deploy_command || (this.shared.fake && !repo.local_path)) return;
      result(await this.workspaces.deploy(repo, cred).catch((e) => ({ ok: false, sha: null, output: (e as Error).message, duration_ms: 0 })));
    };
    const next = this.job(`a deploy of ${repo.github_name} runs`, () => (this.deploys.get(repo.id) ?? Promise.resolve()).then(go));
    this.deploys.set(repo.id, next);
    return next;
  }

  /**
   * Hang up, and take or send nothing until `resume()`: the worker is about to stop for its own
   * update, and what a server sent now would be cut off (DISP-112). What is still said goes to the outbox.
   */
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.epoch++;
    const sock = this.ws;
    this.ws = null;
    this.serverVersion = null;
    sock?.close(1000);
  }

  /** The update did not start after all: connect again. */
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.connect();
  }

  connect(delay = 1000, epoch = this.epoch) {
    if (this.stopped || this.paused || epoch !== this.epoch) return;
    const { url, token, name } = this.entry;
    const sock = new WebSocket(url, { headers: { 'x-worker-token': token }, handshakeTimeout: 30_000 });
    let watchdog: NodeJS.Timeout | undefined;
    const heard = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => sock.terminate(), this.silenceMs);
      watchdog.unref();
    };
    sock.on('ping', heard);
    sock.on('open', async () => {
      if (epoch !== this.epoch) return void sock.close(1000);
      heard();
      delay = 1000;
      console.log(`worker connected to ${url}${name === 'default' ? '' : ` (${name})`}${this.shared.fake ? ' (fake runner)' : ''}`);
      // the link is used only from the hello on: what is said while the facts are gathered goes to
      // the outbox, behind what already waits there (DISP-141)
      const facts = await this.facts();
      if (epoch !== this.epoch) return void sock.close(1000);
      if (sock.readyState !== WebSocket.OPEN) return; // closed meanwhile: its close handler reconnects
      this.ws = sock;
      // the worker's token goes in the connection's header, never in a message: every message is scrubbed
      this.write(sock, { t: 'hello', live: [...this.runners.keys(), ...this.starting.keys()], claude_accounts: facts.claude_accounts, facts });
      for (const m of this.outbox.splice(0)) this.write(sock, m);
    });
    sock.on('message', (data) => {
      heard();
      // a connection that was hung up takes nothing more
      if (this.ws !== sock) return;
      let msg: ServerToWorker;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      this.onMessage(msg).catch((e) => console.error('worker handler failed', msg.t, e));
    });
    sock.on('close', (code, reason) => {
      clearTimeout(watchdog);
      if (this.ws === sock) {
        this.ws = null;
        this.serverVersion = null;
      }
      if (code === 4001) console.error(`server ${name} rejected the worker token`);
      else if (code !== 1000) console.warn(`worker disconnected from ${name} (${code} ${reason}); retrying`);
      setTimeout(() => this.connect(Math.min(delay * 2, 30_000), epoch), delay);
    });
    sock.on('error', () => undefined);
  }

  closeAll() {
    this.stopped = true;
    for (const r of this.runners.values()) r.close();
  }
}
