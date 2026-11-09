// Renders a web page or component to static HTML in node, for tests of what a screen shows.
// Queries do not run (no effects in a static render): seed the QueryClient with the data a page needs.
/// <reference path="../web/src/build.d.ts" />
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { vi } from 'vitest';

/** The browser globals the web modules touch while loading or rendering. */
export function stubBrowser() {
  const mq = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', { matchMedia: mq, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, history: { state: null } });
  vi.stubGlobal('location', { origin: 'http://test', pathname: '/', search: '', href: 'http://test/' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('__BUILD__', 'test');
}

/** `route`: the pattern the page is mounted at (for its params), e.g. `/p/:key`. */
export function renderPage(el: ReactElement, { qc = new QueryClient(), path = '/', route }: { qc?: QueryClient; path?: string; route?: string } = {}) {
  const routed = route ? createElement(Routes, null, createElement(Route, { path: route, element: el })) : el;
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, { initialEntries: [path] }, routed)));
}

/** The visible text of some HTML, tags dropped and the common entities decoded. */
export const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
