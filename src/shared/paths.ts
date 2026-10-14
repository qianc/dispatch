// Link helpers shared by the web app (and tested in node).

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to dashes. */
export function slug(text: string) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/** Join a relative link onto a folder ('' = repo root); '..' cannot climb above the root. */
export function joinPath(base: string, rel: string) {
  const parts = base ? base.split('/') : [];
  for (const p of rel.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return parts.join('/');
}

export const dirOf = (path: string) => path.split('/').slice(0, -1).join('/');
