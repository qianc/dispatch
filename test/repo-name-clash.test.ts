import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Workspaces } from '../src/worker/workspace.ts';
import type { Repo } from '../src/shared/types.ts';
import { startServer } from './helpers.ts';

describe('two repos with one name in a project (DISP-142)', () => {
  it('refuses a second repo with the same name: they would share one worktree folder', async () => {
    const s = await startServer();
    await s.call('POST', '/projects', { key: 'NC', name: 'NC' });
    expect((await s.call('POST', '/projects/NC/repos', { github_owner: 'alice', github_name: 'app' })).status).toBe(200);
    const again = await s.call('POST', '/projects/NC/repos', { github_owner: 'acme', github_name: 'app' });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.data)).toContain('This project already has a repo named app.');
    await s.app.close();
  });
});

describe('setup timeout (DISP-138)', () => {
  it('returns at the timeout and kills the children too, not only sh', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'dsp-setup-'));
    const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')));
    // the child keeps the output pipe open and outlives a kill of sh alone
    const repo = { id: 1, project_id: 1, github_owner: 'me', github_name: 'hc', default_branch: 'main', check_command: null, local_path: null, worktree_from: null, setup_command: 'sleep 999 & echo $! > child.pid; wait' } as Repo;
    const started = Date.now();
    const r = await ws.setup(repo, wt, null, 500);
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number(readFileSync(join(wt, 'child.pid'), 'utf8'));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    // SIGKILL arrives, and the orphan is reaped, asynchronously: give it a moment (DISP-172)
    for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
    const survived = alive();
    if (survived) process.kill(pid, 'SIGKILL'); // no stray sleep after a failed run
    expect(survived).toBe(false);
  });
});
