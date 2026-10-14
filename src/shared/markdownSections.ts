// Split a markdown document into sections by heading, keeping each section's text verbatim.

export interface MdSection {
  title: string;
  body: string;
  /** Headings above this one, outermost first (e.g. ["Open work", "S2 — visibly wrong"]). */
  ancestors: string[];
}

interface Heading { line: number; level: number; text: string }

function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  lines.forEach((l, i) => {
    const f = l.match(/^\s*(```|~~~)/);
    if (f) fence = fence === f[1] ? null : fence ?? f[1];
    if (fence) return;
    const m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) out.push({ line: i, level: m[1].length, text: m[2] });
  });
  return out;
}

/** Sections at `level` (default: the heading level 2–4 used most often, i.e. the item level). */
export function parseSections(text: string, level?: number): { level: number; sections: MdSection[] } {
  const lines = text.split(/\r?\n/);
  const hs = headings(lines);
  if (!level) {
    const counts = new Map<number, number>();
    for (const h of hs) if (h.level >= 2 && h.level <= 4) counts.set(h.level, (counts.get(h.level) ?? 0) + 1);
    level = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 2;
  }
  const sections: MdSection[] = [];
  const stack: Heading[] = [];
  hs.forEach((h, idx) => {
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    if (h.level === level) {
      const end = hs.slice(idx + 1).find((n) => n.level <= level!)?.line ?? lines.length;
      sections.push({ title: h.text, body: lines.slice(h.line + 1, end).join('\n').trim(), ancestors: stack.map((s) => s.text) });
    }
    stack.push(h);
  });
  return { level, sections };
}

/** Section counts per ancestor path, for a dry run. */
export function groupCounts(sections: MdSection[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sections) {
    const key = s.ancestors.slice(0, 2).join(' › ') || '(top level)';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

const tokenOf = (label: string) => label.trim().split(/\s+/)[0];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Guess importance (1–4) and effort (index) from a section using the project's own labels:
 * a bold label token in the first lines (**S2**, **L**) or an ancestor heading that starts with it.
 */
export function detectScales(s: MdSection, importanceScale: string[], effortScale: string[]): { importance: number | null; effort: number | null } {
  const head = s.body.split('\n').slice(0, 6).join('\n');
  const bold = (t: string) => new RegExp(`\\*\\*${escape(t)}\\*\\*`).test(head);
  // a label in the section's own text wins; otherwise the nearest heading above it
  let importance: number | null = null;
  const fromText = importanceScale.findIndex((label) => bold(tokenOf(label)) || bold(label));
  if (fromText >= 0) importance = fromText + 1;
  else {
    for (const a of [...s.ancestors].reverse()) {
      const i = importanceScale.findIndex((label) => new RegExp(`^${escape(tokenOf(label))}(\\b|\\s|$)`, 'i').test(a.trim()));
      if (i >= 0) {
        importance = i + 1;
        break;
      }
    }
  }
  let effort: number | null = null;
  effortScale.forEach((label, i) => {
    if (effort === null && bold(label)) effort = i;
  });
  return { importance, effort };
}
