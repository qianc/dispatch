import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../web/src/api.ts';
import { renderPage, stubBrowser } from './web-render.ts';

vi.mock('../web/src/wide.ts', () => ({ useWide: () => true, useVeryWide: () => true }));

let Layout: typeof import('../web/src/components/Layout.tsx').Layout;
let Projects: typeof import('../web/src/pages/Projects.tsx').Projects;
let removed: string[];
const stored = new Map<string, string>();
beforeEach(async () => {
  vi.resetModules();
  stubBrowser();
  removed = [];
  // what the old menu kept: recently opened projects, newest first
  stored.set('dispatch:recent-projects', JSON.stringify(['ZED', 'BET']));
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => { removed.push(k); stored.delete(k); } });
  ({ Layout } = await import('../web/src/components/Layout.tsx'));
  ({ Projects } = await import('../web/src/pages/Projects.tsx'));
});
afterEach(() => vi.unstubAllGlobals());

const project = (id: number, key: string, name: string): ProjectSummary => ({
  id, key, name, description: '', default_force_plan: false, importance_scale: [], effort_scale: [], github_account: null, claude_account: null, claude_allowed: null,
  color: null, icon: null, worker_id: null, placement_md: '', disabled: false, disabled_at: null, disabled_by: null,
  created_at: '2026-01-01T00:00:00Z', muted: false, repos: [],
});
// more than the old menu's six, in an order that is not by name
const PROJECTS = [
  project(1, 'ZED', 'Zebra'), project(2, 'ALP', 'alpha'), project(3, 'GAM', 'Gamma'), project(4, 'BET', 'Beta'),
  project(5, 'DEL', 'Delta'), project(6, 'EPS', 'epsilon'), project(7, 'ETA', 'Eta'), project(8, 'OME', 'Omega'),
];
const ALPHABETICAL = ['alpha', 'Beta', 'Delta', 'epsilon', 'Eta', 'Gamma', 'Omega', 'Zebra'];

const seeded = () => {
  const qc = new QueryClient();
  qc.setQueryData(['projects'], PROJECTS);
  qc.setQueryData(['sessions', 'live'], []);
  return qc;
};
/** The project rows of the desktop menu: [name, current]. */
const menuProjects = (path: string) => {
  const html = renderPage(createElement(Layout), { qc: seeded(), path, route: '*' });
  return [...html.matchAll(/<a([^>]*href="\/p\/[A-Z]+"[^>]*)>.*?<span class="truncate flex-1">([^<]*)<\/span>/g)].map((m) => [m[2], m[1].includes('aria-current="page"')] as const);
};

describe('the desktop menu lists projects by name (DISP-79)', () => {
  it('keeps every project in alphabetical order after opening the last one, marked as current', () => {
    const before = menuProjects('/');
    expect(before.map(([name]) => name)).toEqual(ALPHABETICAL);
    expect(before.some(([, current]) => current)).toBe(false);
    // open the project at the bottom of the list: it stays there, marked
    const after = menuProjects('/p/ZED');
    expect(after.map(([name]) => name)).toEqual(ALPHABETICAL);
    expect(after.filter(([, current]) => current)).toEqual([['Zebra', true]]);
  });

  it('shows the projects page in the same order', () => {
    const html = renderPage(createElement(Projects), { qc: seeded(), path: '/projects' });
    const names = [...html.matchAll(/<span class="flex-1 font-medium truncate">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(names).toEqual(ALPHABETICAL);
  });

  it('ignores and clears an old list of recent projects', () => {
    expect(menuProjects('/p/BET').map(([name]) => name)).toEqual(ALPHABETICAL);
    expect(removed).toContain('dispatch:recent-projects');
  });
});
