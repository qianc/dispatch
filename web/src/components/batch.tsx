import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { DEFAULT_RUN_OPTIONS, runOptions, type RunOptions } from '../../../src/shared/types.ts';
import { api, type Item, type Project, type Repo, type Session } from '../api.ts';
import { Button, ErrorText, Field, Segmented, cx, inputCls } from './ui.tsx';
import { projectClaude, useAccounts } from '../accounts.ts';
import { useWorkers } from '../workers.ts';

const LABELS = {
  model: { default: 'Default', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' },
  effort: { default: 'Default', low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHigh', max: 'Max' },
  subagents: { auto: 'Claude decides', prefer: 'Prefer subagents', none: 'No subagents' },
  start: { now: 'Now, in parallel', after: 'After running ones' },
  auto_merge: { off: 'Leave for review', github: 'Auto-merge (GitHub)', local: 'Auto-merge (local)' },
} as const;

const opts = <K extends keyof typeof LABELS>(k: K) =>
  Object.entries(LABELS[k]).map(([value, label]) => ({ value: value as keyof (typeof LABELS)[K] & string, label }));

/** Last used run options per project, so the sheet opens with your usual choices. */
export function useRunOptions(projectKey: string) {
  const key = `dispatch:run:${projectKey}`;
  const [o, setO] = useState<RunOptions>(() => {
    try {
      return runOptions.parse(JSON.parse(localStorage.getItem(key) ?? '{}'));
    } catch {
      return DEFAULT_RUN_OPTIONS;
    }
  });
  const update = (patch: Partial<RunOptions>) => {
    const next = { ...o, ...patch };
    setO(next);
    localStorage.setItem(key, JSON.stringify(next));
  };
  return [o, update] as const;
}

export function RunOptionsFields({ value, set, project }: { value: RunOptions; set: (p: Partial<RunOptions>) => void; project?: Pick<Project, 'claude_account' | 'claude_allowed'> }) {
  const { data: accounts } = useAccounts();
  const { allowed, def } = project ? projectClaude(accounts, project) : { allowed: [], def: undefined };
  const chosen = value.claude_account && allowed.some((a) => a.name === value.claude_account) ? value.claude_account : '';
  return (
    <>
      {allowed.length > 1 && (
        <Field label="Claude account" group hint="Which subscription pays for this batch. Locked once the session starts.">
          <Segmented
            value={chosen}
            onChange={(v) => set({ claude_account: v || null })}
            options={[{ value: '', label: `Default · ${def?.label ?? ''}` }, ...allowed.filter((a) => a.name !== def?.name).map((a) => ({ value: a.name, label: a.label }))]}
          />
        </Field>
      )}
      <Field label="Model" group><Segmented value={value.model} onChange={(model) => set({ model })} options={opts('model')} /></Field>
      <Field label="Effort" group><Segmented value={value.effort} onChange={(effort) => set({ effort })} options={opts('effort')} /></Field>
      <Field label="Subagents for the implementation" group><Segmented value={value.subagents} onChange={(subagents) => set({ subagents })} options={opts('subagents')} /></Field>
      <Field label="Start" group hint={value.start === 'after' ? 'Waits until this project’s other agents have finished their turn.' : 'Starts alongside anything already running (as long as a session slot is free).'}>
        <Segmented value={value.start} onChange={(start) => set({ start })} options={opts('start')} />
      </Field>
      <Field label="When done" group hint={value.auto_merge !== 'off' ? 'Merges the PR when the agent is done, it is mergeable and every check passed. Otherwise you get a push saying why not.' : undefined}>
        <Segmented value={value.auto_merge} onChange={(auto_merge) => set({ auto_merge })} options={opts('auto_merge')} />
      </Field>
      {value.auto_merge !== 'off' && (
        <label className="flex items-start gap-2 mb-3 text-[14px]">
          <input type="checkbox" checked={value.base_check} onChange={(e) => set({ base_check: e.target.checked })} className="mt-0.5 size-4 accent-[var(--color-accent-strong)]" />
          <span>Update with main before merging<span className="block text-[12px] text-muted">If main moved on, the agent merges it into the branch and re-runs the affected tests first.</span></span>
        </label>
      )}
    </>
  );
}

/**
 * Which worker runs the batch. `proposed`: the planner's pick (a name) and why. Shown only when
 * there is more than one worker; a project with local repos runs where they are.
 */
export function WorkerField({ value, onChange, project, proposed }: {
  value: number | null;
  onChange: (id: number) => void;
  project: Pick<Project, 'worker_id'> & { repos?: Repo[] };
  proposed?: { name?: string; reason?: string };
}) {
  const { data } = useWorkers();
  const workers = data?.workers ?? [];
  if (workers.length < 2) return null;
  const local = project.repos?.find((r) => r.kind === 'local' && r.worker_id);
  const fallback = local?.worker_id ?? workers.find((w) => w.name === proposed?.name)?.id ?? project.worker_id ?? data?.default_worker_id ?? null;
  const chosen = workers.find((w) => w.id === (value ?? fallback));
  return (
    <Field label="Worker" group hint={local ? 'This project’s local repos are on this worker, so its sessions run there.' : proposed?.reason ? `Planner: ${proposed.reason}` : undefined}>
      <select className={inputCls} value={chosen?.id ?? ''} disabled={!!local} onChange={(e) => onChange(Number(e.target.value))} aria-label="Worker">
        {workers.map((w) => <option key={w.id} value={w.id}>{w.name}{w.connected ? '' : ' (offline)'}</option>)}
      </select>
      {chosen && !chosen.connected && <p className="text-[12px] text-wait mt-1">{chosen.name} is offline: the session waits until it connects.</p>}
    </Field>
  );
}

/** The worker a form will send: the one picked, else what the field shows by default. */
export function useChosenWorker(project: Pick<Project, 'worker_id'> & { repos?: Repo[] }, proposedName?: string) {
  const { data } = useWorkers();
  const [picked, setPicked] = useState<number | null>(null);
  const workers = data?.workers ?? [];
  const local = project.repos?.find((r) => r.kind === 'local' && r.worker_id);
  const id = local?.worker_id ?? picked ?? workers.find((w) => w.name === proposedName)?.id ?? project.worker_id ?? null;
  return [id, setPicked] as const;
}

/** Short summary of non-default options, for session headers and proposal cards. */
export function runOptionsSummary(o: RunOptions): string[] {
  const out: string[] = [];
  if (o.model !== 'default') out.push(LABELS.model[o.model]);
  if (o.effort !== 'default') out.push(`effort ${o.effort}`);
  if (o.subagents !== 'auto') out.push(LABELS.subagents[o.subagents].toLowerCase());
  if (o.start === 'after') out.push('after running ones');
  if (o.auto_merge !== 'off') out.push(o.auto_merge === 'github' ? 'auto-merge' : 'auto-merge locally');
  return out;
}

/** Start one session on these items: title, instructions, plan-first, and run options. */
export function BatchForm({ project, items, onStarted }: { project: Project & { repos: Repo[] }; items: Item[]; onStarted: (s: Session) => void }) {
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [forcePlan, setForcePlan] = useState(project.default_force_plan);
  const [options, setOptions] = useRunOptions(project.key);
  const [workerId, setWorkerId] = useChosenWorker(project);
  const start = useMutation({
    mutationFn: () => api.post<Session>(`/projects/${project.key}/batches`, { item_ids: items.map((i) => i.id), prompt, title: title || undefined, force_plan: forcePlan, options: { ...options, worker_id: workerId } }),
    onSuccess: onStarted,
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
      <p className="text-[13px] text-muted mb-3">One Claude session works through these items on one branch and opens one PR per changed repo.</p>
      <ul className="mb-3 space-y-1">
        {items.map((i) => <li key={i.id} className="text-[14px]"><span className="text-faint mr-2">{i.key}</span>{i.title}</li>)}
      </ul>
      <Field label="Title (optional)"><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={items.map((i) => i.key).join(', ')} /></Field>
      <Field label="Extra instructions"><textarea className={cx(inputCls, 'min-h-20')} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></Field>
      <label className="flex items-center gap-2 mb-4 text-[14px]">
        <input type="checkbox" checked={forcePlan} onChange={(e) => setForcePlan(e.target.checked)} className="size-4 accent-[var(--color-accent-strong)]" />
        Plan first (Claude writes a plan and waits for approval)
      </label>
      <WorkerField value={workerId} onChange={setWorkerId} project={project} />
      <RunOptionsFields value={options} set={setOptions} project={project} />
      {!project.repos.length && <p className="text-wait text-sm mb-2">Add a repo in Settings first.</p>}
      <ErrorText error={start.error} />
      <Button variant="primary" className="w-full" disabled={start.isPending || !project.repos.length}>Start session</Button>
    </form>
  );
}
