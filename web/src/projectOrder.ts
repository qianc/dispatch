// The one order of projects, in the desktop menu and on the projects page (DISP-79): by name, A to Z,
// so a project is always in the same place. Opening a project does not move it.

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export function byName<T extends { name: string; key: string }>(projects: readonly T[]): T[] {
  return [...projects].sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.key, b.key));
}
