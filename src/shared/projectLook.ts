// Project colours and icons. Names are stored; the web app maps them to colours and outline icons.

/** Colours that read on both the light and the dark theme. */
export const PROJECT_COLORS = {
  indigo: '#6366f1',
  blue: '#3b82f6',
  cyan: '#06b6d4',
  teal: '#14b8a6',
  green: '#22a35a',
  lime: '#7cb518',
  amber: '#e5a00d',
  orange: '#f97316',
  red: '#ef4444',
  pink: '#ec4899',
  purple: '#a855f7',
} as const;
export type ProjectColor = keyof typeof PROJECT_COLORS;
export const PROJECT_COLOR_NAMES = Object.keys(PROJECT_COLORS) as ProjectColor[];

export const PROJECT_ICONS = [
  'slides', 'desktop', 'phone', 'globe', 'code', 'chart', 'database', 'layers', 'book', 'home',
  'bolt', 'flask', 'wrench', 'briefcase', 'camera', 'music', 'leaf', 'star', 'heart', 'shield',
] as const;
export type ProjectIcon = (typeof PROJECT_ICONS)[number];

/** Default colour: picked from the key, so projects differ before anyone chooses. */
export function defaultProjectColor(key: string): ProjectColor {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PROJECT_COLOR_NAMES[h % PROJECT_COLOR_NAMES.length];
}
