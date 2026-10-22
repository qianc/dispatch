import { beforeEach, describe, expect, it, vi } from 'vitest';

// the module keeps the tab memory in module state: load a fresh copy for each test
let nav: typeof import('../web/src/nav.ts');
beforeEach(async () => {
  vi.resetModules();
  nav = await import('../web/src/nav.ts');
});

describe('the highlighted menu tab (DISP-23)', () => {
  it('follows Activity when the tab reopens the chat it remembers', () => {
    // open a running session from Activity
    expect(nav.trackLocation('/activity', '', { key: 'a' })).toBe('/activity');
    expect(nav.trackLocation('/s/5', '', { key: 'b' })).toBe('/activity');
    // switch to Assistant
    expect(nav.trackLocation(nav.tabTarget('/assistant', '/s/5'), '', { key: 'c', tab: '/assistant' })).toBe('/assistant');
    // tap Activity again: it reopens the chat, and Activity is the highlighted tab
    const target = nav.tabTarget('/activity', '/assistant');
    expect(target).toBe('/s/5');
    expect(nav.trackLocation(target, '', { key: 'd', tab: '/activity' })).toBe('/activity');
  });

  it('back and forward keep the tab each screen was opened in', () => {
    nav.trackLocation('/activity', '', { key: 'a' });
    nav.trackLocation('/s/5', '', { key: 'b' });
    nav.trackLocation('/assistant', '', { key: 'c', tab: '/assistant' });
    // back from Assistant to the session opened from Activity
    expect(nav.trackLocation('/s/5', '', { key: 'b' })).toBe('/activity');
    expect(nav.trackLocation('/assistant', '', { key: 'c' })).toBe('/assistant');
  });

  it('a link inside a tab keeps that tab', () => {
    nav.trackLocation('/', '', { key: 'a' });
    expect(nav.trackLocation('/s/7', '', { key: 'b' })).toBe('/');
    expect(nav.trackLocation('/p/HC', '', { key: 'c' })).toBe('/projects');
  });
});
