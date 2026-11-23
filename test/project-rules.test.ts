import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectRules } from '../src/server/projectRules.ts';
import { plannerPrompt } from '../src/worker/prompts.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import { startServer, OWNER } from './helpers.ts';

// DISP-6: agents that file items follow the project's own CLAUDE.md over Dispatch's defaults.
const RULES = 'Everything goes in the backlog, never as a bug. Every item carries an internal id (SLD-ID).';

describe("a project's own instructions for items", () => {
  it('reach the planner prompt, with the rule that they win over the defaults', () => {
    const spec = {
      session_id: 1, kind: 'planner' as const, project_key: 'SLD', project_name: 'slides', importance_scale: ['L', 'M', 'H', 'C'], effort_scale: ['S'],
      title: 't', branch: null, repos: [], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS,
      claude_account: null, github_account: null, resume: null, resume_note: null,
    };
    const text = plannerPrompt(spec, [{ label: 'CLAUDE.md from /ws/slides', text: RULES }]);
    expect(text).toContain("## The project's own instructions");
    expect(text).toContain('follow them over the defaults in this prompt');
    expect(text).toContain(`### CLAUDE.md from /ws/slides\n\n${RULES}`);
    expect(plannerPrompt(spec)).not.toContain("project's own instructions\n");
  });

  describe('in the assistant', () => {
    let s: Awaited<ReturnType<typeof startServer>>;
    beforeAll(async () => {
      s = await startServer({ DATA_DIR: mkdtempSync(join(tmpdir(), 'dsp-rdata-')) });
      await s.call('POST', '/projects', { key: 'SLD', name: 'slides' });
      await s.call('POST', '/projects', { key: 'PLN', name: 'Plain' });
      const repo = (await s.call('POST', '/projects/SLD/repos', { hosted: { name: 'slides' } })).data;
      // main is set up straight in the server's repo, as a Dispatch merge would (DISP-224)
      const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', DISPATCH_ALLOW_DEFAULT: '1' };
      const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, encoding: 'utf8' });
      const dir = mkdtempSync(join(tmpdir(), 'dsp-rules-'));
      git(dir, 'clone', '--quiet', s.ctx.hosted.dir(s.ctx.store.repo(repo.id)!), '.');
      writeFileSync(join(dir, 'CLAUDE.md'), RULES);
      git(dir, 'add', '.');
      git(dir, 'commit', '--quiet', '-m', 'rules');
      git(dir, 'push', '--quiet', 'origin', 'HEAD:main');
    });
    afterAll(() => s.app.close());

    const chat = () => s.ctx.store.createSession({ started_by: OWNER, worker_id: s.ctx.store.defaultWorkerId(), project_id: null, kind: 'assistant', title: 'Assistant', status: 'idle', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [] });
    const create = (sessionId: number, project_key: string) => s.ctx.sessions.rpc(sessionId, 'create_items', { project_key, items: [{ type: 'backlog', title: 'SLD-ID 7: tidy the title slide' }] });

    it('refuse the first create_items once, with the instructions, then create', async () => {
      const a = chat();
      const count = () => s.ctx.store.items(s.ctx.store.projectByKey('SLD')!.id).length;
      await expect(create(a.id, 'SLD')).rejects.toThrow(new RegExp(`Nothing created yet[\\s\\S]*win over Dispatch's defaults[\\s\\S]*CLAUDE.md of slides\\n\\n${RULES.replace(/[.()]/g, '\\$&')}`));
      expect(count()).toBe(0);
      expect(await create(a.id, 'SLD')).toEqual([expect.objectContaining({ title: 'SLD-ID 7: tidy the title slide' })]);
      expect(count()).toBe(1);
    });

    it('create at once in a project without instructions', async () => {
      expect(await create(chat().id, 'PLN')).toHaveLength(1);
    });
  });
});

describe('projectRules when a file cannot be read (DISP-239 #27)', () => {
  const project = { id: 1, key: 'NB', worker_id: 7 } as never;
  const deps = (error: string) => ({
    store: { repos: () => [{ kind: 'github', github_name: 'techdoc' }], defaultWorkerId: () => 7 },
    hub: { cmd: async () => { throw new Error(error); } },
    hosted: {},
  }) as never;

  it('throws when the worker that reads them is away, so nobody takes that for "no rules"', async () => {
    await expect(projectRules(deps('Worker is not connected'), project)).rejects.toThrow(/NB's instructions for agents \(CLAUDE.md of techdoc\) could not be read/);
    await expect(projectRules(deps('worker command read_file timed out'), project)).rejects.toThrow(/could not be read/);
  });

  it('is empty when git has no such file', async () => {
    expect(await projectRules(deps("git show refs/heads/main:CLAUDE.md failed: fatal: path 'CLAUDE.md' does not exist in 'refs/heads/main'"), project)).toBe('');
  });
});
