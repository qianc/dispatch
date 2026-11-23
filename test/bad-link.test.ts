// DISP-223: a markdown link with a bad % escape must not crash the page, and a page that does
// throw shows its error inside the Layout, with the tab bar.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from 'react-router';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

// the phone layout: the tab bar at the bottom, no sidebar
vi.mock('../web/src/wide.ts', () => ({ useWide: () => false, useVeryWide: () => false }));

beforeAll(stubBrowser);

describe('links with a bad % escape (DISP-223)', () => {
  it('safeDecode keeps the text as it is when decodeURIComponent throws', async () => {
    const { safeDecode } = await import('../web/src/components/RichMd.tsx');
    expect(safeDecode('a%20b')).toBe('a b');
    expect(safeDecode('a%zz')).toBe('a%zz');
    expect(safeDecode('50%of')).toBe('50%of');
  });

  it('RichMd renders [x](a%zz) and [x](#50%of) without throwing', async () => {
    const { RichMd } = await import('../web/src/components/RichMd.tsx');
    const md = '[rel](a%zz) and [anchor](#50%of) and [ok](docs/a%20b.md)';
    const html = renderPage(createElement(RichMd, { ctx: { project: { id: 1, key: 'P' } }, children: md }));
    expect(textOf(html)).toBe('rel and anchor and ok');
    expect(html).toContain(`href="/files/P?path=${encodeURIComponent('a%zz')}"`);
    expect(html).toContain(`href="/files/P?path=${encodeURIComponent('docs/a b.md')}"`);
  });
});

describe('a page that throws (DISP-223)', () => {
  it('shows the error inside the Layout, which keeps the tab bar', async () => {
    const { layoutRoute } = await import('../web/src/components/Layout.tsx');
    const routes = [layoutRoute([{ path: '/broken', loader: () => { throw new Error('URI malformed'); }, element: createElement('p', null, 'never') }])];
    const { query, dataRoutes } = createStaticHandler(routes);
    const context = await query(new Request('http://test/broken'));
    if (context instanceof Response) throw new Error('unexpected redirect');
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(StaticRouterProvider, { router: createStaticRouter(dataRoutes, context), context, hydrate: false })));
    expect(html).toContain('class="tabbar"');
    expect(html).toContain('role="alert"');
    expect(textOf(html)).toContain('This page could not be shown');
    expect(textOf(html)).toContain('URI malformed');
    expect(textOf(html)).not.toContain('never');
  });

  it('the app mounts its pages through layoutRoute', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync(new URL('../web/src/main.tsx', import.meta.url), 'utf8');
    expect(main).toMatch(/createBrowserRouter\(\[\s*layoutRoute\(\[/);
  });
});
