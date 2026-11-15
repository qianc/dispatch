// DISP-95: the orchestrator never runs on Haiku, also where Haiku is the worker's own model.
import { describe, expect, it, vi } from 'vitest';
import type { StartSpec } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';

/** A stand-in for Claude that records the model each process was started with. */
const models: (string | undefined)[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({
  ...(await real<object>()),
  query: ({ options }: { options: { model?: string } }) => {
    models.push(options.model);
    const it = (async function* () {})();
    return Object.assign(it, { interrupt: async () => undefined, close: () => undefined, setPermissionMode: async () => undefined });
  },
}));

const { ClaudeRunner } = await import('../src/worker/runner.ts');

const spec = (kind: StartSpec['kind'], model: StartSpec['options']['model']): StartSpec => ({
  session_id: 3, kind, project_key: 'HC', project_name: 'HC', importance_scale: [], effort_scale: [],
  title: 't', branch: null, repos: [], items: [], source: null, prompt: '', force_plan: false, options: { ...DEFAULT_RUN_OPTIONS, model },
  claude_account: null, github_account: null, resume: null, resume_note: null,
  orchestration: { goal: 'g', phase: 'plan', projects: [], max_children: 1, status_md: '' },
});
const opts = (model: string | undefined) => ({ pluginDirs: [], settingSources: [], model, idleCloseMs: 60_000, assistantModel: 'haiku', discussModel: 'haiku', assistantReadDirs: [] });

describe('ClaudeRunner: the model of an orchestrator', () => {
  const started = (kind: StartSpec['kind'], model: StartSpec['options']['model'], own: string | undefined) => {
    const runner = new ClaudeRunner(spec(kind, model), { emit: () => undefined, rpc: async () => undefined, cwd: '/tmp', onClosed: () => undefined }, opts(own));
    runner.start('go');
    runner.close();
    return models.at(-1);
  };

  it('runs on the model picked for it, else on the worker\'s own, but not where that is Haiku', () => {
    expect(started('orchestrator', 'fable', 'haiku')).toBe('fable');
    expect(started('orchestrator', 'default', 'sonnet')).toBe('sonnet');
    expect(started('orchestrator', 'default', 'haiku')).toBeUndefined();
    expect(started('orchestrator', 'default', 'claude-haiku-4-5')).toBeUndefined();
    // a batch keeps the worker's own model
    expect(started('work', 'default', 'haiku')).toBe('haiku');
  });
});
