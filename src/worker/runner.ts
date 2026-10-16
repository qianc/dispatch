// One live Claude Code session, driven through the Agent SDK with streaming input.
import { randomUUID } from 'node:crypto';
import { query, type CanUseTool, type HookCallback, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StartSpec, WorkerToServer } from '../shared/protocol.ts';
import type { InputAnswer, PendingInputPayload, Question, SessionEventBody } from '../shared/types.ts';
import { dispatchMcp, type Rpc } from './mcp.ts';
import { assistantPrompt, discussPrompt, plannerPrompt, workPrompt } from './prompts.ts';
import { existsSync, globSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export interface RunnerDeps {
  emit(msg: WorkerToServer): void;
  rpc: Rpc;
  cwd: string;
  onClosed(): void;
  /** discuss chats: folders it may read, and CLAUDE.md-style context to put in its prompt */
  readDirs?: string[];
  context?: { label: string; text: string }[];
}

export interface AgentRunner {
  readonly sessionId: number;
  start(text: string): void;
  push(text: string): void;
  answer(localId: string, answer: InputAnswer): void;
  interrupt(): Promise<void>;
  close(): void;
}

export interface RunnerOptions {
  pluginDirs: string[];
  settingSources: ('user' | 'project' | 'local')[];
  model: string | undefined;
  idleCloseMs: number;
  assistantModel: string;
  discussModel: string;
  /** environment for a session's Claude process (its Claude account, its project's GitHub account) */
  sessionEnv?: (spec: StartSpec) => Record<string, string | undefined>;
  accountLabel?: (name: string | null) => string;
  /** how to fix a login for an account (shown in the notice) */
  loginHint?: (name: string | null) => string;
  /** Folders the assistant may read (absolute, ~ expanded). */
  assistantReadDirs: string[];
}

export function expandDirs(list: string): string[] {
  return list.split(':').filter(Boolean).map((d) => resolve(d.replace(/^~(?=$|\/)/, homedir())));
}

/** True if `path` (after resolving symlinks) is inside one of `dirs`. */
/**
 * Discuss: the owner often names a file relative to an extra reference folder ("cvdd/renders/x.png"),
 * or relative to the repo root, and the model then looks for it in its own checkout. If the path
 * does not exist there, find the same path under an extra folder (or under one of its parents,
 * as long as the result stays inside that folder). Returns the path to read, or null.
 */
export function rescuePath(path: string, cwd: string, extraDirs: string[]): string | null {
  if (!path || !extraDirs.length) return null;
  const asked = resolve(cwd, path);
  if (existsSync(asked)) return null;
  const rel = isAbsolute(path) ? (asked.startsWith(cwd + sep) ? relative(cwd, asked) : null) : path;
  if (!rel || rel.split(/[\\/]/).includes('..')) return null;
  for (const dir of extraDirs) {
    for (let base = dir, up = 0; up < 4; base = dirname(base), up++) {
      const candidate = join(base, rel);
      if (existsSync(candidate) && insideDirs(candidate, [dir], '/')) return candidate;
      if (dirname(base) === base) break;
    }
  }
  return null;
}

/** Glob: if the pattern finds nothing where the model searched, search the extra folders. */
export function rescueGlob(pattern: string, path: string | undefined, cwd: string, extraDirs: string[]): string | null {
  if (!pattern || !extraDirs.length) return null;
  const where = resolve(cwd, path || '.');
  if (extraDirs.some((d) => insideDirs(where, [d], '/'))) return null; // already searching one
  const finds = (dir: string) => {
    try {
      return globSync(pattern, { cwd: dir }).some((f) => insideDirs(join(dir, f), [dir], '/'));
    } catch {
      return false;
    }
  };
  if (existsSync(where) && finds(where)) return null;
  return extraDirs.find((d) => existsSync(d) && finds(d)) ?? null;
}

/**
 * Discuss: a PreToolUse hook that sends Read and Glob to the extra folders when the path or pattern
 * is not in the checkout. A hook, not canUseTool: reads inside the working folder never ask for
 * permission, so canUseTool does not see them.
 */
export function discussPathHook(cwd: string, extraDirs: string[]): HookCallback {
  return async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return {};
    const input = (hookInput.tool_input ?? {}) as Record<string, unknown>;
    let updated: Record<string, unknown> | null = null;
    if (hookInput.tool_name === 'Read') {
      const found = rescuePath(String(input.file_path ?? ''), cwd, extraDirs);
      if (found) updated = { ...input, file_path: found };
    } else if (hookInput.tool_name === 'Glob') {
      const dir = rescueGlob(String(input.pattern ?? ''), input.path ? String(input.path) : undefined, cwd, extraDirs);
      if (dir) updated = { ...input, path: dir };
    }
    if (!updated) return {};
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Found in an extra readable folder', updatedInput: updated } };
  };
}

export function insideDirs(path: string, dirs: string[], cwd: string): boolean {
  let real: string;
  try {
    real = realpathSync(resolve(cwd, path.replace(/^~(?=$|\/)/, homedir())));
  } catch {
    real = resolve(cwd, path);
  }
  return dirs.some((d) => {
    let root = d;
    try { root = realpathSync(d); } catch { /* keep as given */ }
    return real === root || real.startsWith(root + sep);
  });
}

const ASSISTANT_TOOLS = ['Read', 'Glob', 'Grep'];

const PLANNER_TOOLS_DENIED = ['Write', 'Edit', 'NotebookEdit', 'Bash', 'KillShell'];
const MAX_TOOL_TEXT = 4000;

/** Async iterable of user messages that we can push into while the query runs. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private done = false;

  push(text: string) {
    this.items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' } as SDKUserMessage);
    this.wake?.();
  }

  end() {
    this.done = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

export function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => String(v ?? '');
  switch (name) {
    case 'Bash': return s(input.command).split('\n')[0].slice(0, 160);
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return s(input.file_path);
    case 'Grep': return `${s(input.pattern)}${input.path ? ` in ${s(input.path)}` : ''}`;
    case 'Glob': return s(input.pattern);
    case 'WebFetch': return s(input.url);
    case 'WebSearch': return s(input.query);
    case 'Task': case 'Agent': return s(input.description);
    case 'Skill': return s(input.skill ?? input.command);
    case 'TodoWrite': return `${(input.todos as unknown[] | undefined)?.length ?? 0} todos`;
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string');
      return first ? s(first).slice(0, 120) : '';
    }
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : '')).join('\n');
  return '';
}

const MAX_IMAGE_B64 = 14_000_000; // ~10 MB decoded

/** Assistant-message errors that mean the account itself needs the owner (log in, org, billing). */
export const LOGIN_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'cloud_credential_error']);

export function rateLimitNotice(label: string, info: { status: string; resetsAt?: number; rateLimitType?: string; utilization?: number }) {
  const when = info.resetsAt ? new Date(info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1)).toLocaleString('sv-SE', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : null;
  const kind = info.rateLimitType ? info.rateLimitType.replace(/_/g, ' ') : 'usage';
  return info.status === 'rejected'
    ? { title: `${label}: ${kind} limit reached`, body: `The session waits until the limit resets${when ? ` (${when})` : ''}. To continue sooner, start the remaining work as a new batch on another allowed Claude account.` }
    : { title: `${label}: close to the ${kind} limit`, body: `${info.utilization ? `${Math.round(info.utilization * 100)}% used. ` : ''}${when ? `Resets ${when}.` : ''}` };
}

/** Base64 images in a tool result (Read of a png/jpg returns one), so the owner can see them too. */
export function toolResultImages(content: unknown): { media_type: string; data: string }[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((c) => {
    const src = c && typeof c === 'object' && c.type === 'image' ? (c as { source?: { type?: string; media_type?: string; data?: string } }).source : undefined;
    return src?.type === 'base64' && src.data && src.media_type && src.data.length <= MAX_IMAGE_B64 ? [{ media_type: src.media_type, data: src.data }] : [];
  });
}

export class ClaudeRunner implements AgentRunner {
  readonly sessionId: number;
  private spec: StartSpec;
  private deps: RunnerDeps;
  private opts: RunnerOptions;
  private input = new InputQueue();
  private q: Query | null = null;
  private waiting = new Map<string, (a: InputAnswer | null) => void>();
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private sentSdkId: string | null = null;
  /** Set after a turn result; the next model output means a new turn started (e.g. a queued message). */
  private betweenTurns = false;
  /** Live background tasks (shell, subagents) that are real work; the turn can end while they run. */
  private bgTasks = 0;
  /** A ScheduleWakeup the agent set: keep the process alive until then. */
  private wakeAt = 0;
  private bgIdleTimer: NodeJS.Timeout | null = null;

  constructor(spec: StartSpec, deps: RunnerDeps, opts: RunnerOptions) {
    this.sessionId = spec.session_id;
    this.spec = spec;
    this.deps = deps;
    this.opts = opts;
  }

  start(text: string) {
    this.input.push(text);
    const planner = this.spec.kind === 'planner';
    const assistant = this.spec.kind === 'assistant';
    const discuss = this.spec.kind === 'discuss';
    const chat = assistant || discuss;
    const append = assistant ? assistantPrompt(this.opts.assistantReadDirs)
      : discuss ? discussPrompt(this.spec, this.deps.context ?? [])
      : planner ? plannerPrompt(this.spec) : workPrompt(this.spec);
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.deps.cwd,
        resume: this.spec.resume ?? undefined,
        model: assistant ? this.opts.assistantModel : discuss ? this.opts.discussModel
          : this.spec.options.model !== 'default' ? this.spec.options.model : this.opts.model,
        ...(this.spec.options.effort !== 'default' && !chat ? { effort: this.spec.options.effort } : {}),
        // chats are small helpers: no project settings or hooks, no plugins, only read tools
        settingSources: chat ? [] : this.opts.settingSources,
        plugins: chat ? [] : this.opts.pluginDirs.map((path) => ({ type: 'local' as const, path })),
        ...(chat ? { tools: ASSISTANT_TOOLS } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code', append },
        permissionMode: this.spec.force_plan && !this.spec.resume ? 'plan' : 'default',
        disallowedTools: planner ? PLANNER_TOOLS_DENIED : this.spec.options.subagents === 'none' && !chat ? ['Task', 'Agent'] : [],
        mcpServers: { dispatch: dispatchMcp(this.spec.kind, this.deps.rpc, (p) => this.readAllowed(p)) },
        canUseTool: this.canUseTool,
        ...(discuss ? { hooks: { PreToolUse: [{ matcher: 'Read|Glob', hooks: [discussPathHook(this.deps.cwd, this.extraDirs())] }] } } : {}),
        ...(this.opts.sessionEnv ? { env: this.opts.sessionEnv(this.spec) } : {}),
        stderr: (d) => process.stderr.write(`[session ${this.sessionId}] ${d}`),
      },
    });
    void this.loop();
  }

  /** Discuss: the readable folders that are not the checkout itself (the repo's extra folders). */
  private extraDirs() {
    const cwd = this.deps.cwd;
    return (this.deps.readDirs ?? []).filter((d) => !insideDirs(cwd, [d], '/') && !insideDirs(d, [cwd], '/'));
  }

  private readDirs() {
    return this.spec.kind === 'discuss' ? this.deps.readDirs ?? [] : this.opts.assistantReadDirs;
  }

  /** File reads for chat tools, limited to the chat's folders. */
  private async readAllowed(path: string): Promise<string> {
    if (!insideDirs(path, this.readDirs(), this.deps.cwd)) {
      throw new Error(`Reading ${path} is not allowed. Allowed folders: ${this.readDirs().join(', ') || 'none'}.`);
    }
    return readFile(resolve(this.deps.cwd, path.replace(/^~(?=$|\/)/, homedir())), 'utf8');
  }

  push(text: string) {
    this.clearIdle();
    this.betweenTurns = false; // the server already marked the session running for this message
    this.input.push(text);
  }

  answer(localId: string, answer: InputAnswer) {
    const resolve = this.waiting.get(localId);
    if (!resolve) return;
    this.waiting.delete(localId);
    resolve(answer);
  }

  async interrupt() {
    for (const resolve of this.waiting.values()) resolve(null);
    this.waiting.clear();
    await this.q?.interrupt().catch(() => undefined);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    for (const resolve of this.waiting.values()) resolve(null);
    this.waiting.clear();
    this.input.end();
    this.q?.close();
    this.deps.onClosed();
  }

  private canUseTool: CanUseTool = async (name, input, { signal }) => {
    if ((this.spec.kind === 'assistant' || this.spec.kind === 'discuss') && ASSISTANT_TOOLS.includes(name)) {
      const dirs = this.readDirs();
      const path = String(input.file_path ?? input.path ?? '');
      if ((path || this.spec.kind === 'discuss') && !insideDirs(path || this.deps.cwd, dirs, this.deps.cwd)) {
        const allowed = dirs.join(', ') || 'none';
        return { behavior: 'deny', message: `Reading ${path} is not allowed. Allowed folders: ${allowed}.` };
      }
      return { behavior: 'allow', updatedInput: input };
    }
    if (name !== 'AskUserQuestion' && name !== 'ExitPlanMode') return { behavior: 'allow', updatedInput: input };
    const payload: PendingInputPayload = name === 'AskUserQuestion'
      ? { kind: 'question', questions: (input.questions as Question[]).map((q) => ({ ...q, multiSelect: !!q.multiSelect })) }
      : { kind: 'plan_approval', plan: String(input.plan ?? '') };
    const localId = randomUUID();
    const answer = await new Promise<InputAnswer | null>((resolve) => {
      this.waiting.set(localId, resolve);
      signal.addEventListener('abort', () => resolve(null), { once: true });
      this.deps.emit({ t: 'input_request', session_id: this.sessionId, local_id: localId, payload });
    });
    this.waiting.delete(localId);
    if (!answer) return { behavior: 'deny', message: 'The question was cancelled.', interrupt: true };
    if (answer.kind === 'question') return { behavior: 'allow', updatedInput: { ...input, answers: answer.answers } };
    if (answer.approve) {
      void this.q?.setPermissionMode('default').catch(() => undefined);
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: `The owner did not approve the plan.${answer.feedback ? ` Feedback: ${answer.feedback}` : ''}` };
  };

  private noticed = new Set<string>();

  /** Tell the owner once per kind: shown in the session and sent as a push. */
  private noticeOnce(key: string, n: { title: string; body: string }) {
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    this.deps.emit({ t: 'notice', session_id: this.sessionId, ...n });
  }

  private event(body: SessionEventBody) {
    this.deps.emit({ t: 'event', session_id: this.sessionId, body });
  }

  private async loop() {
    try {
      for await (const m of this.q!) this.handle(m);
      if (!this.closed) {
        // the Claude process ended without being asked to (crash, kill): say so, or the session
        // would show "running" forever with nothing behind it
        this.deps.emit({
          t: 'status', session_id: this.sessionId, status: 'failed',
          error: 'The Claude process stopped unexpectedly. Your work in the worktree is kept; send a message to resume where it stopped.',
        });
        this.close();
      }
    } catch (e) {
      if (this.closed) return;
      this.deps.emit({ t: 'status', session_id: this.sessionId, status: 'failed', error: (e as Error).message });
      this.close();
    }
  }

  private handle(m: SDKMessage) {
    if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
      const before = this.bgTasks;
      this.bgTasks = m.tasks.filter((t) => !t.ambient).length;
      if (this.betweenTurns && before > 0 && this.bgTasks === 0) {
        // tasks done; Claude normally starts a new turn on their notification. If it does not, it is idle.
        if (this.bgIdleTimer) clearTimeout(this.bgIdleTimer);
        this.bgIdleTimer = setTimeout(() => {
          if (this.betweenTurns && this.bgTasks === 0) {
            this.deps.emit({ t: 'status', session_id: this.sessionId, status: 'idle' });
            this.armIdle();
          }
        }, 30_000);
      }
      return;
    }
    if (m.type === 'system' && m.subtype === 'init') {
      if (this.sentSdkId !== m.session_id) {
        this.sentSdkId = m.session_id;
        this.deps.emit({ t: 'status', session_id: this.sessionId, status: 'running', sdk_session_id: m.session_id });
      }
      return;
    }
    if (m.type === 'rate_limit_event') {
      const info = m.rate_limit_info;
      if (info.status !== 'allowed') this.noticeOnce(`rate-${info.status}-${info.rateLimitType ?? ''}`, rateLimitNotice(this.opts.accountLabel?.(this.spec.claude_account) ?? 'Claude', info));
      return;
    }
    if (m.type === 'assistant') {
      if (m.error && LOGIN_ERRORS.has(m.error)) {
        const label = this.opts.accountLabel?.(this.spec.claude_account) ?? 'Claude';
        this.noticeOnce(`login-${m.error}`, {
          title: `${label} account needs attention (${m.error.replace(/_/g, ' ')})`,
          body: this.opts.loginHint?.(this.spec.claude_account) ?? 'Log in again on the worker machine.',
        });
      }
      if (this.bgIdleTimer) clearTimeout(this.bgIdleTimer);
      if (this.betweenTurns) {
        this.betweenTurns = false;
        this.deps.emit({ t: 'status', session_id: this.sessionId, status: 'running' });
      }
      if (m.parent_tool_use_id) return; // subagent internals stay out of the transcript
      for (const c of m.message.content) {
        if (c.type === 'text' && c.text.trim()) this.event({ kind: 'assistant', text: c.text });
        if (c.type === 'tool_use') {
          const input = (c.input ?? {}) as Record<string, unknown>;
          if (c.name === 'ScheduleWakeup' && typeof input.delaySeconds === 'number') this.wakeAt = Date.now() + input.delaySeconds * 1000;
          this.event({ kind: 'tool_use', tool_use_id: c.id, name: c.name, summary: summarizeToolInput(c.name, input), input: c.name === 'Write' ? { file_path: input.file_path } : input });
        }
      }
      return;
    }
    if (m.type === 'user' && !m.parent_tool_use_id && Array.isArray(m.message.content)) {
      for (const c of m.message.content) {
        if (typeof c === 'object' && c.type === 'tool_result') {
          const body: SessionEventBody = { kind: 'tool_result', tool_use_id: c.tool_use_id, is_error: !!c.is_error, text: toolResultText(c.content).slice(0, MAX_TOOL_TEXT) };
          const images = toolResultImages(c.content);
          this.deps.emit({ t: 'event', session_id: this.sessionId, body, ...(images.length ? { images } : {}) });
        }
      }
      return;
    }
    if (m.type === 'result') {
      this.event({ kind: 'result', subtype: m.subtype, cost_usd: m.total_cost_usd, turns: m.num_turns, duration_ms: m.duration_ms });
      if (m.subtype !== 'success' && 'errors' in m && Array.isArray(m.errors) && m.errors.length) {
        this.event({ kind: 'error', text: m.errors.join('\n') });
      }
      this.betweenTurns = true;
      if (this.bgTasks > 0) {
        // the turn ended but work goes on in the background: not the owner's turn yet, and never idle-close
        this.event({ kind: 'system', text: `Waiting for ${this.bgTasks} background task${this.bgTasks === 1 ? '' : 's'} to finish.` });
        this.deps.emit({ t: 'status', session_id: this.sessionId, status: 'running' });
        return;
      }
      this.deps.emit({ t: 'status', session_id: this.sessionId, status: 'idle' });
      this.armIdle();
    }
  }

  private armIdle() {
    this.clearIdle();
    const until = Math.max(this.opts.idleCloseMs, this.wakeAt ? this.wakeAt - Date.now() + 60_000 : 0);
    this.idleTimer = setTimeout(() => {
      // never close under running background work or before a scheduled wakeup
      if (this.bgTasks > 0 || this.wakeAt > Date.now()) return this.armIdle();
      this.close();
    }, until);
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
