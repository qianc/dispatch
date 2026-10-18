// One server this worker serves: its connection, its sessions (ids are per server), its workspaces
// and what it may use. The worker's slots are shared by all its links (see Slots).
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import WebSocket from 'ws';
import type { ClaudeAccountInfo } from '../shared/accounts.ts';
import type { RpcMethod, ServerToWorker, StartSpec, WorkerCommand, WorkerToServer } from '../shared/protocol.ts';
import { CHAT_KINDS, type WorkerFacts } from '../shared/types.ts';
import type { ServerEntry } from './config.ts';
import { FakeRunner } from './fakeRunner.ts';
import { ClaudeRunner, insideDirs, type AgentRunner, type RunnerDeps, type RunnerOptions } from './runner.ts';
import { hostedGitBase, run, Workspaces } from './workspace.ts';

/** Agent sessions running on this worker, over all servers. Chats take no slot (as on the server). */
export class Slots {
  readonly max: number;
  private busy = new Set<string>();
  links: ServerLink[] = [];

  constructor(max: number) {
    this.max = max;
  }

  get free() {
    return Math.max(0, this.max - this.busy.size);
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
  workspacesDir: string;
  /** the first server keeps today's layout (WORKSPACES_DIR/sessions/<id>); others get their own folder */
  first: boolean;
  slots: Slots;
  claudeAccounts: () => ClaudeAccountInfo[];
  githubAccounts: string[];
  gitEnv: ConstructorParameters<typeof Workspaces>[2];
  remoteBase: string;
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
  /** messages produced while the server connection is down; flushed on reconnect so nothing is lost */
  private outbox: WorkerToServer[] = [];
  private rpcWaiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private ws: WebSocket | null = null;
  private stopped = false;

  constructor(entry: ServerEntry, shared: LinkShared) {
    this.entry = entry;
    this.shared = shared;
    const root = shared.first ? shared.workspacesDir : join(shared.workspacesDir, 'servers', entry.name);
    // this server's hosted repos are at its own address, with this worker's token for it
    this.workspaces = new Workspaces(root, shared.remoteBase, shared.gitEnv, { base: hostedGitBase(entry.url), token: entry.token });
    // agents get no worker token: they commit, and the worker pushes hosted branches (pushHostedBranches)
    this.opts = { ...shared.opts, assistantReadDirs: entry.read_dirs };
  }

  private slotKey(id: number) {
    return `${this.entry.name}:${id}`;
  }

  /** What this server is told about the worker: only the accounts and folders it may use. */
  facts(): WorkerFacts {
    const claude = this.shared.claudeAccounts().filter((a) => this.allowedClaude(a.name));
    return {
      os: `${process.platform}${process.env.WSL_DISTRO_NAME ? ' (WSL)' : ''}`,
      hostname: hostname(),
      slots: this.shared.slots.max,
      free_slots: this.shared.slots.free,
      claude_accounts: claude,
      github_accounts: this.shared.githubAccounts.filter((a) => this.allowedGithub(a)),
      local_repo_dirs: this.entry.local_repo_dirs,
    };
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
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else if (msg.t !== 'rpc' && msg.t !== 'slots') this.outbox.push(msg); // rpc calls time out on their own and are retried by the agent
  }

  sendSlots() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'slots', free: this.shared.slots.free } satisfies WorkerToServer));
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
    const src = spec.source?.title;
    if (src && isAbsolute(src) && insideDirs(src, this.opts.assistantReadDirs, '/')) dirs.push(dirname(src));
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
    for (const d of dirs) {
      for (const name of ['CLAUDE.md', 'AGENTS.md']) {
        const f = resolve(d, name);
        if (existsSync(f)) context.push({ label: `${name} from ${d}`, text: (await readFile(f, 'utf8')).slice(0, 30_000) });
      }
    }
    const cwd = dirs[0] ?? join(this.workspaces.root, 'assistant');
    await mkdir(cwd, { recursive: true });
    return { dirs: [...dirs, ...extra], context, cwd };
  }

  /** A work session's branches of hosted repos, pushed to the server (the agent has no access itself). */
  async pushHostedBranches(spec: StartSpec) {
    if (!spec.branch) return;
    for (const repo of spec.repos.filter((r) => r.kind === 'hosted')) {
      try {
        await this.workspaces.pushBranch(repo, spec.session_id, spec.branch);
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
    if (!this.allowedClaude(spec.claude_account)) return `This worker does not allow the Claude account "${spec.claude_account ?? 'default'}" for server ${this.entry.name}.`;
    if (spec.github_account && !this.allowedGithub(spec.github_account)) return `This worker does not allow the GitHub account "${spec.github_account}" for server ${this.entry.name}.`;
    const outside = spec.repos.find((r) => r.local_path && !insideDirs(r.local_path, this.entry.local_repo_dirs, '/'));
    if (outside) return `${outside.local_path} is outside the folders this worker allows for server ${this.entry.name}.`;
    return null;
  }

  async launch(spec: StartSpec, text: string, isStart: boolean) {
    // spec and text may be adjusted below (attached worktrees, setup notes)
    const id = spec.session_id;
    this.kinds.set(id, spec.kind);
    const live = this.runners.get(id);
    if (live) {
      if (!this.shared.fake) await this.fetchHosted(spec);
      return live.push(text);
    }
    const waiting = this.starting.get(id);
    if (waiting) return void waiting.push(text); // still preparing: deliver after start
    const refused = this.refusal(spec);
    if (refused) return this.send({ t: 'status', session_id: id, status: 'failed', error: refused });
    // the worker owns its slots: a new agent session waits when they are all taken (by any server)
    if (isStart && !CHAT_KINDS.includes(spec.kind) && !this.shared.slots.has(this.slotKey(id)) && this.shared.slots.free <= 0) {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'refused', session_id: id, reason: 'busy' } satisfies WorkerToServer));
      return;
    }
    this.starting.set(id, []);
    // the slot is taken from the moment the start is accepted: setup (clone, npm ci) can take minutes
    const holdsSlot = isStart && !CHAT_KINDS.includes(spec.kind);
    if (holdsSlot) this.shared.slots.set(this.slotKey(id), true);
    try {
      let cwd: string;
      let extra: Pick<RunnerDeps, 'readDirs' | 'context'> = {};
      // the fake runner cannot clone GitHub repos, but local ones are real git (as for work sessions)
      if (spec.kind === 'discuss' && (!this.shared.fake || spec.repos.every((r) => r.local_path))) {
        const c = await this.discussContext(spec);
        cwd = c.cwd;
        extra = { readDirs: c.dirs, context: c.context };
      } else if (this.shared.fake) cwd = process.cwd();
      else if (spec.kind === 'assistant') {
        // the assistant reads only allow-listed folders; give it an empty working dir
        cwd = join(this.workspaces.root, 'assistant');
        await mkdir(cwd, { recursive: true });
      } else {
        const created: { repo: StartSpec['repos'][number]; wt: string }[] = [];
        cwd = await this.workspaces.prepare(spec, created);
        // the prompt needs to know which worktrees live in the owner's repo (no push needed there)
        spec = { ...spec, repos: spec.repos.map((r) => ({ ...r, attached: Workspaces.isAttached(this.workspaces.repoDir(spec.session_id, r), r) })) };
        // per-repo setup for new worktrees (venv, npm ci, ...), before the agent starts
        for (const { repo, wt } of created.filter((c) => c.repo.setup_command)) {
          this.send({ t: 'event', session_id: id, body: { kind: 'system', text: `Setting up ${repo.github_name}: ${repo.setup_command}` } });
          const res = await this.workspaces.setup(repo, wt);
          this.send({ t: 'event', session_id: id, body: { kind: res.ok ? 'system' : 'error', text: res.ok ? `Setup of ${repo.github_name} done.` : `Setup of ${repo.github_name} failed:\n${res.output}` } });
          if (!res.ok) text = `Note from Dispatch: the worktree setup command \`${repo.setup_command}\` failed in ${repo.github_name}. Its output:\n\n${res.output}\n\nFix the environment first if your work needs it.\n\n${text}`;
        }
      }
      const hostedWork = spec.kind === 'work' && !!spec.branch && spec.repos.some((r) => r.kind === 'hosted') && !this.shared.fake;
      const deps: RunnerDeps = {
        // a finished turn of work on a hosted repo: push its branch first, so the server sees it
        emit: (m) => {
          if (hostedWork && m.t === 'status' && m.status === 'idle') void this.pushHostedBranches(spec).finally(() => this.send(m));
          else this.send(m);
        },
        rpc: this.rpcFor(id),
        cwd,
        onClosed: () => {
          if (this.runners.get(id) === runner) this.runners.delete(id);
          this.shared.slots.set(this.slotKey(id), false);
        },
        ...extra,
      };
      const runner: AgentRunner = this.shared.fake ? new FakeRunner(spec, deps) : new ClaudeRunner(spec, deps, this.opts);
      const queued = this.starting.get(id) ?? [];
      this.starting.delete(id);
      this.runners.set(id, runner);
      runner.start(text);
      for (const t of queued) runner.push(t);
    } catch (e) {
      this.starting.delete(id);
      if (holdsSlot) this.shared.slots.set(this.slotKey(id), false);
      console.error(`[${this.entry.name}] session ${id} failed to start`, e);
      this.send({ t: 'status', session_id: id, status: 'failed', error: `Could not start: ${(e as Error).message}` });
    }
  }

  async command(cmd: WorkerCommand): Promise<unknown> {
    const ws = this.workspaces;
    // the fake runner still does real git for files and local repos; it only skips GitHub pushes/merges
    const local = 'repo' in cmd && !!cmd.repo?.local_path;
    // every local folder a command touches must be on this server's list (tidy and leftovers carry several)
    const folders = [...('repo' in cmd && cmd.repo ? [cmd.repo] : []), ...('repos' in cmd ? cmd.repos : [])].flatMap((r) => (r.local_path ? [r.local_path] : []));
    const outside = folders.find((f) => !insideDirs(f, this.entry.local_repo_dirs, '/'));
    if (outside) throw new Error(`${outside} is outside the folders this worker allows for server ${this.entry.name}`);
    // leftovers / tidy only look at real folders, so they run in fake mode too
    if (this.shared.fake && !local && !['read_file', 'inspect_local_repo', 'leftovers', 'tidy'].includes(cmd.c)) return { ok: true };
    switch (cmd.c) {
      case 'leftovers':
        return ws.leftovers(cmd.session_id, cmd.repos, cmd.branch, cmd.merged_repo_ids);
      case 'tidy':
        return ws.tidy(cmd.session_id, cmd.repos, cmd.branch, { deleteMerged: cmd.delete_merged, force: cmd.force, mergedHint: cmd.merged_repo_ids });
      case 'push_branch':
        await ws.pushBranch(cmd.repo, cmd.session_id, cmd.branch);
        return { ok: true };
      case 'merge_local':
        return ws.mergeLocal(cmd.repo, cmd.branch, cmd.message);
      case 'branch_status':
        return ws.branchStatus(cmd.repo, cmd.branch);
      case 'branch_diff':
        return ws.branchDiff(cmd.repo, cmd.branch);
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
        return { path: top.out.trim(), name: top.out.trim().split('/').pop(), default_branch: branch.trim(), receive_deny_current_branch: deny };
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
    switch (msg.t) {
      case 'start':
        return this.launch(msg.spec, msg.spec.resume_note ?? msg.spec.prompt, true);
      case 'send':
        return this.launch({ ...msg.spec, resume: msg.spec.resume }, msg.text, false);
      case 'answer':
        return this.runners.get(msg.session_id)?.answer(msg.local_id, msg.answer);
      case 'interrupt':
        return this.runners.get(msg.session_id)?.interrupt();
      case 'close': {
        this.starting.delete(msg.session_id);
        const r = this.runners.get(msg.session_id);
        r?.close();
        this.shared.slots.set(this.slotKey(msg.session_id), false);
        if (msg.cleanup && !this.shared.fake) await this.workspaces.cleanup(msg.session_id, msg.repos).catch((e) => console.warn('cleanup failed', e));
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
          this.send({ t: 'cmd_result', req_id: msg.req_id, ok: true, data: await this.command(msg.cmd) });
        } catch (e) {
          this.send({ t: 'cmd_result', req_id: msg.req_id, ok: false, error: (e as Error).message });
        }
        return;
    }
  }

  connect(delay = 1000) {
    if (this.stopped) return;
    const { url, token, name } = this.entry;
    const sock = new WebSocket(url, { headers: { 'x-worker-token': token } });
    sock.on('open', () => {
      this.ws = sock;
      delay = 1000;
      console.log(`worker connected to ${url}${name === 'default' ? '' : ` (${name})`}${this.shared.fake ? ' (fake runner)' : ''}`);
      const facts = this.facts();
      sock.send(JSON.stringify({ t: 'hello', live: [...this.runners.keys(), ...this.starting.keys()], claude_accounts: facts.claude_accounts, facts } satisfies WorkerToServer));
      for (const m of this.outbox.splice(0)) sock.send(JSON.stringify(m));
    });
    sock.on('message', (data) => {
      let msg: ServerToWorker;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      this.onMessage(msg).catch((e) => console.error('worker handler failed', msg.t, e));
    });
    sock.on('close', (code, reason) => {
      if (this.ws === sock) this.ws = null;
      if (code === 4001) console.error(`server ${name} rejected the worker token`);
      else if (code !== 1000) console.warn(`worker disconnected from ${name} (${code} ${reason}); retrying`);
      setTimeout(() => this.connect(Math.min(delay * 2, 30_000)), delay);
    });
    sock.on('error', () => undefined);
  }

  closeAll() {
    this.stopped = true;
    for (const r of this.runners.values()) r.close();
  }
}
