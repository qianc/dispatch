import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../web/src/api.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

const screen = vi.hoisted(() => ({ wide: true }));
vi.mock('../web/src/wide.ts', () => ({ useWide: () => screen.wide, useVeryWide: () => screen.wide }));

let Project: typeof import('../web/src/pages/Project.tsx').Project;
let A: typeof import('../web/src/pages/Assistant.tsx');
beforeEach(async () => {
  vi.resetModules();
  stubBrowser();
  screen.wide = true;
  ({ Project } = await import('../web/src/pages/Project.tsx'));
  A = await import('../web/src/pages/Assistant.tsx');
});
afterEach(() => vi.unstubAllGlobals());

const project = (key: string, disabled = false): ProjectSummary => ({
  id: key.length, key, name: `${key} project`, description: '', default_force_plan: false, importance_scale: [], effort_scale: [], github_account: null, claude_account: null, claude_allowed: null,
  color: null, icon: null, worker_id: null, placement_md: '', disabled, disabled_at: disabled ? '2026-01-02T00:00:00Z' : null, disabled_by: disabled ? 'owner' : null,
  created_at: '2026-01-01T00:00:00Z', muted: false, repos: [],
});
const header = (p: ProjectSummary) => {
  const qc = new QueryClient();
  qc.setQueryData(['project', p.key], p);
  const html = renderPage(createElement(Project), { qc, path: `/p/${p.key}?tab=backlog`, route: '/p/:key' });
  return html.slice(0, html.indexOf('</header>'));
};
const askButton = (html: string) => html.match(/<button[^>]*aria-label="Ask the Assistant about [^"]*"[^>]*>.*?<\/button>/)?.[0];

describe('Ask the Assistant about a project (DISP-84)', () => {
  it('the project header has an Ask button named for the project, next to Plan', () => {
    const h = header(project('HC'));
    expect(askButton(h)).toContain('aria-label="Ask the Assistant about HC"');
    expect(textOf(askButton(h)!)).toBe('Ask');
    expect(h.indexOf('Plan with Claude')).toBeLessThan(h.indexOf('Ask the Assistant about HC'));
  });

  it('is on the phone layout too (the icon, with the same name)', () => {
    screen.wide = false;
    const h = header(project('HC'));
    expect(askButton(h)).toBeTruthy();
    expect(h.indexOf('Plan with Claude')).toBeLessThan(h.indexOf('Ask the Assistant about HC'));
  });

  it('a locked project has the button too: the Assistant can unlock it', () => {
    const h = header(project('LK', true));
    expect(askButton(h)).toContain('Ask the Assistant about LK');
    expect(h).toContain('aria-label="Project locked"');
  });

  it('the link fills the new chat with the tag; an unknown key gives a notice and an empty box; a locked one, a notice', () => {
    const list = [project('HC'), project('LK', true)];
    expect(A.assistantLink('HC', list)).toEqual({ prefill: '@HC ', notice: null });
    expect(A.assistantLink('hc', list)).toEqual({ prefill: '@HC ', notice: null });
    expect(A.assistantLink('NOPE', list)).toEqual({ prefill: '', notice: 'Project NOPE was not found.' });
    expect(A.assistantLink('LK', list)).toEqual({ prefill: '@LK ', notice: 'LK is locked (read-only). The Assistant can unlock it if you ask.' });
  });

  it('the new chat shows the tag as a chip in its box, before anything is sent', () => {
    const html = renderPage(createElement(A.EmptyChat, { projects: [project('HC')], prefill: '@HC ' }));
    expect(html.match(/<textarea[^>]*>([^<]*)<\/textarea>/)![1]).toBe('@HC ');
    expect(html.match(/data-chip="[A-Z]+"/g)).toEqual(['data-chip="HC"']);
  });

  it('a reload (no link) opens the Assistant with an empty box and no notice', () => {
    const qc = new QueryClient();
    qc.setQueryData(['assistant'], { session_id: null, unread: 0, last_seq: 0 });
    qc.setQueryData(['projects'], [project('HC')]);
    const html = renderPage(createElement(A.Assistant), { qc, path: '/assistant' });
    expect(html.match(/<textarea[^>]*>([^<]*)<\/textarea>/)![1]).toBe('');
    expect(html).not.toContain('data-chip');
    expect(html).not.toContain('role="status"');
  });
});
