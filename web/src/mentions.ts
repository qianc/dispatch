// @ project tags in the Assistant chat (DISP-82). The message stays plain text: a tag is `@KEY` of a
// known project, after a space or at the start (so `me@HC` is not one). It shows as a chip and is
// deleted as one unit. Pure functions, so the chat input and its tests share them.
import type { ProjectSummary } from './api.ts';

export type MentionProject = Pick<ProjectSummary, 'key' | 'name' | 'color' | 'icon'>;

const KEY = '[A-Z][A-Z0-9]{1,9}';
const TAG = new RegExp(`(^|[^\\w@])@(${KEY})(?![A-Za-z0-9_])`, 'g');

/** The `@query` the caret is in, if any: where its @ is, and what was typed after it. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[^\w@])@([A-Za-z0-9]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: m.index + m[1].length, query: m[2] };
}

/** The projects for a typed `@query`: by key, then by name; at most `max`. */
export function filterProjects<P extends MentionProject>(list: P[], query: string, max = 8): P[] {
  const q = query.toLowerCase();
  const rank = (p: P) => {
    const key = p.key.toLowerCase();
    const name = p.name.toLowerCase();
    if (key.startsWith(q)) return 0;
    if (name.startsWith(q)) return 1;
    if (name.split(/\s+/).some((w) => w.startsWith(q))) return 2;
    if (name.includes(q)) return 3;
    return -1;
  };
  return list
    .map((p) => ({ p, r: rank(p) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.p.key.localeCompare(b.p.key))
    .slice(0, max)
    .map((x) => x.p);
}

/** Choose a project for the `@query` at `start`: `@KEY ` in its place, the caret after it. */
export function insertMention(text: string, caret: number, start: number, key: string): { text: string; caret: number } {
  const rest = text.slice(caret);
  const tag = `@${key}${rest.startsWith(' ') ? '' : ' '}`;
  return { text: text.slice(0, start) + tag + rest, caret: start + tag.length + (rest.startsWith(' ') ? 1 : 0) };
}

/** The tag that ends right at the caret, if any (Backspace there deletes all of it). */
export function chipBefore(text: string, caret: number, keys: Set<string>): { start: number; end: number } | null {
  if (/[A-Za-z0-9_]/.test(text.charAt(caret))) return null;
  const m = new RegExp(`(^|[^\\w@])@(${KEY})$`).exec(text.slice(0, caret));
  if (!m || !keys.has(m[2])) return null;
  return { start: m.index + m[1].length, end: caret };
}

/** Backspace at the end of a tag: the text without it, and where the caret goes. */
export function deleteChip(text: string, caret: number, keys: Set<string>): { text: string; caret: number } | null {
  const c = chipBefore(text, caret, keys);
  return c ? { text: text.slice(0, c.start) + text.slice(c.end), caret: c.start } : null;
}

/** The keys of the known projects tagged in the text, once each, in order. */
export function taggedKeys(text: string, keys: Set<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TAG)) if (keys.has(m[2]) && !out.includes(m[2])) out.push(m[2]);
  return out;
}

/** The text in pieces: plain text, and the tags (with their key) to show as chips. */
export function segments(text: string, keys: Set<string>): { text: string; key?: string }[] {
  const out: { text: string; key?: string }[] = [];
  let at = 0;
  for (const m of text.matchAll(TAG)) {
    if (!keys.has(m[2])) continue;
    const start = m.index + m[1].length;
    if (start > at) out.push({ text: text.slice(at, start) });
    out.push({ text: `@${m[2]}`, key: m[2] });
    at = start + m[2].length + 1;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** Arrow keys in the list: the next or previous row, round the ends. */
export const moveActive = (i: number, delta: number, n: number) => (n ? (i + delta + n) % n : 0);
