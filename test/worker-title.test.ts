// DISP-110: the worker asks a small model once for an orchestration's title.
import { describe, expect, it, vi } from 'vitest';

const calls: { prompt: string; options: Record<string, unknown> }[] = [];
let answer: Record<string, unknown> = {};
vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({
  ...(await real<object>()),
  query: (q: { prompt: string; options: Record<string, unknown> }) => {
    calls.push(q);
    return (async function* () { yield { type: 'system', subtype: 'init' }; yield answer; })();
  },
}));
const { makeTitle } = await import('../src/worker/title.ts');

describe('makeTitle', () => {
  it('asks the small model once, without tools, and gives its answer', async () => {
    answer = { type: 'result', subtype: 'success', is_error: false, result: ' Token sign-in migration\n' };
    expect(await makeTitle('Move sign-in to tokens', ['AA (App)'], { model: 'haiku', env: { CLAUDE_CONFIG_DIR: '/x' } })).toBe('Token sign-in migration');
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('Projects: AA (App)');
    expect(calls[0].prompt).toContain('Move sign-in to tokens');
    expect(calls[0].options).toMatchObject({ model: 'haiku', tools: [], maxTurns: 1, env: { CLAUDE_CONFIG_DIR: '/x' } });
  });

  it('throws when the model fails, so the caller keeps its own title', async () => {
    answer = { type: 'result', subtype: 'error_during_execution', is_error: true };
    await expect(makeTitle('g', [], { model: 'haiku' })).rejects.toThrow(/no title/);
    answer = { type: 'result', subtype: 'success', is_error: true, result: 'API Error' };
    await expect(makeTitle('g', [], { model: 'haiku' })).rejects.toThrow(/no title/);
  });
});
