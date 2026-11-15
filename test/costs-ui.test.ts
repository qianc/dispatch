// DISP-16: what the cost and time screens show, and how they write money and run time.
import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllCosts, ProjectCosts } from '../src/shared/types.ts';
import { countOf, perItem, runTime, usd } from '../web/src/cost.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

vi.mock('../web/src/wide.ts', () => ({ useWide: () => false, useVeryWide: () => false }));

describe('money and run time as text', () => {
  it('writes money with two decimals', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(3.456)).toBe('$3.46');
    expect(usd(120)).toBe('$120.00');
  });

  it('writes run time in the largest unit that fits', () => {
    expect(runTime(0)).toBe('0 s');
    expect(runTime(42_400)).toBe('42 s');
    expect(runTime(59_600)).toBe('1 min');
    expect(runTime(12 * 60_000)).toBe('12 min');
    expect(runTime(59 * 60_000 + 40_000)).toBe('1 h 00 min');
    expect(runTime(3 * 3_600_000 + 5 * 60_000)).toBe('3 h 05 min');
  });

  it('counts, and gives the average per item', () => {
    expect(countOf(1, 'item')).toBe('1 item');
    expect(countOf(3, 'session')).toBe('3 sessions');
    expect(perItem({ cost_usd: 9, duration_ms: 30 * 60_000, items: 3 })).toBe('avg $3.00 and 10 min per item');
    expect(perItem({ cost_usd: 0, duration_ms: 0, items: 0 })).toBe('');
  });
});

const PROJECT: ProjectCosts = {
  total: { cost_usd: 10, duration_ms: 3_600_000, sessions: 4, items: 2 },
  unlinked: { cost_usd: 1, duration_ms: 60_000, sessions: 1, items: 0 },
  items: [
    { id: 1, key: 'HC-1', title: 'Slow export', type: 'bug', labels: ['perf', 'ui'], cost_usd: 6, duration_ms: 600_000, sessions: 2, items: 1 },
    { id: 2, key: 'HC-2', title: 'Dark mode', type: 'backlog', labels: [], cost_usd: 3, duration_ms: 2_940_000, sessions: 1, items: 1 },
  ],
  by_type: [
    { name: 'bug', cost_usd: 6, duration_ms: 600_000, sessions: 2, items: 1 },
    { name: 'backlog', cost_usd: 3, duration_ms: 2_940_000, sessions: 1, items: 1 },
  ],
  by_tag: [
    { name: 'perf', cost_usd: 6, duration_ms: 600_000, sessions: 2, items: 1 },
    { name: 'ui', cost_usd: 6, duration_ms: 600_000, sessions: 2, items: 1 },
    { name: null, cost_usd: 3, duration_ms: 2_940_000, sessions: 1, items: 1 },
  ],
};

describe('the cost and time screens (DISP-16)', () => {
  let pages: typeof import('../web/src/pages/Costs.tsx');
  beforeEach(async () => {
    stubBrowser();
    pages = await import('../web/src/pages/Costs.tsx');
  });

  const project = (search = '', days = '') => {
    const qc = new QueryClient();
    qc.setQueryData(['costs', 'HC', days], PROJECT);
    return textOf(renderPage(createElement(pages.ProjectCostsPage), { qc, path: `/p/HC/costs${search}`, route: '/p/:key/costs' }));
  };

  it('a project: the total, each item with its share, and the sessions with no item', () => {
    const text = project();
    expect(text).toContain('Total $10.00 1 h 00 min 4 sessions · 2 items');
    expect(text).toContain('HC-1 Slow export $6.00 · 10 min Bug · perf, ui · 2 sessions');
    expect(text).toContain('HC-2 Dark mode $3.00 · 49 min Backlog · 1 session');
    expect(text).toContain('Not tied to an item $1.00 · 1 min');
    expect(text).toContain('gives each item an equal share');
    expect(text.indexOf('HC-1')).toBeLessThan(text.indexOf('HC-2'));
  });

  it('orders by run time when asked', () => {
    const text = project('?sort=time');
    expect(text.indexOf('HC-2')).toBeLessThan(text.indexOf('HC-1'));
  });

  it('by item type: each type with its average per item', () => {
    const text = project('?by=type');
    expect(text).toContain('Bugs $6.00 · 10 min 1 item · 2 sessions · avg $6.00 and 10 min per item');
    expect(text).toContain('Backlog items $3.00 · 49 min');
    expect(text).not.toContain('Slow export');
  });

  it('by tag: each tag, the items with no tag, and that tags can add up to more than the total', () => {
    const text = project('?by=tag&days=30', '30');
    expect(text).toContain('perf $6.00 · 10 min');
    expect(text).toContain('ui $6.00 · 10 min');
    expect(text).toContain('No tag $3.00 · 49 min');
    expect(text).toContain('can add up to more than the total');
  });

  it('a project with no sessions says so', () => {
    const qc = new QueryClient();
    const none = { cost_usd: 0, duration_ms: 0, sessions: 0, items: 0 };
    qc.setQueryData(['costs', 'HC', ''], { total: none, unlinked: none, items: [], by_type: [], by_tag: [] } satisfies ProjectCosts);
    const text = textOf(renderPage(createElement(pages.ProjectCostsPage), { qc, path: '/p/HC/costs', route: '/p/:key/costs' }));
    expect(text).toContain('No sessions in this period.');
  });

  it('all projects: each project with a link to its own view, and the sessions with no project', () => {
    const qc = new QueryClient();
    qc.setQueryData(['costs', 'all', '90'], {
      total: { cost_usd: 15, duration_ms: 7_200_000, sessions: 9, items: 5 },
      projects: [
        { id: 1, key: 'HC', name: 'Home Control', color: null, icon: null, cost_usd: 10, duration_ms: 3_600_000, sessions: 4, items: 2 },
        { id: 2, key: 'DK', name: 'Decks', color: null, icon: null, cost_usd: 4, duration_ms: 3_000_000, sessions: 3, items: 3 },
      ],
      unlinked: { cost_usd: 1, duration_ms: 600_000, sessions: 2, items: 0 },
    } satisfies AllCosts);
    const html = renderPage(createElement(pages.Costs), { qc, path: '/costs?days=90', route: '/costs' });
    const text = textOf(html);
    expect(text).toContain('Total $15.00 2 h 00 min 9 sessions · 5 items');
    expect(text).toContain('Home Control $10.00 · 1 h 00 min');
    expect(text).toContain('Not tied to a project $1.00 · 10 min 2 sessions · Assistant chats and orchestrators');
    expect(html).toContain('href="/p/HC/costs?days=90"');
  });
});
