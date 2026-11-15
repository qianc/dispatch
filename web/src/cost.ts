// How the cost and time view (DISP-16) writes money and run time.

export const usd = (n: number) => `$${n.toFixed(2)}`;

/** Agent working time: "42 s", "12 min", "3 h 05 min". */
export function runTime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

/** "1 item", "3 items" */
export const countOf = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** What one item of a group cost and took on average, e.g. "avg $2.22 and 16 min per item"; nothing for no items. */
export function perItem(t: { cost_usd: number; duration_ms: number; items: number }): string {
  return t.items > 0 ? `avg ${usd(t.cost_usd / t.items)} and ${runTime(t.duration_ms / t.items)} per item` : '';
}
