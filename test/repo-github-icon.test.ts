import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary, Repo } from '../web/src/api.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

vi.mock('../web/src/wide.ts', () => ({ useWide: () => true, useVeryWide: () => true }));

let Project: typeof import('../web/src/pages/Project.tsx').Project;
beforeEach(async () => {
  stubBrowser();
  ({ Project } = await import('../web/src/pages/Project.tsx'));
});
afterEach(() => vi.unstubAllGlobals());

const repo = (id: number, over: Partial<Repo>): Repo => ({ id, project_id: 1, github_owner: 'me', github_name: 'app', default_branch: 'main', check_command: null, local_path: null, worktree_from: null, setup_command: null, kind: 'github', ...over });
const project: ProjectSummary = {
  id: 1, key: 'GH', name: 'Icons', description: '', default_force_plan: false, importance_scale: [], effort_scale: [], github_account: null, claude_account: null, claude_allowed: null,
  color: null, icon: null, worker_id: null, placement_md: '', disabled: false, disabled_at: null, disabled_by: null, created_at: '2026-01-01T00:00:00Z', muted: false,
  repos: [
    repo(1, {}),
    repo(2, { github_owner: 'local', github_name: 'notes', local_path: '/home/me/notes', kind: 'local' }),
    repo(3, { github_owner: 'hosted', github_name: 'kept', kind: 'hosted' }),
  ],
};

describe("the GitHub mark in a project's Repos list (DISP-69)", () => {
  /** The repo rows of the Repos card, as [text, html]. */
  const rows = () => {
    const qc = new QueryClient();
    qc.setQueryData(['project', 'GH'], project);
    const html = renderPage(createElement(Project), { qc, path: '/p/GH?tab=settings', route: '/p/:key' });
    const list = html.slice(html.indexOf('>Repos<'));
    return list.split('<div class="flex items-center gap-2 px-3 py-2.5 border-b border-line">').slice(1).map((row) => [textOf(row), row] as const);
  };

  it('a GitHub repo shows the mark before owner/name, named for a screen reader', () => {
    const [text, html] = rows().find(([t]) => t.includes('me/app'))!;
    expect(html).toContain('aria-label="GitHub repo"');
    expect(html).toContain('title="GitHub repo"');
    expect(html).toContain('role="img"');
    expect(html.indexOf('GitHub repo')).toBeLessThan(html.indexOf('me/app'));
    expect(text).not.toMatch(/\b(local|hosted)\b/); // no chip
  });

  it('local and hosted repos keep their chips and get no mark', () => {
    const local = rows().find(([t]) => t.includes('/home/me/notes'))!;
    const hosted = rows().find(([t]) => t.includes('kept'))!;
    expect(local[0]).toMatch(/^local \/home\/me\/notes/);
    expect(hosted[0]).toMatch(/^hosted kept/);
    for (const [, html] of [local, hosted]) expect(html).not.toContain('GitHub repo');
  });
});
