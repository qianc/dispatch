// DISP-47: AGENT_PLUGIN_DIRS follows plugin updates, which Claude does in the background.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartSpec } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';

/** A stand-in for Claude: records the options of each session. */
const seen: { plugins?: { path: string }[] }[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({
  ...(await real<object>()),
  query: ({ options }: { options: { plugins?: { path: string }[] } }) => {
    seen.push(options);
    async function* run() {}
    return Object.assign(run(), { interrupt: async () => undefined, close: () => undefined, setPermissionMode: async () => undefined });
  },
}));

const { ClaudeRunner, resolvePluginDirs } = await import('../src/worker/runner.ts');

const ID = 'superpowers@official';
let config: string;
let warn: ReturnType<typeof vi.spyOn>;

const cached = (version: string) => join(config, 'plugins', 'cache', 'official', 'superpowers', version);

/** Claude has installed this version: its folder exists and the plugin list points to it. */
function install(version: string) {
  mkdirSync(cached(version), { recursive: true });
  writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { [ID]: [{ scope: 'project', installPath: join(config, 'other') }, { scope: 'user', installPath: cached(version), version }] },
  }));
}

beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), 'agent-plugins-'));
  mkdirSync(join(config, 'plugins'));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  vi.unstubAllEnvs();
});

describe('resolvePluginDirs', () => {
  it('finds a plugin by name, in the user install', () => {
    install('7.0.0');
    expect(resolvePluginDirs([ID], config)).toEqual([cached('7.0.0')]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('moves a cache folder of a removed version to the installed version', () => {
    install('7.0.0');
    expect(resolvePluginDirs([cached('6.4.1')], config)).toEqual([cached('7.0.0')]);
  });

  it('moves a cache folder of an old version that is still there, and reads the list of that cache', () => {
    install('7.0.0');
    mkdirSync(cached('6.4.1'));
    expect(resolvePluginDirs([cached('6.4.1')], '/nowhere')).toEqual([cached('7.0.0')]);
  });

  it('leaves other folders as they are', () => {
    install('7.0.0');
    const dir = join(config, 'own-plugin');
    mkdirSync(dir);
    expect(resolvePluginDirs([dir], config)).toEqual([dir]);
  });

  it('expands ~ in a folder', () => {
    expect(resolvePluginDirs(['~'], config)).toEqual([homedir()]);
  });

  it('keeps a cache folder that exists when the plugin list does not have it', () => {
    mkdirSync(cached('1.0.0'), { recursive: true });
    expect(resolvePluginDirs([cached('1.0.0')], config)).toEqual([cached('1.0.0')]);
  });

  it('leaves out what it cannot find, with a warning, and keeps the rest', () => {
    install('7.0.0');
    const missing = join(config, 'missing');
    expect(resolvePluginDirs([missing, 'other@official', ID], config)).toEqual([cached('7.0.0')]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('leaves out an installed plugin whose folder is gone', () => {
    install('7.0.0');
    rmSync(cached('7.0.0'), { recursive: true });
    expect(resolvePluginDirs([ID], config)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('survives a broken plugin list', () => {
    writeFileSync(join(config, 'plugins', 'installed_plugins.json'), 'not json');
    expect(resolvePluginDirs([ID], config)).toEqual([]);
  });

  it('looks in CLAUDE_CONFIG_DIR by default', () => {
    install('7.0.0');
    vi.stubEnv('CLAUDE_CONFIG_DIR', config);
    expect(resolvePluginDirs([ID])).toEqual([cached('7.0.0')]);
  });
});

describe('ClaudeRunner plugins', () => {
  const spec = (kind: StartSpec['kind']): StartSpec => ({
    session_id: 3, kind, project_key: 'HC', project_name: 'HC', importance_scale: [], effort_scale: [],
    title: 't', branch: 'b', repos: [], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS,
    claude_account: null, github_account: null, resume: null, resume_note: null,
  });
  const pluginsFor = (kind: StartSpec['kind'], opts: { pluginDirs: string[] }) => {
    seen.length = 0;
    const runner = new ClaudeRunner(spec(kind), { emit: () => undefined, rpc: async () => undefined, cwd: '/tmp', onClosed: () => undefined }, opts as never);
    runner.start('hi');
    runner.close();
    return seen[0].plugins?.map((p) => p.path);
  };

  it('uses the version installed when the session starts, also after an update while the worker runs', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', config);
    const opts = { pluginDirs: [ID], settingSources: [] };
    install('6.4.1');
    expect(pluginsFor('work', opts)).toEqual([cached('6.4.1')]);
    rmSync(cached('6.4.1'), { recursive: true });
    install('7.0.0');
    expect(pluginsFor('work', opts)).toEqual([cached('7.0.0')]);
  });

  it('keeps chats without plugins', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', config);
    install('7.0.0');
    expect(pluginsFor('discuss', { pluginDirs: [ID] })).toEqual([]);
  });
});
