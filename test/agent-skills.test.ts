// DISP-46: work sessions load the skills in AGENT_SKILLS, without the rest of ~/.claude.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { StartSpec } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';

/** A stand-in for Claude: records the options of each session. */
const seen: { additionalDirectories?: string[] }[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({
  ...(await real<object>()),
  query: ({ options }: { options: { additionalDirectories?: string[] } }) => {
    seen.push(options);
    async function* run() {}
    return Object.assign(run(), { interrupt: async () => undefined, close: () => undefined, setPermissionMode: async () => undefined });
  },
}));

const { ClaudeRunner, linkAgentSkills } = await import('../src/worker/runner.ts');

function skill(root: string, name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  return dir;
}

describe('linkAgentSkills', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-skills-'));
    return { root, dir: join(root, 'agent-skills'), links: join(root, 'agent-skills', '.claude', 'skills') };
  };

  it('links each skill under .claude/skills and returns the folder', () => {
    const { root, dir, links } = setup();
    const a = skill(root, 'a');
    expect(linkAgentSkills([a], dir)).toBe(dir);
    expect(realpathSync(join(links, 'a'))).toBe(realpathSync(a));
    expect(existsSync(join(links, 'a', 'SKILL.md'))).toBe(true);
  });

  it('removes links no longer listed, and keeps the skill they pointed to', () => {
    const { root, dir, links } = setup();
    const a = skill(root, 'a');
    const b = skill(root, 'b');
    linkAgentSkills([a, b], dir);
    linkAgentSkills([b], dir);
    expect(readdirSync(links)).toEqual(['b']);
    expect(existsSync(join(a, 'SKILL.md'))).toBe(true);
  });

  it('skips a folder without SKILL.md, and returns undefined when no skill is left', () => {
    const { root, dir, links } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(linkAgentSkills([join(root, 'missing')], dir)).toBeUndefined();
    expect(readdirSync(links)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('returns undefined when nothing is listed', () => {
    const { dir } = setup();
    expect(linkAgentSkills([], dir)).toBeUndefined();
  });
});

describe('ClaudeRunner additional directories', () => {
  const spec = (kind: StartSpec['kind']): StartSpec => ({
    session_id: 3, kind, project_key: 'HC', project_name: 'HC', importance_scale: [], effort_scale: [],
    title: 't', branch: 'b', repos: [], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS,
    claude_account: null, github_account: null, resume: null, resume_note: null,
  });
  const opts = { pluginDirs: [], settingSources: [], model: undefined, idleCloseMs: 60_000, assistantModel: 'haiku', discussModel: 'haiku', assistantReadDirs: [] };
  const optionsFor = (kind: StartSpec['kind'], agentSkillsDir?: string) => {
    seen.length = 0;
    const runner = new ClaudeRunner(spec(kind), { emit: () => undefined, rpc: async () => undefined, cwd: '/tmp', onClosed: () => undefined }, { ...opts, agentSkillsDir });
    runner.start('hi');
    runner.close();
    return seen[0];
  };

  it('gives work sessions the skills folder', () => {
    expect(optionsFor('work', '/skills').additionalDirectories).toEqual(['/skills']);
  });

  it('keeps chats without it', () => {
    expect(optionsFor('assistant', '/skills').additionalDirectories).toBeUndefined();
    expect(optionsFor('discuss', '/skills').additionalDirectories).toBeUndefined();
  });

  it('adds nothing when no skill is configured', () => {
    expect(optionsFor('work').additionalDirectories).toBeUndefined();
  });
});
