// The item export a repo's generate command reads at merge (DISP-56), e.g. to write backlog.md.
import type { Item } from './types.ts';

/** One item as the generate command sees it. `effort`: the project's scale label, else its index. */
export interface GeneratorItem {
  key: string;
  type: Item['type'];
  title: string;
  status: Item['status'];
  importance: number;
  effort: string | number | null;
  modules: string[];
  labels: string[];
  description: string;
}

/**
 * All of a project's items, with the merging batch's items done: the merge closes them, and the
 * generated files must already show that in the merge commit.
 */
export function generatorItems(items: Item[], effortScale: string[], closing: number[]): GeneratorItem[] {
  const done = new Set(closing);
  return items
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((i) => ({
      key: i.key,
      type: i.type,
      title: i.title,
      status: done.has(i.id) && i.status !== 'canceled' ? 'done' : i.status,
      importance: i.importance,
      effort: i.effort === null ? null : effortScale[i.effort] ?? i.effort,
      modules: i.modules,
      labels: i.labels,
      description: i.body_md,
    }));
}
