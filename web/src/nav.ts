// Navigation memory for the phone UI: which screen each bottom tab was last on, and where each
// screen was scrolled to. Kept in sessionStorage so it survives reloads but not a fresh launch.

export const TABS = ['/', '/activity', '/assistant', '/projects', '/settings'] as const;
export type Tab = (typeof TABS)[number];

const read = <T,>(key: string, fallback: T): T => {
  try {
    return { ...fallback, ...JSON.parse(sessionStorage.getItem(key) ?? '{}') };
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or blocked: memory only
  }
};

/** The tab a top-level path belongs to; null for inner screens (items, sessions, files, ...). */
export function rootTab(pathname: string): Tab | null {
  if (pathname === '/') return '/';
  return TABS.find((t) => t !== '/' && pathname === t) ?? null;
}

const state = read<{ current: Tab; last: Partial<Record<Tab, string>>; entries: Record<string, Tab> }>('dispatch:tabs', { current: '/', last: {}, entries: {} });

/** History entries remembered (oldest dropped first). */
const MAX_ENTRIES = 200;

/**
 * Call on every navigation; returns the tab the screen belongs to, which the menu highlights.
 * Inner screens belong to whichever tab you were in, and to that tab only: if another tab still
 * remembers the same screen, it forgets it (otherwise tapping that tab would "go" to the screen
 * you are already on and seem dead).
 *
 * `tab`: the tab that was tapped to get here (a tab can reopen an inner screen it remembers).
 * `key`: the history entry, which keeps its tab, so back and forward highlight the right one.
 */
export function trackLocation(pathname: string, search: string, opts: { key?: string; tab?: Tab } = {}): Tab {
  const here = pathname + search;
  const remembered = opts.key ? state.entries[opts.key] : undefined;
  const tab = rootTab(pathname) ?? (pathname.startsWith('/p/') ? '/projects' : opts.tab ?? remembered ?? state.current);
  state.current = tab;
  state.last[tab] = here;
  for (const t of TABS) if (t !== tab && state.last[t] === here) delete state.last[t];
  if (opts.key) {
    delete state.entries[opts.key];
    state.entries[opts.key] = tab; // newest last
    const keys = Object.keys(state.entries);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete state.entries[k];
  }
  write('dispatch:tabs', state);
  return tab;
}

/** Where tapping a tab goes: back to where you were, or to its top when you are already in it or already there. */
export function tabTarget(tab: Tab, here: string): string {
  const last = state.last[tab];
  return state.current === tab || !last || last === here ? tab : last;
}

const scroll = read<Record<string, number>>('dispatch:scroll', {});

export function saveScroll(key: string, top: number) {
  scroll[key] = top;
  write('dispatch:scroll', scroll);
}

export function savedScroll(key: string): number {
  return scroll[key] ?? 0;
}

// Recently opened projects (for the desktop sidebar), newest first. Kept on this device.
const RECENT = 'dispatch:recent-projects';

export function recentProjects(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? '[]');
  } catch {
    return [];
  }
}

export function noteProject(key: string) {
  const next = [key, ...recentProjects().filter((k) => k !== key)].slice(0, 8);
  try {
    localStorage.setItem(RECENT, JSON.stringify(next));
  } catch {
    // storage blocked: no recents
  }
  window.dispatchEvent(new Event('dispatch:recent'));
}
