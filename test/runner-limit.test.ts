// DISP-108: a turn that the usage limit stopped is not a finished turn. The runner waits for the
// reset and sends the session back to work then.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartSpec, WorkerToServer } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';

/** A stand-in for Claude: the first turn fails a tool step and then hits the limit, later turns end well. */
const seen: string[] = [];
let resetsAt = 0;
vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({
  ...(await real<object>()),
  query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
    async function* run() {
      for await (const m of prompt) {
        seen.push(String(m.message.content));
        if (seen.length === 1) {
          yield { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude', content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__dispatch__create_item', input: { title: 'Edit titles in place' } }] } };
          yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'API Error: rate limited' }] } };
          yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' } };
          yield { type: 'assistant', parent_tool_use_id: null, error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 9:30pm" }] } };
          yield { type: 'result', subtype: 'success', is_error: true, total_cost_usd: 11.3, num_turns: 1, duration_ms: 1 };
        } else {
          yield { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude', content: [{ type: 'text', text: 'Created the item.' }] } };
          yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 11.4, num_turns: 1, duration_ms: 1 };
        }
      }
    }
    const it = run();
    return Object.assign(it, { interrupt: async () => undefined, close: () => undefined, setPermissionMode: async () => undefined });
  },
}));

const { ClaudeRunner, LIMIT_RESUME, LIMIT_MARGIN_MS, isLimitHit } = await import('../src/worker/runner.ts');

const spec: StartSpec = {
  session_id: 3, kind: 'planner', project_key: 'EYS', project_name: 'EYS', importance_scale: [], effort_scale: [],
  title: 't', branch: null, repos: [], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS,
  claude_account: null, github_account: null, resume: null, resume_note: null,
};
const opts = { pluginDirs: [], settingSources: [], model: undefined, idleCloseMs: 60_000, assistantModel: 'haiku', discussModel: 'haiku', assistantReadDirs: [] };
const HOUR = 3_600_000;

describe('ClaudeRunner at the usage limit', () => {
  let sent: WorkerToServer[];
  const statuses = () => sent.flatMap((m) => (m.t === 'status' ? [m] : []));
  const start = () => {
    seen.length = 0;
    sent = [];
    resetsAt = Math.floor((Date.now() + HOUR) / 1000);
    const runner = new ClaudeRunner(spec, { emit: (m) => sent.push(m), rpc: async () => undefined, cwd: '/tmp', onClosed: () => undefined }, opts);
    runner.start('plan the item');
    return runner;
  };
  beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => void vi.useRealTimers());

  it('a planner turn with a failed tool step that hits the limit waits, and goes on after the reset', async () => {
    const runner = start();
    await vi.advanceTimersByTimeAsync(10);
    // the failed step is in the chat, and the turn end is not reported as done
    expect(sent).toContainEqual(expect.objectContaining({ t: 'event', body: expect.objectContaining({ kind: 'tool_result', is_error: true }) }));
    expect(statuses().some((m) => m.status === 'idle')).toBe(false);
    expect(statuses().at(-1)).toMatchObject({ status: 'running', limit: { resets_at: new Date(resetsAt * 1000).toISOString() } });
    expect(sent).toContainEqual(expect.objectContaining({ t: 'notice', title: expect.stringContaining('five hour limit reached') }));
    // still waiting just before the reset, also long after the usual idle time
    await vi.advanceTimersByTimeAsync(HOUR - 5000);
    expect(seen).toEqual(['plan the item']);
    expect(statuses().some((m) => m.status === 'idle')).toBe(false);
    // after the reset it is sent back to work, and that clean turn end is the first "idle"
    await vi.advanceTimersByTimeAsync(LIMIT_MARGIN_MS + 10_000);
    expect(seen).toEqual(['plan the item', LIMIT_RESUME]);
    const idle = statuses().filter((m) => m.status === 'idle');
    expect(idle).toHaveLength(1);
    expect(idle[0].unclean).toBeUndefined();
    expect(statuses().at(-2)).toEqual({ t: 'status', session_id: 3, status: 'running' }); // the wait is over
    runner.close();
  });

  it('a message from the owner during the wait tries at once', async () => {
    const runner = start();
    await vi.advanceTimersByTimeAsync(10);
    runner.push('go on now');
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual(['plan the item', 'go on now']);
    expect(statuses().filter((m) => m.status === 'idle')).toHaveLength(1);
    // the old wait does not send its own message later
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(seen).toHaveLength(2);
    runner.close();
  });

  it('an interrupted wait ends the turn as not clean', async () => {
    const runner = start();
    await vi.advanceTimersByTimeAsync(10);
    await runner.interrupt();
    expect(statuses().at(-1)).toMatchObject({ status: 'idle', unclean: expect.stringContaining('usage limit') });
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(seen).toEqual(['plan the item']);
    runner.close();
  });

  it("knows Claude Code's own limit message, with or without the error field", () => {
    expect(isLimitHit({ error: 'rate_limit', message: { content: [] } })).toBe(true);
    expect(isLimitHit({ message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 9:30pm" }] } })).toBe(true);
    expect(isLimitHit({ message: { model: 'claude', content: [{ type: 'text', text: 'You have hit your limit of patience' }] } })).toBe(false);
  });
});
