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

const state = read<{ current: Tab; last: Partial<Record<Tab, string>> }>('dispatch:tabs', { current: '/', last: {} });

/**
 * Call on every navigation. Inner screens belong to whichever tab you were in, and to that tab
 * only: if another tab still remembers the same screen, it forgets it (otherwise tapping that
 * tab would "go" to the screen you are already on and seem dead).
 */
export function trackLocation(pathname: string, search: string): Tab {
  const here = pathname + search;
  const tab = rootTab(pathname) ?? (pathname.startsWith('/p/') ? '/projects' : state.current);
  state.current = tab;
  state.last[tab] = here;
  for (const t of TABS) if (t !== tab && state.last[t] === here) delete state.last[t];
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
