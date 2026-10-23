// DISP-15: the runner reports a work turn done only after its check; a failed check is the next turn.
import { describe, expect, it, vi } from 'vitest';
import type { StartSpec, WorkerToServer } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';

/** A stand-in for Claude: one result per user message, recording what it was sent. */
const seen: string[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({
  ...(await real<object>()),
  query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
    async function* run() {
      for await (const m of prompt) {
        seen.push(String(m.message.content));
        yield { type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 1, duration_ms: 1 };
      }
    }
    const it = run();
    return Object.assign(it, { interrupt: async () => undefined, close: () => undefined, setPermissionMode: async () => undefined });
  },
}));

const { ClaudeRunner } = await import('../src/worker/runner.ts');

const spec: StartSpec = {
  session_id: 3, kind: 'work', project_key: 'HC', project_name: 'HC', importance_scale: [], effort_scale: [],
  title: 't', branch: 'b', repos: [], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS,
  claude_account: null, github_account: null, resume: null, resume_note: null,
};
const opts = { pluginDirs: [], settingSources: [], model: undefined, idleCloseMs: 60_000, assistantModel: 'haiku', discussModel: 'haiku', assistantReadDirs: [] };

describe('ClaudeRunner before idle', () => {
  it('sends the failed check as the next turn, and reports idle once it passes', async () => {
    const sent: WorkerToServer[] = [];
    const answers = ['the check failed: fix it', null];
    const beforeIdle = vi.fn(async () => answers.shift() ?? null);
    const runner = new ClaudeRunner(spec, { emit: (m) => sent.push(m), rpc: async () => undefined, cwd: '/tmp', onClosed: () => undefined, beforeIdle }, opts);
    runner.start('do the work');
    await vi.waitFor(() => expect(sent.some((m) => m.t === 'status' && m.status === 'idle')).toBe(true));
    expect(seen).toEqual(['do the work', 'the check failed: fix it']);
    expect(beforeIdle).toHaveBeenCalledTimes(2);
    expect(sent.filter((m) => m.t === 'status' && m.status === 'idle')).toHaveLength(1);
    runner.close();
  });

  it('does not report idle when the owner wrote while the check ran', async () => {
    seen.length = 0;
    const sent: WorkerToServer[] = [];
    let release: (v: string | null) => void = () => undefined;
    const calls: number[] = [];
    const beforeIdle = () => {
      calls.push(Date.now());
      return calls.length === 1 ? new Promise<string | null>((r) => (release = r)) : Promise.resolve(null);
    };
    const runner = new ClaudeRunner(spec, { emit: (m) => sent.push(m), rpc: async () => undefined, cwd: '/tmp', onClosed: () => undefined, beforeIdle }, opts);
    runner.start('first');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    runner.push('owner: also this');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    release(null); // the stopped check of the first turn
    await vi.waitFor(() => expect(sent.filter((m) => m.t === 'status' && m.status === 'idle')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.filter((m) => m.t === 'status' && m.status === 'idle')).toHaveLength(1);
    expect(seen).toEqual(['first', 'owner: also this']);
    runner.close();
  });
});
