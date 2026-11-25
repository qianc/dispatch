import { describe, expect, it } from 'vitest';
import type { Session } from '../src/shared/types.ts';
import { logTail } from '../src/server/github.ts';
import { dispatchMcp } from '../src/worker/mcp.ts';
import { plannerPrompt } from '../src/worker/prompts.ts';
import { fakeGithub } from './github.ts';
import { ghError, prServer } from './project-prs-helpers.ts';

// DISP-258: a GitHub check on the PRs page reads GitHub's findings, files items and proposes fixes.
type Tools = { instance: { _registeredTools: Record<string, unknown> } };
const tools = (githubCheck: boolean) => Object.keys((dispatchMcp('planner', async () => null, undefined, undefined, false, undefined, undefined, false, [], githubCheck) as unknown as Tools).instance._registeredTools);

const run = (id: number, workflow_id: number, conclusion: string, over: Record<string, unknown> = {}) => ({
  id, workflow_id, name: `wf${workflow_id}`, status: 'completed', conclusion, head_branch: 'main', head_sha: `abcdef${id}`, html_url: `https://github.com/me/app/actions/runs/${id}`, updated_at: '2026-11-20T00:00:00Z', ...over,
});

describe('the GitHub check (DISP-258)', () => {
  it('starts one planner per project at a time, with the GitHub tools and its job', async () => {
    const t = await prServer();
    const first: Session = (await t.s.call('POST', '/projects/PP/github-check')).data;
    expect(first).toMatchObject({ kind: 'planner', title: 'GitHub check', github_check: true });
    // still working: the same check
    expect((await t.s.call('POST', '/projects/PP/github-check')).data.id).toBe(first.id);
    expect((await t.s.call('GET', '/projects/PP/github-check')).data.session.id).toBe(first.id);
    const spec = t.s.ctx.sessions.spec(t.s.ctx.store.session(first.id)!, '', null, null);
    expect(spec.github_check).toBe(true);
    expect(plannerPrompt(spec)).toContain('## Your job: a GitHub check');
    expect(tools(true)).toEqual(expect.arrayContaining(['github_findings', 'create_item', 'propose_batch']));
    expect(tools(false)).not.toContain('github_findings');
    expect(tools(false)).not.toContain('create_item');
    // a finished check is closed for a new one
    t.s.ctx.store.updateSession(first.id, { status: 'idle' });
    const second: Session = (await t.s.call('POST', '/projects/PP/github-check')).data;
    expect(second.id).not.toBe(first.id);
    expect(t.s.ctx.store.session(first.id)!.status).toBe('completed');
    await t.s.app.close();
  });

  it('a project without a GitHub repo has nothing to check, and a plain planner cannot read findings', async () => {
    const t = await prServer();
    await t.s.call('POST', '/projects', { key: 'NG', name: 'No GitHub' });
    expect((await t.s.call('POST', '/projects/NG/github-check')).status).toBe(400);
    const plain: Session = (await t.s.call('POST', '/projects/PP/planner', { prompt: '' })).data;
    await expect(t.s.ctx.sessions.rpc(plain.id, 'github_findings', {})).rejects.toThrow(/Only a GitHub check/);
    await t.s.app.close();
  });

  it('reads alerts and the latest failed run per workflow, never a secret, and says what it could not read', async () => {
    const t = await prServer();
    const impl = {
      codeScanning: {
        listAlertsForRepo: async () => ({ data: [
          { number: 1, html_url: 'https://github.com/me/app/security/code-scanning/1', tool: { name: 'CodeQL' }, rule: { id: 'js/sql-injection', description: 'SQL injection', security_severity_level: 'high' }, most_recent_instance: { location: { path: 'src/db.ts', start_line: 9 }, message: { text: 'built from user input' } } },
          { number: 2, html_url: 'https://github.com/me/app/security/code-scanning/2', tool: { name: 'CodeQL' }, rule: { id: 'js/unused-local-variable', description: 'Unused variable', severity: 'note' }, most_recent_instance: { location: { path: 'src/a.ts', start_line: 3 }, message: { text: 'x is unused' } } },
        ] }),
      },
      dependabot: { listAlertsForRepo: async () => { throw ghError(403, 'Dependabot alerts are disabled for this repository.'); } },
      secretScanning: { listAlertsForRepo: async () => ({ data: [{ number: 4, html_url: 'https://github.com/me/app/security/secret-scanning/4', secret_type_display_name: 'GitHub Personal Access Token', secret: 'ghp_leaked', created_at: '2026-11-01T00:00:00Z' }] }) },
      actions: {
        // newest first: wf1 failed last, wf2 failed before but passed since
        listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [run(13, 1, 'failure'), run(12, 2, 'success'), run(11, 2, 'failure'), run(10, 1, 'success')] } }),
        listJobsForWorkflowRun: async () => ({ data: { jobs: [
          { id: 7, name: 'test', conclusion: 'failure', html_url: 'https://github.com/me/app/actions/runs/13/job/7', steps: [{ name: 'npm test', conclusion: 'failure' }, { name: 'checkout', conclusion: 'success' }] },
          { id: 8, name: 'lint', conclusion: 'success', steps: [] },
        ] } }),
        downloadJobLogsForWorkflowRun: async () => ({ data: '2026-11-20T00:00:01.000Z npm test\n2026-11-20T00:00:02.000Z FAIL test/a.test.ts\n' }),
      },
    };
    fakeGithub(t.s.ctx, impl);
    const s: Session = (await t.s.call('POST', '/projects/PP/github-check')).data;
    const [r] = (await t.s.ctx.sessions.rpc(s.id, 'github_findings', {})) as any[];
    expect(r.repo).toBe('me/app');
    expect(r.code_scanning).toEqual([expect.objectContaining({ number: 1, severity: 'high', path: 'src/db.ts', line: 9 })]);
    expect(r.code_quality).toEqual([expect.objectContaining({ number: 2, rule: 'js/unused-local-variable' })]);
    expect(r.dependabot).toEqual([]);
    expect(r.not_read).toEqual(['Dependabot alerts: Dependabot alerts are disabled for this repository.']);
    expect(r.secret_scanning).toEqual([{ number: 4, url: 'https://github.com/me/app/security/secret-scanning/4', type: 'GitHub Personal Access Token', created_at: '2026-11-01T00:00:00Z' }]);
    expect(JSON.stringify(r)).not.toContain('ghp_leaked');
    expect(r.failed_runs).toEqual([expect.objectContaining({
      workflow: 'wf1', where: 'main branch', url: 'https://github.com/me/app/actions/runs/13',
      failed_jobs: [{ name: 'test', url: 'https://github.com/me/app/actions/runs/13/job/7', failed_steps: ['npm test'], log_tail: 'npm test\nFAIL test/a.test.ts' }],
    })]);
    await t.s.app.close();
  });

  it('keeps only the end of a long log', () => {
    const log = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const tail = logTail(log).split('\n');
    expect(tail).toHaveLength(80);
    expect(tail.at(-1)).toBe('line 199');
  });
});
