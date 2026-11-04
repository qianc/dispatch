/**
 * Chat search under Activity (DISP-54): the words of a query, and a short piece of a message
 * around the first word it contains. Shared by the store (which picks the message) and the page
 * (which marks the words in it).
 */

/** The words of a query; "a quoted phrase" is one word. Lower case, at most 8. */
export function searchTerms(q: string): string[] {
  const terms: string[] = [];
  for (const m of q.matchAll(/"([^"]*)"|(\S+)/g)) {
    const t = (m[1] ?? m[2]).trim().replace(/\s+/g, ' ').toLowerCase();
    if (t && !terms.includes(t)) terms.push(t);
  }
  return terms.slice(0, 8);
}

/** About `size` characters of `text` around the first term it contains, on one line. */
export function snippetOf(text: string, terms: string[], size = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  let start = Math.max(0, at - Math.floor(size / 3));
  // start at a word, not in the middle of one
  if (start > 0) { const sp = flat.indexOf(' ', start); if (sp >= 0 && sp < at) start = sp + 1; }
  const end = Math.min(flat.length, start + size);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** `text` in parts, with the parts that match a term marked. */
export function markTerms(text: string, terms: string[]): { text: string; hit: boolean }[] {
  const words = terms.filter(Boolean).sort((a, b) => b.length - a.length);
  if (!words.length) return [{ text, hit: false }];
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).filter(Boolean).map((part) => ({ text: part, hit: words.includes(part.toLowerCase()) }));
}
