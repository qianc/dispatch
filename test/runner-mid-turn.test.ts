// DISP-263: a message pushed while a turn runs goes to Claude at once, marked `priority: 'next'`:
// Claude Code then reads it after the current tool step, not when the turn ends (an unmarked
// message may wait for the turn's end).
import { describe, expect, it, vi } from 'vitest';
import type { StartSpec } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';

const seen: { text: string; priority?: string; turnDone: boolean }[] = [];
let turnDone = false;
let release: () => void = () => undefined;
vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({
  ...(await real<object>()),
  query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: string }; priority?: string }> }) => {
    const input = prompt[Symbol.asyncIterator]();
    async function* run() {
      // the turn of the first message: a long tool step, and the input is read meanwhile, as the CLI does
      const first = await input.next();
      seen.push({ text: String(first.value.message.content), priority: first.value.priority, turnDone });
      yield { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } };
      const next = input.next().then((m) => void seen.push({ text: String(m.value.message.content), priority: m.value.priority, turnDone }));
      await new Promise<void>((r) => (release = r));
      await next;
      turnDone = true;
      yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, duration_ms: 1 };
    }
    return Object.assign(run(), { interrupt: async () => undefined, close: () => undefined, setPermissionMode: async () => undefined });
  },
}));

const { ClaudeRunner } = await import('../src/worker/runner.ts');

const spec: StartSpec = {
  session_id: 4, kind: 'planner', project_key: 'EYS', project_name: 'EYS', importance_scale: [], effort_scale: [],
  title: 't', branch: null, repos: [], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS,
  claude_account: null, github_account: null, resume: null, resume_note: null,
};
const opts = { pluginDirs: [], settingSources: [], idleCloseMs: 60_000, assistantModel: 'haiku', discussModel: 'haiku', assistantReadDirs: [] };

describe('ClaudeRunner: a message during a turn', () => {
  it('reaches Claude before the turn ends, marked to be read after the current tool step', async () => {
    const runner = new ClaudeRunner(spec, { emit: () => undefined, rpc: async () => undefined, cwd: '/tmp', onClosed: () => undefined }, opts);
    runner.start('run the full suite');
    await new Promise((r) => setTimeout(r, 10));
    runner.push('only run the targeted tests');
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([
      { text: 'run the full suite', priority: 'next', turnDone: false },
      { text: 'only run the targeted tests', priority: 'next', turnDone: false },
    ]);
    release();
    runner.close();
  });
});
