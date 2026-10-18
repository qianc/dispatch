// Dark / light / auto. The choice is kept on this device; index.html applies it before the app
// loads so there is no flash. Auto follows the system setting through CSS.

export type Theme = 'auto' | 'light' | 'dark';
const KEY = 'dispatch:theme';

export function getTheme(): Theme {
  const t = localStorage.getItem(KEY);
  return t === 'light' || t === 'dark' ? t : 'auto';
}

/** Status bar / browser chrome colour follows the header surface. */
function syncThemeColor() {
  const panel = getComputedStyle(document.documentElement).getPropertyValue('--color-panel').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', panel || '#1a1a1e');
}

export function setTheme(t: Theme) {
  if (t === 'auto') {
    localStorage.removeItem(KEY);
    delete document.documentElement.dataset.theme;
  } else {
    localStorage.setItem(KEY, t);
    document.documentElement.dataset.theme = t;
  }
  syncThemeColor();
}

export function initTheme() {
  setTheme(getTheme());
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', syncThemeColor);
}
