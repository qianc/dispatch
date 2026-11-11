import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../web/src/api.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

vi.mock('../web/src/wide.ts', () => ({ useWide: () => true, useVeryWide: () => true }));

let Project: typeof import('../web/src/pages/Project.tsx').Project;
beforeEach(async () => {
  stubBrowser();
  ({ Project } = await import('../web/src/pages/Project.tsx'));
});
afterEach(() => vi.unstubAllGlobals());

const project = (disabled: boolean): ProjectSummary => ({
  id: 1, key: 'LK', name: 'Locks', description: '', default_force_plan: false, importance_scale: [], effort_scale: [], github_account: null, claude_account: null, claude_allowed: null,
  color: null, icon: null, worker_id: null, placement_md: '', disabled, disabled_at: disabled ? '2026-01-02T00:00:00Z' : null, disabled_by: disabled ? 'owner' : null,
  created_at: '2026-01-01T00:00:00Z', muted: false, repos: [],
});

const render = (disabled: boolean, tab = 'backlog') => {
  const qc = new QueryClient();
  qc.setQueryData(['project', 'LK'], project(disabled));
  const html = renderPage(createElement(Project), { qc, path: `/p/LK?tab=${tab}`, route: '/p/:key' });
  // the header: up to the end of the page's <header>
  return { html, header: html.slice(0, html.indexOf('</header>')) };
};
/** The buttons in some HTML, by their text and aria-label. */
const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map((m) => `${m[1].match(/aria-label="([^"]*)"/)?.[1] ?? ''} ${textOf(m[2])}`.trim());

describe('the lock in the project header (DISP-76)', () => {
  it('an unlocked project has no lock button in its header; the other actions stay', () => {
    const { html, header } = render(false);
    expect(html).not.toContain('Disable project (read-only)');
    expect(html).not.toContain('Project locked');
    expect(buttons(header).join('|')).not.toMatch(/lock|Disable|Enable/i);
    expect(buttons(header).join('|')).toMatch(/Plan with Claude/);
  });

  it('a locked project shows a "Locked" status, not a button, and no Enable button', () => {
    const { html, header } = render(true);
    const indicator = header.match(/<span[^>]*aria-label="Project locked"[^>]*>.*?<\/span>/)?.[0];
    expect(indicator).toBeTruthy();
    expect(indicator).toContain('role="status"');
    expect(textOf(indicator!)).toBe('Locked');
    expect(buttons(html).join('|')).not.toMatch(/Enable/);
  });

  it('the banner says it is read-only and names Settings and the Assistant as the ways to unlock, with no Enable action', () => {
    const { html } = render(true);
    const banner = html.slice(html.indexOf('Read-only'));
    expect(textOf(banner)).toMatch(/To unlock it, set its state to Active in Settings ?, or ask the Assistant ?to unlock it\./);
    expect(banner).toContain('href="/p/LK?tab=settings"');
    expect(banner).toContain('href="/assistant"');
    expect(buttons(html).join('|')).not.toMatch(/Enable/);
  });

  it('Settings still has the control that locks and unlocks the project', () => {
    for (const disabled of [false, true]) {
      const text = textOf(render(disabled, 'settings').html);
      expect(text).toMatch(/State Active Disabled \(read-only\)/);
    }
  });
});
