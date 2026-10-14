// One live Claude Code session, driven through the Agent SDK with streaming input.
import { randomUUID } from 'node:crypto';
import { query, type CanUseTool, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StartSpec, WorkerToServer } from '../shared/protocol.ts';
import type { InputAnswer, PendingInputPayload, Question, SessionEventBody } from '../shared/types.ts';
import { dispatchMcp, type Rpc } from './mcp.ts';
import { assistantPrompt, discussPrompt, plannerPrompt, workPrompt } from './prompts.ts';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
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
  /** Folders the assistant may read (absolute, ~ expanded). */
  assistantReadDirs: string[];
}

export function expandDirs(list: string): string[] {
  return list.split(':').filter(Boolean).map((d) => resolve(d.replace(/^~(?=$|\/)/, homedir())));
}

/** True if `path` (after resolving symlinks) is inside one of `dirs`. */
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
        stderr: (d) => process.stderr.write(`[session ${this.sessionId}] ${d}`),
      },
    });
    void this.loop();
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

  private event(body: SessionEventBody) {
    this.deps.emit({ t: 'event', session_id: this.sessionId, body });
  }

  private async loop() {
    try {
      for await (const m of this.q!) this.handle(m);
      if (!this.closed) this.close();
    } catch (e) {
      if (this.closed) return;
      this.deps.emit({ t: 'status', session_id: this.sessionId, status: 'failed', error: (e as Error).message });
      this.close();
    }
  }

  private handle(m: SDKMessage) {
    if (m.type === 'system' && m.subtype === 'init') {
      if (this.sentSdkId !== m.session_id) {
        this.sentSdkId = m.session_id;
        this.deps.emit({ t: 'status', session_id: this.sessionId, status: 'running', sdk_session_id: m.session_id });
      }
      return;
    }
    if (m.type === 'assistant') {
      if (this.betweenTurns) {
        this.betweenTurns = false;
        this.deps.emit({ t: 'status', session_id: this.sessionId, status: 'running' });
      }
      if (m.parent_tool_use_id) return; // subagent internals stay out of the transcript
      for (const c of m.message.content) {
        if (c.type === 'text' && c.text.trim()) this.event({ kind: 'assistant', text: c.text });
        if (c.type === 'tool_use') {
          const input = (c.input ?? {}) as Record<string, unknown>;
          this.event({ kind: 'tool_use', tool_use_id: c.id, name: c.name, summary: summarizeToolInput(c.name, input), input: c.name === 'Write' ? { file_path: input.file_path } : input });
        }
      }
      return;
    }
    if (m.type === 'user' && !m.parent_tool_use_id && Array.isArray(m.message.content)) {
      for (const c of m.message.content) {
        if (typeof c === 'object' && c.type === 'tool_result') {
          this.event({ kind: 'tool_result', tool_use_id: c.tool_use_id, is_error: !!c.is_error, text: toolResultText(c.content).slice(0, MAX_TOOL_TEXT) });
        }
      }
      return;
    }
    if (m.type === 'result') {
      this.event({ kind: 'result', subtype: m.subtype, cost_usd: m.total_cost_usd, turns: m.num_turns, duration_ms: m.duration_ms });
      if (m.subtype !== 'success' && 'errors' in m && Array.isArray(m.errors) && m.errors.length) {
        this.event({ kind: 'error', text: m.errors.join('\n') });
      }
      this.deps.emit({ t: 'status', session_id: this.sessionId, status: 'idle' });
      this.betweenTurns = true;
      this.armIdle();
    }
  }

  private armIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.close(), this.opts.idleCloseMs);
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
