// Orchestrations: the sheet that starts one, and the panel on its session page with the plan, the
// steps and what the owner can do with them.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_RUN_OPTIONS, type Attention, type OrchestratorDefaults, type Orchestration, type OrchestrationStep, type OrchPhase, type RunOptions, type Session, type StepState } from '../../../src/shared/types.ts';
import { api, type ProjectSummary, type SessionDetail } from '../api.ts';
import { STEP_LABEL, STEP_MARK, costText, doneCount, foldLive, isOpen, orchestrationProblem, parseLimit, partOfIndex, stepActions, stepRight } from '../orchestration.ts';
import { SessionRow } from './items.tsx';
import { RunOptionsFields, opts } from './batch.tsx';
import { Button, Chip, ErrorText, Field, Md, Segmented, Sheet, cx, inputCls } from './ui.tsx';

const PHASE: Record<OrchPhase, { label: string; tone: 'neutral' | 'wait' | 'ok' | 'run' }> = {
  plan: { label: 'Planning', tone: 'wait' },
  run: { label: 'Running', tone: 'run' },
  paused: { label: 'Paused', tone: 'neutral' },
  done: { label: 'Done', tone: 'ok' },
  stopped: { label: 'Stopped', tone: 'neutral' },
};
const STEP_TONE: Record<StepState, string> = { done: 'text-ok', running: 'text-run', review: 'text-wait', failed: 'text-bad', skipped: 'text-faint', pending: 'text-faint' };

/** Keep the session page and the lists in step with an orchestration the server just returned. */
function useOrchestrationAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api.post<Orchestration>(path, body ?? {}),
    onSuccess: (next) => {
      qc.setQueryData<SessionDetail>(['session', next.session_id], (d) => (d ? { ...d, orchestration: next } : d));
      void qc.invalidateQueries({ queryKey: ['orchestrations'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

/** The plan of an orchestration: its steps with state, and Approve, Pause and Stop. `mine`: the caller may act on it. */
export function OrchestrationPanel({ o, mine }: { o: Orchestration; mine: boolean }) {
  const act = useOrchestrationAction();
  const [menu, setMenu] = useState<OrchestrationStep | null>(null);
  const [stopping, setStopping] = useState(false);
  const [alsoChildren, setAlsoChildren] = useState(false);
  const [settings, setSettings] = useState(false);
  const open = isOpen(o);
  const base = `/orchestrations/${o.session_id}`;
  const planWaits = o.phase === 'plan' && o.steps.length > 0 && !o.plan_approved;
  const running = o.steps.filter((s) => s.child && ['queued', 'running', 'waiting_input'].includes(s.child.status)).length;
  const step = (path: 'skip' | 'retry') => {
    if (menu) act.mutate({ path: `/orchestration-steps/${menu.id}/${path}` });
    setMenu(null);
  };
  return (
    <section aria-label="Orchestration" className="rounded-xl border border-line bg-panel text-[14px]">
      <div className="px-3 py-2.5 border-b border-line">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted truncate">{o.project_keys.join(' · ')}</span>
          {o.steps.length > 0 && <span className="text-muted shrink-0">{doneCount(o)} of {o.steps.length} steps</span>}
          <Chip tone={PHASE[o.phase].tone}>{PHASE[o.phase].label}</Chip>
          {costText(o) && <span className="text-muted shrink-0 tabular-nums">{costText(o)}</span>}
          <span className="flex-1" />
          {mine && open && (o.phase === 'paused'
            ? <Button small disabled={act.isPending} onClick={() => act.mutate({ path: `${base}/resume` })}>Resume</Button>
            : <Button small disabled={act.isPending} onClick={() => act.mutate({ path: `${base}/pause` })}>Pause</Button>)}
          {mine && open && <Button small variant="danger" disabled={act.isPending} onClick={() => setStopping(true)}>Stop</Button>}
          {mine && open && <Button small variant="ghost" onClick={() => setSettings(true)}>Settings</Button>}
        </div>
        {o.waiting && <p className={cx('mt-1 text-[13px]', /failed|limit reached/.test(o.waiting) ? 'text-bad' : 'text-fg')}>{o.waiting}</p>}
        {o.next_wake && <p className="mt-0.5 text-[12px] text-muted">Wakes itself {new Date(o.next_wake).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>}
        {planWaits && mine && <Button variant="primary" className="w-full mt-2" disabled={act.isPending} onClick={() => act.mutate({ path: `${base}/approve`, body: { plan_version: o.plan_version } })}>Approve plan</Button>}
        {planWaits && <p className="mt-1.5 text-[12px] text-muted">Nothing starts before you approve. To change the plan, write to the orchestrator below.</p>}
        <ErrorText error={act.error} />
      </div>
      {o.steps.length ? (
        <ol>
          {o.steps.map((s) => {
            const actions = mine ? stepActions(s, o) : [];
            const right = stepRight(s, o);
            const body = (
              <>
                <span className={cx('block truncate', s.state === 'skipped' && 'text-muted line-through')}>{s.title}</span>
                <span className={cx('block truncate text-[12px]', s.state === 'failed' ? 'text-bad' : 'text-muted')}>{[s.item_keys.join(', '), right].filter(Boolean).join(' · ')}</span>
              </>
            );
            return (
              <li key={s.id} className="flex items-center gap-2 px-3 py-2 border-b border-line last:border-b-0">
                <span className={cx('w-4 shrink-0 text-center', STEP_TONE[s.state])} role="img" aria-label={STEP_LABEL[s.state]}>{STEP_MARK[s.state]}</span>
                <span className="w-4 shrink-0 text-right text-faint tabular-nums">{s.position}</span>
                <span className="shrink-0 text-faint">{s.project_key}</span>
                {s.child_session_id
                  ? <Link to={`/s/${s.child_session_id}`} className="flex-1 min-w-0 active:opacity-70">{body}</Link>
                  : <span className="flex-1 min-w-0">{body}</span>}
                {actions.length > 0 && <button type="button" className="shrink-0 size-8 rounded-lg text-muted hover:bg-raised" aria-label={`Step ${s.position} actions`} onClick={() => setMenu(s)}>⋯</button>}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="px-3 py-2.5 text-[13px] text-muted">No plan yet. It reads the projects first and asks you what is unclear.</p>
      )}
      {o.plan_md.trim() && (
        <details className="border-t border-line px-3 py-2 text-[13px]">
          <summary className="cursor-pointer text-muted">The plan in full</summary>
          <Md className="mt-2">{o.plan_md}</Md>
        </details>
      )}

      <Sheet open={!!menu} onClose={() => setMenu(null)} title={menu ? `Step ${menu.position}: ${menu.title}` : 'Step'}>
        {menu && (
          <div className="space-y-2">
            {stepActions(menu, o).includes('retry') && <Button variant="primary" className="w-full" onClick={() => step('retry')}>Retry as a new session</Button>}
            {stepActions(menu, o).includes('skip') && <Button className="w-full" onClick={() => step('skip')}>Skip this step</Button>}
            {menu.child_session_id && <Link to={`/s/${menu.child_session_id}`} className="block"><Button className="w-full">Open session #{menu.child_session_id}</Button></Link>}
            {stepActions(menu, o).includes('skip') && <p className="text-[12px] text-muted">Skipped: the steps after it start without it.</p>}
          </div>
        )}
      </Sheet>
      <Sheet open={settings} onClose={() => setSettings(false)} title="Orchestration settings">
        {settings && <OrchestrationSettings o={o} onDone={() => setSettings(false)} />}
      </Sheet>
      <Sheet open={stopping} onClose={() => setStopping(false)} title="Stop this orchestration?">
        <div className="space-y-3">
          <p className="text-[14px]">No more steps start. This cannot be undone: to go on later, start a new orchestration.</p>
          {running > 0 && (
            <label className="flex items-start gap-2 text-[14px]">
              <input type="checkbox" checked={alsoChildren} onChange={(e) => setAlsoChildren(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-accent-strong)]" />
              <span>Also stop the {running} running session{running === 1 ? '' : 's'}<span className="block text-[12px] text-muted">Their items go back to Todo. Left alone, they finish their work as usual.</span></span>
            </label>
          )}
          <Button variant="danger" className="w-full" onClick={() => { act.mutate({ path: `${base}/stop`, body: { stop_children: alsoChildren } }); setStopping(false); }}>Stop</Button>
        </div>
      </Sheet>
    </section>
  );
}

const useOrchestratorDefaults = () => useQuery({ queryKey: ['settings', 'orchestrator'], queryFn: () => api.get<OrchestratorDefaults>('/settings/orchestrator') });

/** Settings: the model and effort your new orchestrators start with. */
export function OrchestratorDefaults() {
  const qc = useQueryClient();
  const { data } = useOrchestratorDefaults();
  const save = useMutation({
    mutationFn: (patch: Partial<OrchestratorDefaults>) => api.put<OrchestratorDefaults>('/settings/orchestrator', patch),
    onSuccess: (next) => qc.setQueryData(['settings', 'orchestrator'], next),
  });
  return (
    <div className="mx-3">
      <p className="text-[13px] text-muted mb-2">The model and effort of the orchestrator itself, not of its batches. New orchestrations start with this; you can still pick another one when you start one. Default: the worker's own model.</p>
      <Field label="Model" group><Segmented value={data?.model ?? 'default'} onChange={(model) => save.mutate({ model })} options={opts('model')} /></Field>
      <Field label="Effort" group><Segmented value={data?.effort ?? 'default'} onChange={(effort) => save.mutate({ effort })} options={opts('effort')} /></Field>
      <ErrorText error={save.error} />
    </div>
  );
}

/** Keys of the projects a step works in: they cannot leave the scope. */
export const fixedProjects = (o: Pick<Orchestration, 'steps'>) => [...new Set(o.steps.map((s) => s.project_key))];

/** Limits and scope of a running orchestration. The orchestrator is told what changed. */
export function OrchestrationSettings({ o, onDone }: { o: Orchestration; onDone: () => void }) {
  const qc = useQueryClient();
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: () => api.get<ProjectSummary[]>('/projects') });
  const [max, setMax] = useState(o.max_children);
  const [limit, setLimit] = useState(o.cost_limit_usd === null ? '' : String(o.cost_limit_usd));
  const [answers, setAnswers] = useState(o.answer_children);
  const [keys, setKeys] = useState(o.project_keys);
  const fixed = fixedProjects(o);
  const amount = parseLimit(limit);
  const save = useMutation({
    mutationFn: () => api.patch<Orchestration>(`/orchestrations/${o.session_id}`, { max_children: max, cost_limit_usd: amount, answer_children: answers, project_keys: keys }),
    onSuccess: (next) => {
      qc.setQueryData<SessionDetail>(['session', next.session_id], (d) => (d ? { ...d, orchestration: next } : d));
      void qc.invalidateQueries({ queryKey: ['orchestrations'] });
      onDone();
    },
  });
  const toggle = (key: string) => setKeys((k) => (k.includes(key) ? k.filter((x) => x !== key) : [...k, key]));
  // a project in its scope stays listed also when it was disabled since
  const shown = projects.filter((p) => !p.disabled || o.project_keys.includes(p.key));
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (amount !== undefined) save.mutate(); }}>
      <Field label="Batches at once" group>
        <Segmented value={max} onChange={setMax} options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))} />
      </Field>
      <Field label="Cost limit ($)" hint={`Empty: no limit. It has used $${o.cost_usd.toFixed(2)}. At the limit it is paused: running sessions go on, no new step starts.`}>
        <input className={inputCls} inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="No limit" aria-label="Cost limit in dollars" />
      </Field>
      {amount === undefined && <p className="text-[13px] text-bad mb-3">Give an amount up to 10000, or leave it empty.</p>}
      <label className="flex items-start gap-2 mb-3 text-[14px]">
        <input type="checkbox" checked={answers} onChange={(e) => setAnswers(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-accent-strong)]" />
        <span>It answers its batches' questions<span className="block text-[12px] text-muted">Off: every question and plan of its batches comes to you.</span></span>
      </label>
      <Field label="Projects it may work in" group>
        <div className="flex flex-wrap gap-1.5">
          {shown.map((p) => {
            const locked = fixed.includes(p.key);
            return (
              <button key={p.key} type="button" role="checkbox" aria-checked={keys.includes(p.key)} disabled={locked} onClick={() => toggle(p.key)}
                className={cx('rounded-lg border px-2.5 h-8 text-[13px]', keys.includes(p.key) ? 'border-accent bg-accent/15 text-accent' : 'border-line-strong text-fg', locked && 'opacity-70')}>
                {p.key} <span className="text-muted">{p.name}{locked && ' (a step works here)'}</span>
              </button>
            );
          })}
        </div>
      </Field>
      <ErrorText error={save.error} />
      <Button type="submit" variant="primary" className="w-full" disabled={save.isPending || amount === undefined || !keys.length}>Save</Button>
    </form>
  );
}

/**
 * Activity's Live list: each orchestrator with its batches under it. Those that need the owner
 * show at once; the others are behind "N sessions".
 */
export function FoldedLive({ live, attention, orchestrations }: { live: Session[]; attention: ReadonlyMap<number, Attention>; orchestrations: Orchestration[] }) {
  const orchOf = new Map(orchestrations.map((o) => [o.session_id, o]));
  const partOf = partOfIndex(orchestrations);
  const row = (s: Session) => <SessionRow key={s.id} s={s} showProject attention={attention.get(s.id)} orch={orchOf.get(s.id)} partOf={partOf.get(s.id)} />;
  return (
    <>
      {foldLive(live, attention).map((r) => (
        <div key={r.s.id} className="border-b border-line last:border-b-0">
          {row(r.s)}
          {(r.needs.length > 0 || r.children.length > 0) && (
            <div className="ml-4 border-l border-line">
              {r.needs.map(row)}
              {r.children.length > 0 && (
                <details>
                  <summary className="cursor-pointer px-3 py-1.5 text-[12px] text-muted">{r.children.length} session{r.children.length === 1 ? '' : 's'}</summary>
                  {r.children.map(row)}
                </details>
              )}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/** "New orchestration": a goal, the projects it may touch, how many batches at once, and the run options of its batches. */
export function NewOrchestration() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="text-[12px] text-accent" onClick={() => setOpen(true)}>+ New orchestration</button>
      <Sheet open={open} onClose={() => setOpen(false)} title="New orchestration">
        {open && <NewOrchestrationForm onDone={() => setOpen(false)} />}
      </Sheet>
    </>
  );
}

export function NewOrchestrationForm({ onDone }: { onDone: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: () => api.get<ProjectSummary[]>('/projects') });
  const [goal, setGoal] = useState('');
  const [keys, setKeys] = useState<string[]>([]);
  const [max, setMax] = useState(2);
  const [answers, setAnswers] = useState(true);
  const [limit, setLimit] = useState('');
  const amount = parseLimit(limit);
  // the orchestrator's own model and effort: your default (Settings) until you pick here
  const { data: mine } = useOrchestratorDefaults();
  const [own, setOwn] = useState<Partial<OrchestratorDefaults>>({});
  const model = own.model ?? mine?.model ?? 'default';
  const effort = own.effort ?? mine?.effort ?? 'default';
  const [options, setOptions] = useState<RunOptions>(DEFAULT_RUN_OPTIONS);
  const start = useMutation({
    mutationFn: () => api.post<Orchestration>('/orchestrations', { goal, project_keys: keys, max_children: max, answer_children: answers, cost_limit_usd: amount ?? null, model, effort, options }),
    onSuccess: (o) => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      onDone();
      nav(`/s/${o.session_id}`);
    },
  });
  const problem = orchestrationProblem(goal, keys);
  const toggle = (key: string) => setKeys((k) => (k.includes(key) ? k.filter((x) => x !== key) : [...k, key]));
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!problem && amount !== undefined) start.mutate(); }}>
      <p className="text-[13px] text-muted mb-3">An orchestrator plans a larger goal as steps, over one or more projects. You approve the plan; then it starts each step as a batch and goes on by itself when one is merged.</p>
      <Field label="Goal" hint="What should be true at the end. It asks you about the rest.">
        <textarea className={cx(inputCls, 'min-h-28')} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Move sign-in to the new tokens in the app and the admin tool" aria-label="Goal" />
      </Field>
      <Field label="Projects it may work in" group>
        <div className="flex flex-wrap gap-1.5">
          {projects.filter((p) => !p.disabled).map((p) => (
            <button key={p.key} type="button" role="checkbox" aria-checked={keys.includes(p.key)} onClick={() => toggle(p.key)}
              className={cx('rounded-lg border px-2.5 h-8 text-[13px]', keys.includes(p.key) ? 'border-accent bg-accent/15 text-accent' : 'border-line-strong text-fg')}>
              {p.key} <span className="text-muted">{p.name}</span>
            </button>
          ))}
        </div>
      </Field>
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted mt-4 mb-2">The orchestrator itself</h3>
      <Field label="Model" group hint="It plans, starts the steps and answers its batches. Default: the worker's own model. Your usual choice is in Settings.">
        <Segmented value={model} onChange={(v) => setOwn((o) => ({ ...o, model: v }))} options={opts('model')} />
      </Field>
      <Field label="Effort" group><Segmented value={effort} onChange={(v) => setOwn((o) => ({ ...o, effort: v }))} options={opts('effort')} /></Field>
      <Field label="Batches at once" group hint="Steps that do not wait for each other can run at the same time.">
        <Segmented value={max} onChange={setMax} options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))} />
      </Field>
      <Field label="Cost limit ($)" hint="Empty: no limit. At the limit it is paused and you are told. You can change it while it runs.">
        <input className={inputCls} inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="No limit" aria-label="Cost limit in dollars" />
      </Field>
      {amount === undefined && <p className="text-[13px] text-bad mb-3">Give an amount up to 10000, or leave it empty.</p>}
      <label className="flex items-start gap-2 mb-3 text-[14px]">
        <input type="checkbox" checked={answers} onChange={(e) => setAnswers(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-accent-strong)]" />
        <span>It answers its batches' questions<span className="block text-[12px] text-muted">From the plan and what you told it, also their plans to approve. What it cannot settle comes to you. You see each answer in the batch and can overrule it.</span></span>
      </label>
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted mt-4 mb-2">Each step's batch</h3>
      <RunOptionsFields value={options} set={(p) => setOptions((o) => ({ ...o, ...p }))} />
      <ErrorText error={start.error} />
      <Button type="submit" variant="primary" className="w-full" disabled={!!problem || amount === undefined || start.isPending}>{problem ?? 'Start planning'}</Button>
    </form>
  );
}
