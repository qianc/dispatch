// The message of the merge commit Dispatch writes (DISP-57). It names the items, not the branch:
// a branch name repeats the title as a slug, and a repo's pre-push hook may refuse a word in it.

/** `Merge DISP-5, DISP-6: <title>`; the title loses the keys it already starts with. */
export function mergeMessage(keys: string[], title: string) {
  if (!keys.length) return `Merge: ${title}`;
  let rest = title.trim();
  for (;;) {
    const k = keys.find((key) => rest.toLowerCase().startsWith(key.toLowerCase()) && !/\w/.test(rest[key.length] ?? ''));
    if (!k) break;
    rest = rest.slice(k.length).replace(/^[\s,:;·-]+/, '');
  }
  return rest ? `Merge ${keys.join(', ')}: ${rest}` : `Merge ${keys.join(', ')}`;
}

/**
 * The private words (one regex per line, as scripts/check-private.mjs reads them) taken out of a
 * merge message, so a hook that scans pushed commit messages for them lets the merge through.
 */
export function redactPrivate(message: string, patterns: string) {
  let out = message;
  for (const line of patterns.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
    let re: RegExp;
    try {
      re = new RegExp(line, 'gi');
    } catch {
      continue;
    }
    out = out.replace(re, (m) => (m ? '…' : m));
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

/** The private-patterns file check-private.mjs reads: DISPATCH_PRIVATE_PATTERNS, or the one in ~/.config/dispatch. */
export function privatePatternsFile(env: Record<string, string | undefined>, home: string) {
  return env.DISPATCH_PRIVATE_PATTERNS || `${home}/.config/dispatch/private-patterns`;
}
