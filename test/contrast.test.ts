// The colour roles in web/src/styles.css must stay readable in both themes (WCAG AA: 4.5 for text).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8');

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no ${selector}`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2].toLowerCase()]));
}

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (h: string) => {
  const [r, g, b] = rgb(h).map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** `fg` at `alpha` over `bg` (what bg-x/15 looks like). */
const over = (fg: string, bg: string, alpha: number) =>
  '#' + rgb(fg).map((f, i) => Math.round(f * alpha + rgb(bg)[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');

const dark = tokens('@theme');
const light = tokens(":root[data-theme='light']");
const autoLight = tokens(':root:not([data-theme])');
const TEXT = ['fg', 'muted', 'faint', 'accent', 'wait', 'ok', 'bad', 'run'];
const STATUS = ['wait', 'ok', 'bad', 'run'];

describe.each([['dark', dark], ['light', light]] as const)('%s theme', (_name, t) => {
  it('every text colour reads on every surface', () => {
    const fails: string[] = [];
    for (const surface of ['bg', 'panel', 'raised']) {
      for (const text of TEXT) if (contrast(t[text], t[surface]) < 4.5) fails.push(`${text} on ${surface}: ${contrast(t[text], t[surface]).toFixed(2)}`);
    }
    expect(fails).toEqual([]);
  });

  it('text on filled buttons and badges reads', () => {
    const fails: string[] = [];
    if (contrast(t['on-accent'], t['accent-strong']) < 4.5) fails.push(`on-accent on accent-strong: ${contrast(t['on-accent'], t['accent-strong']).toFixed(2)}`);
    for (const s of STATUS) if (contrast(t['on-status'], t[s]) < 4.5) fails.push(`on-status on ${s}: ${contrast(t['on-status'], t[s]).toFixed(2)}`);
    expect(fails).toEqual([]);
  });

  it('status and accent text read on their own soft tint (chips)', () => {
    const fails: string[] = [];
    for (const s of [...STATUS, 'accent']) {
      const tint = over(t[s], t.panel, 0.15);
      if (contrast(t[s], tint) < 4.5) fails.push(`${s} on its tint: ${contrast(t[s], tint).toFixed(2)}`);
    }
    if (contrast(t.fg, t['accent-soft']) < 4.5) fails.push('fg on accent-soft');
    expect(fails).toEqual([]);
  });

  it('surfaces step apart enough to see cards without borders', () => {
    expect(contrast(t.panel, t.bg)).toBeGreaterThanOrEqual(1.1);
    expect(contrast(t.line, t.panel)).toBeGreaterThanOrEqual(1.4);
  });
});

it('the light theme is the same whether chosen or automatic', () => {
  expect(autoLight).toEqual(light);
});
