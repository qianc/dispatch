// Where a redirect may go: a path on Dispatch itself (server and web app, DISP-137).

/**
 * `to` when it is a path in Dispatch, else null. Not "//host", "/\host" or "/<tab>/host": browsers
 * read those as another site (they drop tabs and newlines, and take "\" for "/"), so any whitespace
 * or control character is refused and the path must resolve on `base`, Dispatch's own origin (the
 * server has none of its own: a placeholder does).
 */
export function safePath(to: string | undefined | null, base = 'http://x.invalid'): string | null {
  if (!to || !to.startsWith('/') || /[\s\x00-\x1f\x7f]/.test(to)) return null;
  let u: URL;
  try {
    u = new URL(to, base);
  } catch {
    return null;
  }
  return u.origin === new URL(base).origin ? u.pathname + u.search + u.hash : null;
}
