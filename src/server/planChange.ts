// DISP-119: which changes of an approved plan the orchestrator may make by itself, and which wait
// for the owner. The orchestrator says what kind of minor change it makes; these checks hold it to
// that, on the plan's structure, whatever its prompt says. What they cannot see (the code a step
// changes) is held by the step's prompt, and every change is logged for the owner.
import type { MinorChange, OrchestrationStep } from '../shared/types.ts';

/** A step of a plan as set_plan / amend_plan give it, checked: `after` holds places in the list, from 1. */
export interface NextStep {
  id?: number;
  title: string;
  project_id: number;
  prompt_md: string;
  item_ids: number[];
  after: number[];
  optional: boolean;
  worker?: string | null;
}

export const CHANGE_WORDS: Record<MinorChange['kind'], string> = {
  fix_blocker: 'a step that fixes a blocker',
  reorder: 'steps in another order',
  reword: 'new wording',
  split: 'a step split in parts',
};

export const TOUCH_WORDS: Record<NonNullable<MinorChange['touches']>[number], string> = {
  dependency_pins: 'dependency pins',
  lockfiles: 'lockfiles',
  ci_config: 'CI config',
  test_config: 'test config',
};

const sameSet = (a: Iterable<unknown>, b: Iterable<unknown>) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

/** Every step a step waits for, directly or through others. */
function ancestors(deps: Map<string, string[]>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const visit = (k: string): Set<string> => {
    const known = out.get(k);
    if (known) return known;
    const all = new Set<string>();
    out.set(k, all); // the plans are checked for circles before this
    for (const d of deps.get(k) ?? []) {
      all.add(d);
      for (const a of visit(d)) all.add(a);
    }
    return all;
  };
  for (const k of deps.keys()) visit(k);
  return out;
}

/** Keys that name a step in both plans: `s<id>` for a step that exists, `n<place>` for a new one. */
const keyOf = (st: NextStep, i: number) => (st.id !== undefined ? `s${st.id}` : `n${i + 1}`);

function oldAncestors(old: OrchestrationStep[]) {
  return ancestors(new Map(old.map((s) => [`s${s.id}`, s.depends_on.map((d) => `s${d}`)])));
}

function nextAncestors(next: NextStep[]) {
  const keys = next.map(keyOf);
  return ancestors(new Map(next.map((s, i) => [keys[i], s.after.map((n) => keys[n - 1])])));
}

/**
 * The pending steps of the running plan that a proposed plan changes: removed, given other work, or
 * made to wait for something else. They do not start until the owner answers; the rest goes on.
 */
export function heldByProposal(old: OrchestrationStep[], next: NextStep[]): number[] {
  const before = oldAncestors(old);
  const after = nextAncestors(next);
  const byId = new Map(next.flatMap((s) => (s.id !== undefined ? [[s.id, s] as const] : [])));
  return old.filter((o) => {
    if (o.state !== 'pending') return false;
    const n = byId.get(o.id);
    if (!n) return true;
    return n.title !== o.title || n.prompt_md !== o.prompt_md || n.project_id !== o.project_id || n.optional !== o.optional || (n.worker ?? null) !== o.worker
      || !sameSet(n.item_ids, o.item_ids) || !sameSet(before.get(`s${o.id}`)!, after.get(`s${o.id}`)!);
  }).map((o) => o.id);
}

/**
 * Why a change is not the minor change it says it is, or null when it is. The reason names the
 * rule, so the orchestrator can tell the owner what it asks for.
 */
export function minorProblem(old: OrchestrationStep[], next: NextStep[], change: MinorChange): string | null {
  const byId = new Map(old.map((s) => [s.id, s]));
  const kept = next.flatMap((s) => (s.id !== undefined ? [s] : []));
  const added = next.map((s, i) => ({ s, key: keyOf(s, i) })).filter((x) => x.s.id === undefined);
  const removed = old.filter((o) => !kept.some((k) => k.id === o.id));
  const name = (o: OrchestrationStep) => `step ${o.position} ("${o.title}")`;

  // what each kind may add or remove
  let split: OrchestrationStep | undefined;
  if (change.kind === 'split') {
    if (removed.length !== 1 || added.length < 2) return 'a split replaces one step by two or more new steps, and changes nothing else';
    split = removed[0];
    if (split.state !== 'pending') return `${name(split)} has started: only a step that has not started can be split`;
    if (added.some((a) => a.s.project_id !== split!.project_id)) return `the parts of ${name(split)} must stay in its project`;
    const parts = added.flatMap((a) => a.s.item_ids);
    if (parts.length !== new Set(parts).size || !sameSet(parts, split.item_ids)) return `the parts of ${name(split)} must share out its items, each one once, and add none`;
    if (added.some((a) => a.s.optional) && !split.optional) return `${name(split)} is not optional: its parts cannot be`;
  } else if (removed.length) {
    return `it removes ${removed.map(name).join(', ')}`;
  } else if (change.kind === 'fix_blocker') {
    if (added.length !== 1) return 'a blocker fix adds exactly one step';
    if (!change.touches?.length) return 'say what the fix touches (only dependency pins, lockfiles, CI config or test config)';
    if (!change.verification) return 'say how the fix is verified (the check its batch runs and that must pass)';
    const fix = added[0].s;
    if (fix.optional) return 'a blocker fix cannot be optional';
    if (!old.some((o) => o.project_id === fix.project_id)) return 'the fix works in a project no step of the plan works in';
    if (change.unblocks !== undefined && !byId.has(change.unblocks)) return `there is no step ${change.unblocks} to unblock`;
  } else if (added.length) {
    return `it adds ${added.length === 1 ? 'a step' : `${added.length} steps`}`;
  }

  // the steps that stay keep their work
  const started = old.filter((o) => o.state !== 'pending');
  for (const n of kept) {
    const o = byId.get(n.id!)!;
    if (n.project_id !== o.project_id) return `${name(o)} moves to another project`;
    if (!sameSet(n.item_ids, o.item_ids)) return `the items of ${name(o)} change`;
    if (n.optional !== o.optional) return `${name(o)} becomes ${n.optional ? 'optional' : 'required'}`;
    if ((n.worker ?? null) !== o.worker) return `${name(o)} moves to another worker`;
    const reworded = n.title !== o.title || n.prompt_md !== o.prompt_md;
    if (reworded && change.kind !== 'reword') return `the wording of ${name(o)} changes: that is a separate reword`;
    if (n.prompt_md !== o.prompt_md && o.state !== 'pending') return `${name(o)} has started: its batch has its prompt already`;
  }
  // started steps keep their order: only steps that have not started move
  const order = (ids: number[]) => ids.filter((id) => started.some((s) => s.id === id));
  if (order(old.map((o) => o.id)).join() !== order(kept.map((k) => k.id!)).join()) return 'steps that have started change their order';

  // what waits for what: the same, except that the steps that waited for the split step wait for
  // its parts, and the steps that already waited for the blocked step may wait for its fix
  const before = oldAncestors(old);
  const after = nextAncestors(next);
  const isNew = (k: string) => k.startsWith('n');
  for (const n of kept) {
    const o = byId.get(n.id!)!;
    const was = [...before.get(`s${o.id}`)!].filter((k) => k !== `s${split?.id}`);
    const now = [...after.get(`s${o.id}`)!];
    if (!sameSet(was, now.filter((k) => !isNew(k)))) return `the steps ${name(o)} waits for change (the order of the work must stay as it was)`;
    const waitsOnNew = now.some(isNew);
    if (!waitsOnNew) continue;
    const allowed = split ? before.get(`s${o.id}`)!.has(`s${split.id}`)
      : change.kind === 'fix_blocker' && change.unblocks !== undefined && (o.id === change.unblocks || before.get(`s${o.id}`)!.has(`s${change.unblocks}`));
    if (!allowed) return `${name(o)} would wait for the new step: it does not wait for ${change.kind === 'fix_blocker' ? 'the step the fix unblocks' : 'that work'} now, so this would hold independent work`;
  }
  // DISP-205: each part waits for what the split step waited for, and each step that waited for
  // the split step waits for every part
  if (split) {
    const own = before.get(`s${split.id}`)!;
    for (const a of added) {
      const outside = [...after.get(a.key)!].filter((k) => !isNew(k));
      if (!sameSet(outside, own)) return `a part of ${name(split)} must wait for the steps it waited for, and no others`;
    }
    for (const n of kept) {
      if (!before.get(`s${n.id}`)!.has(`s${split.id}`)) continue;
      if (!added.every((a) => after.get(`s${n.id}`)!.has(a.key))) return `${name(byId.get(n.id!)!)} waited for ${name(split)}: it must wait for all of its parts`;
    }
  }
  return null;
}

/** What a change does, in a line for the plan's history or for the owner's approval. */
export function describeChange(old: OrchestrationStep[], next: NextStep[], change?: MinorChange): string {
  const byId = new Map(old.map((s) => [s.id, s]));
  const added = next.map((s, i) => ({ s, place: i + 1 })).filter((x) => x.s.id === undefined);
  const removed = old.filter((o) => !next.some((n) => n.id === o.id));
  const parts: string[] = [];
  if (change?.kind === 'split' && removed[0]) {
    parts.push(`split step ${removed[0].position} "${removed[0].title}" into ${added.map((a) => `step ${a.place} "${a.s.title}"`).join(', ')}`);
  } else {
    for (const r of removed) parts.push(`removes step ${r.position} "${r.title}"`);
    for (const a of added) parts.push(`adds step ${a.place} "${a.s.title}"`);
  }
  const before = oldAncestors(old);
  const after = nextAncestors(next);
  next.forEach((n, i) => {
    const o = n.id !== undefined ? byId.get(n.id) : undefined;
    if (!o) return;
    const what = [
      n.title !== o.title ? `renamed to "${n.title}"` : '',
      n.prompt_md !== o.prompt_md ? 'reworded' : '',
      n.project_id !== o.project_id ? 'moved to another project' : '',
      !sameSet(n.item_ids, o.item_ids) ? 'other items' : '',
      n.optional !== o.optional ? (n.optional ? 'optional now' : 'required now') : '',
      (n.worker ?? null) !== o.worker ? `on worker ${n.worker ?? 'default'}` : '',
      !sameSet(before.get(`s${o.id}`)!, after.get(`s${o.id}`)!) ? 'waits for other steps' : '',
      i + 1 !== o.position ? `now at place ${i + 1}` : '',
    ].filter(Boolean);
    if (what.length) parts.push(`step ${o.position} "${o.title}": ${what.join(', ')}`);
  });
  if (change?.kind === 'fix_blocker' && change.touches?.length) parts.push(`touches only ${change.touches.map((t) => TOUCH_WORDS[t]).join(', ')}`);
  return parts.join('; ') || 'no change in the steps';
}
