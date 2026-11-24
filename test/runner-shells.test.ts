// DISP-239 #29: a background shell that never ends (`npm run dev`) does not keep the session running for good.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartSpec, WorkerToServer } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';

/** the background tasks Claude reports after each turn's tool calls */
let tasks: { task_id: string; task_type: string; description: string }[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({
  ...(await real<object>()),
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    async function* run() {
      for await (const _ of prompt) {
        yield { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude', content: [{ type: 'text', text: 'Started the dev server.' }] } };
        yield { type: 'system', subtype: 'background_tasks_changed', tasks };
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, duration_ms: 1 };
      }
    }
    return Object.assign(run(), { interrupt: async () => undefined, close: () => undefined, setPermissionMode: async () => undefined });
  },
}));

const { ClaudeRunner, SHELL_IDLE_MS } = await import('../src/worker/runner.ts');

const spec: StartSpec = {
  session_id: 4, kind: 'work', project_key: 'WEB', project_name: 'Web', importance_scale: [], effort_scale: [],
  title: 't', branch: null, repos: [], items: [], source: null, prompt: '', force_plan: false, options: { ...DEFAULT_RUN_OPTIONS, model: 'opus' },
  claude_account: null, github_account: null, resume: null, resume_note: null,
};
const opts = { pluginDirs: [], settingSources: [], idleCloseMs: 60_000, assistantModel: 'haiku', discussModel: 'haiku', assistantReadDirs: [] };

describe('ClaudeRunner with background tasks left after its turn', () => {
  let sent: WorkerToServer[];
  const statuses = () => sent.flatMap((m) => (m.t === 'status' ? [m.status] : []));
  const start = () => {
    sent = [];
    const runner = new ClaudeRunner(spec, { emit: (m) => sent.push(m), rpc: async () => undefined, cwd: '/tmp', onClosed: () => undefined }, opts);
    runner.start('run it');
    return runner;
  };
  beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => void vi.useRealTimers());

  it('only shells left: after a while the turn is reported done, with a note, and nothing blocks an update', async () => {
    tasks = [{ task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' }];
    const runner = start();
    await vi.advanceTimersByTimeAsync(10);
    expect(statuses()).not.toContain('idle');
    expect(runner.activity()).toBe('has background tasks running');
    // DISP-253: a long test run the agent waits for is not done after minutes
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(statuses()).not.toContain('idle');
    await vi.advanceTimersByTimeAsync(SHELL_IDLE_MS - 60 * 60_000);
    expect(statuses().at(-1)).toBe('idle');
    expect(sent).toContainEqual(expect.objectContaining({ t: 'event', body: expect.objectContaining({ kind: 'system', text: expect.stringMatching(/turn counts as done: only a background command runs \(npm run dev\)/) }) }));
    expect(runner.activity()).toBeNull();
    runner.close();
  });

  it('a subagent still works: the session stays running', async () => {
    tasks = [{ task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' }, { task_id: 'a1', task_type: 'local_agent', description: 'review' }];
    const runner = start();
    await vi.advanceTimersByTimeAsync(SHELL_IDLE_MS + 10);
    expect(statuses()).not.toContain('idle');
    expect(runner.activity()).toBe('has background tasks running');
    runner.close();
  });
});
