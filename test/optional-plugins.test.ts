// DISP-222: optional plugins (ponytail) a batch turns on with a checkbox on its run options card.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartSpec } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS, runOptions } from '../src/shared/types.ts';

type Seen = { plugins?: { path: string }[]; env?: Record<string, string | undefined>; settings?: { enabledPlugins?: Record<string, boolean> } };
/** A stand-in for Claude: records the options of each session. */
const seen: Seen[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({
  ...(await real<object>()),
  query: ({ options }: { options: Seen }) => {
    seen.push(options);
    async function* run() {}
    return Object.assign(run(), { interrupt: async () => undefined, close: () => undefined, setPermissionMode: async () => undefined });
  },
}));

const { ClaudeRunner, optionalPluginsFor, parseOptionalPlugins } = await import('../src/worker/runner.ts');
const { runOptionsSummary } = await import('../web/src/components/batch.tsx');

const PONYTAIL = JSON.stringify([{ name: 'ponytail', plugin: 'ponytail@ponytail', env: { PONYTAIL_DEFAULT_MODE: 'full' }, off_env: { PONYTAIL_DEFAULT_MODE: 'off' } }]);
let config: string;
let warn: ReturnType<typeof vi.spyOn>;
const installed = () => join(config, 'plugins', 'cache', 'ponytail', 'ponytail', '5.3.3');

beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), 'optional-plugins-'));
  mkdirSync(installed(), { recursive: true });
  writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { 'ponytail@ponytail': [{ scope: 'user', installPath: installed(), version: '5.3.3' }] },
  }));
  vi.stubEnv('CLAUDE_CONFIG_DIR', config);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  vi.unstubAllEnvs();
});

describe('run options', () => {
  it('have no plugins by default, and keep the ones named', () => {
    expect(DEFAULT_RUN_OPTIONS.plugins).toEqual([]);
    expect(runOptions.parse({ plugins: ['ponytail'] }).plugins).toEqual(['ponytail']);
    expect(() => runOptions.parse({ plugins: 'ponytail' })).toThrow();
  });

  it('show a ticked plugin in the summary', () => {
    expect(runOptionsSummary(DEFAULT_RUN_OPTIONS)).toEqual([]);
    expect(runOptionsSummary({ ...DEFAULT_RUN_OPTIONS, plugins: ['ponytail'] })).toEqual(['+ponytail']);
  });
});

describe('AGENT_OPTIONAL_PLUGINS', () => {
  it('reads a name, a plugin, and the env for on and off', () => {
    expect(parseOptionalPlugins(PONYTAIL)).toEqual([{ name: 'ponytail', plugin: 'ponytail@ponytail', env: { PONYTAIL_DEFAULT_MODE: 'full' }, off_env: { PONYTAIL_DEFAULT_MODE: 'off' } }]);
  });

  it('reads a folder, without env', () => {
    expect(parseOptionalPlugins('[{"name":"a","plugin":"/p/a"}]')).toEqual([{ name: 'a', plugin: '/p/a', env: {}, off_env: {} }]);
    expect(parseOptionalPlugins('')).toEqual([]);
  });

  it('ignores a broken value, with a warning', () => {
    expect(parseOptionalPlugins('ponytail@ponytail')).toEqual([]);
    expect(parseOptionalPlugins('[{"name":"a b","plugin":"x@y"}]')).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('optional plugins of a session', () => {
  const list = parseOptionalPlugins(PONYTAIL);

  it('a batch with the tick loads the plugin, at its installed version, with its on env', () => {
    expect(optionalPluginsFor(list, 'work', ['ponytail'])).toEqual({ dirs: [installed()], env: { PONYTAIL_DEFAULT_MODE: 'full' }, disabled: [] });
  });

  it('a batch without it, and a planner or orchestrator even with it, gets the off env and the plugin switched off', () => {
    const off = { dirs: [], env: { PONYTAIL_DEFAULT_MODE: 'off' }, disabled: ['ponytail@ponytail'] };
    expect(optionalPluginsFor(list, 'work', [])).toEqual(off);
    expect(optionalPluginsFor(list, 'planner', ['ponytail'])).toEqual(off);
    expect(optionalPluginsFor(list, 'orchestrator', ['ponytail'])).toEqual(off);
  });

  const spec = (kind: StartSpec['kind'], plugins: string[]): StartSpec => ({
    session_id: 3, kind, project_key: 'HC', project_name: 'HC', importance_scale: [], effort_scale: [],
    title: 't', branch: 'b', repos: [], items: [], source: null, prompt: '', force_plan: false, options: { ...DEFAULT_RUN_OPTIONS, plugins },
    claude_account: null, github_account: null, resume: null, resume_note: null,
  });
  const started = (kind: StartSpec['kind'], plugins: string[], settingSources: string[] = ['project']) => {
    seen.length = 0;
    const opts = { pluginDirs: [], optionalPlugins: list, settingSources, sessionEnv: () => ({ ACCOUNT: 'a' }) };
    const runner = new ClaudeRunner(spec(kind, plugins), { emit: () => undefined, rpc: async () => undefined, cwd: '/tmp', onClosed: () => undefined }, opts as never);
    runner.start('hi');
    runner.close();
    return seen[0];
  };

  it('the runner adds the plugin after AGENT_PLUGIN_DIRS and merges its env into the session env', () => {
    const o = started('work', ['ponytail']);
    expect(o.plugins?.map((p) => p.path)).toEqual([installed()]);
    expect(o.env).toEqual({ ACCOUNT: 'a', PONYTAIL_DEFAULT_MODE: 'full' });
    expect(o.settings).toBeUndefined();
  });

  it('the runner keeps it off without the tick, also against the user settings', () => {
    const o = started('work', []);
    expect(o.plugins).toEqual([]);
    expect(o.env).toEqual({ ACCOUNT: 'a', PONYTAIL_DEFAULT_MODE: 'off' });
    expect(o.settings).toBeUndefined();
    expect(started('work', [], ['user', 'project']).settings).toEqual({ enabledPlugins: { 'ponytail@ponytail': false } });
  });

  it('chats get none of it', () => {
    const o = started('discuss', ['ponytail'], ['user']);
    expect(o.plugins).toEqual([]);
    expect(o.env).toEqual({ ACCOUNT: 'a' });
    expect(o.settings).toBeUndefined();
  });
});
