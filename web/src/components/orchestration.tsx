// Orchestrations: the sheet that starts one, and the panel on its session page with the plan, the
// steps and what the owner can do with them.
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_RUN_OPTIONS, type Attention, type NotifyOwner, type OrchestratorDefaults, type Orchestration, type OrchestrationStep, type OrchPhase, type RunOptions, type Session, type StepState } from '../../../src/shared/types.ts';
import { api, type ProjectSummary, type SessionDetail } from '../api.ts';
import { STEP_LABEL, STEP_MARK, changeLine, costText, doneCount, foldLive, isOpen, mergeHint, orchestrationProblem, parseLimit, partOfIndex, proposalLines, stepActions, stepRight } from '../orchestration.ts';
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
/** Who tells the owner about its batches (DISP-122). */
const NOTIFY_OPTIONS: { value: NotifyOwner; label: string }[] = [{ value: 'needs_you', label: 'Only what needs me' }, { value: 'all', label: 'Every batch' }];
const NOTIFY_HINT: Record<NotifyOwner, string> = {
  needs_you: 'Its batches send you nothing. It completes the ones that went to plan and tells you only of a decision, a failure it cannot fix or a blocker, several in one notification. What it handled is in its quiet log.',
  all: 'Every batch notifies you itself, as a session without an orchestrator does.',
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
        {/* a phone has no room for both in one row: the actions wrap to a row of their own */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-muted truncate">{o.project_keys.join(' · ')}</span>
            {o.steps.length > 0 && <span className="text-muted shrink-0">{doneCount(o)} of {o.steps.length} steps</span>}
            <Chip tone={PHASE[o.phase].tone}>{PHASE[o.phase].label}</Chip>
            {costText(o) && <span className="text-muted shrink-0 tabular-nums">{costText(o)}</span>}
          </div>
          {mine && open && (
            <div className="flex items-center gap-2 ml-auto shrink-0">
              {o.phase === 'paused'
                ? <Button small disabled={act.isPending} onClick={() => act.mutate({ path: `${base}/resume` })}>Resume</Button>
                : <Button small disabled={act.isPending} onClick={() => act.mutate({ path: `${base}/pause` })}>Pause</Button>}
              <Button small variant="danger" disabled={act.isPending} onClick={() => setStopping(true)}>Stop</Button>
              <Button small variant="ghost" onClick={() => setSettings(true)}>Settings</Button>
            </div>
          )}
        </div>
        {o.waiting && <p className={cx('mt-1 text-[13px]', /failed|limit reached/.test(o.waiting) ? 'text-bad' : 'text-fg')}>{o.waiting}</p>}
        {o.next_wake && <p className="mt-0.5 text-[12px] text-muted">Wakes itself {new Date(o.next_wake).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>}
        {planWaits && mine && <Button variant="primary" className="w-full mt-2" disabled={act.isPending} onClick={() => act.mutate({ path: `${base}/approve`, body: { plan_version: o.plan_version } })}>Approve plan</Button>}
        {planWaits && <p className="mt-1.5 text-[12px] text-muted">Nothing starts before you approve. To change the plan, write to the orchestrator below.</p>}
        {o.proposal && open && <ProposalCard o={o} mine={mine} act={(path) => act.mutate({ path: `${base}/${path}`, body: { plan_version: o.plan_version } })} busy={act.isPending} />}
        <ErrorText error={act.error} />
      </div>
      {o.steps.length ? (
        <ol>
          {o.steps.map((s) => {
            const actions = mine ? stepActions(s, o) : [];
            const right = stepRight(s, o);
            const body = (
              <>
                <span className={cx('block truncate', s.state === 'skipped' && 'text-muted line-through')}>{s.title}{s.optional && <span className="text-faint"> · optional</span>}{s.worker && <span className="text-faint"> · on {s.worker}</span>}</span>
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
      {o.changes.length > 0 && (
        <details className="border-t border-line px-3 py-2 text-[13px]">
          <summary className="cursor-pointer text-muted">Plan changes ({o.changes.length})</summary>
          <ol className="mt-2 space-y-2">
            {o.changes.map((c) => {
              const line = changeLine(c, o);
              return (
                <li key={c.id}>
                  <span className="block">{line.title}</span>
                  {line.detail.map((d) => <span key={d} className="block text-[12px] text-muted">{d}</span>)}
                  <span className="block text-[11px] text-faint">{new Date(c.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </li>
              );
            })}
          </ol>
        </details>
      )}
      {o.quiet_log.length > 0 && (
        <details className="border-t border-line px-3 py-2 text-[13px]">
          <summary className="cursor-pointer text-muted">Quiet log ({o.quiet_log.length})</summary>
          <p className="mt-1 text-[12px] text-faint">What it handled without notifying you.</p>
          <ol className="mt-2 space-y-2">
            {o.quiet_log.map((e) => (
              <li key={e.id}>
                <span className="block">{e.session_id ? <Link to={`/s/${e.session_id}`} className="text-accent">{e.text}</Link> : e.text}</span>
                <span className="block text-[11px] text-faint">{new Date(e.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </li>
            ))}
          </ol>
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

/** A change of the running plan that waits for the owner: what it changes, what it holds, what goes on now (DISP-119). */
function ProposalCard({ o, mine, act, busy }: { o: Orchestration; mine: boolean; act: (path: 'approve' | 'decline') => void; busy: boolean }) {
  const lines = proposalLines(o)!;
  return (
    <div className="mt-2 rounded-lg border border-wait/50 bg-wait/10 p-2.5">
      <p className="text-[13px] font-medium">A change of the plan waits for you</p>
      <p className="mt-1 text-[13px]">{o.proposal!.summary}</p>
      <p className="mt-1 text-[12px] text-muted">{lines.held} {lines.goes}</p>
      {o.proposal!.plan_md.trim() && o.proposal!.plan_md !== o.plan_md && (
        <details className="mt-1 text-[12px]"><summary className="cursor-pointer text-muted">Why</summary><Md className="mt-1">{o.proposal!.plan_md}</Md></details>
      )}
      {mine && (
        <div className="mt-2 flex gap-2">
          <Button className="flex-1" disabled={busy} onClick={() => act('decline')}>Decline</Button>
          <Button variant="primary" className="flex-1" disabled={busy} onClick={() => act('approve')}>Approve change</Button>
        </div>
      )}
    </div>
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
      <p className="text-[13px] text-muted mb-2">The model and effort of the orchestrator itself, not of its batches. New orchestrations start with this; you can still pick another one when you start one. Default: the server's default model (Settings → Default model).</p>
      <Field label="Model" group><Segmented value={data?.model ?? 'default'} onChange={(model) => save.mutate({ model })} options={opts('orchestratorModel')} /></Field>
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
  const [notify, setNotify] = useState(o.notify_owner);
  const [keys, setKeys] = useState(o.project_keys);
  const [merge, setMerge] = useState(o.options.auto_merge);
  const [title, setTitle] = useState(o.title);
  const fixed = fixedProjects(o);
  const amount = parseLimit(limit);
  const save = useMutation({
    mutationFn: () => api.patch<Orchestration>(`/orchestrations/${o.session_id}`, { title: title.trim() || undefined, max_children: max, cost_limit_usd: amount, answer_children: answers, notify_owner: notify, project_keys: keys, auto_merge: merge }),
    onSuccess: (next) => {
      qc.setQueryData<SessionDetail>(['session', next.session_id], (d) => (d ? { ...d, orchestration: next } : d));
      void qc.invalidateQueries({ queryKey: ['orchestrations'] });
      onDone();
    },
  });
  // a project in its scope stays listed also when it was disabled since
  const shown = projects.filter((p) => !p.disabled || o.project_keys.includes(p.key));
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (amount !== undefined) save.mutate(); }}>
      <Field label="Title" hint="Written from the goal when it was created. A title you give stays.">
        <input className={inputCls} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
      </Field>
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
      <Field label="Notify me about its batches" group hint={NOTIFY_HINT[notify]}>
        <Segmented value={notify} onChange={setNotify} options={NOTIFY_OPTIONS} />
      </Field>
      <Field label="When a step's batch is done" group hint={mergeHint(o, merge)}>
        <Segmented value={merge} onChange={setMerge} options={opts('auto_merge')} />
      </Field>
      <ProjectChips projects={shown} keys={keys} setKeys={setKeys} locked={fixed} />
      <ErrorText error={save.error} />
      <Button type="submit" variant="primary" className="w-full" disabled={save.isPending || amount === undefined || !keys.length}>Save</Button>
    </form>
  );
}

/** The projects an orchestrator may work in, as chips to tick; a `locked` one (a step works there) can't be taken off. */
function ProjectChips({ projects, keys, setKeys, locked = [] }: { projects: ProjectSummary[]; keys: string[]; setKeys: (f: (k: string[]) => string[]) => void; locked?: string[] }) {
  const toggle = (key: string) => setKeys((k) => (k.includes(key) ? k.filter((x) => x !== key) : [...k, key]));
  return (
    <Field label="Projects it may work in" group>
      <div className="flex flex-wrap gap-1.5">
        {projects.map((p) => {
          const fixed = locked.includes(p.key);
          return (
            <button key={p.key} type="button" role="checkbox" aria-checked={keys.includes(p.key)} disabled={fixed} onClick={() => toggle(p.key)}
              className={cx('rounded-lg border px-2.5 h-8 text-[13px]', keys.includes(p.key) ? 'border-accent bg-accent/15 text-accent' : 'border-line-strong text-fg', fixed && 'opacity-70')}>
              {p.key} <span className="text-muted">{p.name}{fixed && ' (a step works here)'}</span>
            </button>
          );
        })}
      </div>
    </Field>
  );
}

/** Whether an orchestrator's folded batches are shown, kept per orchestrator in the browser (DISP-118). */
const foldKey = (id: number) => `dispatch:fold-open:${id}`;
export const foldOpen = (id: number) => { try { return localStorage.getItem(foldKey(id)) === '1'; } catch { return false; } };
export const saveFoldOpen = (id: number, open: boolean) => { try { open ? localStorage.setItem(foldKey(id), '1') : localStorage.removeItem(foldKey(id)); } catch { /* memory only */ } };

function Fold({ id, label, children }: { id: number; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => foldOpen(id));
  return (
    <details
      open={open}
      onToggle={(e) => {
        const now = e.currentTarget.open;
        if (now === open) return;
        setOpen(now);
        saveFoldOpen(id, now);
      }}
    >
      <summary className="cursor-pointer px-3 py-1.5 text-[12px] text-muted">{label}</summary>
      {children}
    </details>
  );
}

/**
 * Activity's Live list: each orchestrator with its batches under it. Those that need the owner
 * show at once; the others are behind "N sessions".
 */
export function FoldedLive({ live, attention, orchestrations }: { live: Session[]; attention: ReadonlyMap<number, Attention>; orchestrations: Orchestration[] }) {
  const orchOf = new Map(orchestrations.map((o) => [o.session_id, o]));
  const partOf = partOfIndex(orchestrations);
  // under its orchestrator's row the step alone says what a batch is part of: the rest of the line is its own latest text (DISP-99)
  const step = partOfIndex(orchestrations, true);
  const row = (s: Session, nested = false) => <SessionRow key={s.id} s={s} showProject attention={attention.get(s.id)} orch={orchOf.get(s.id)} partOf={(nested ? step : partOf).get(s.id)} />;
  return (
    <>
      {foldLive(live, attention).map((r) => (
        <div key={r.s.id} className="border-b border-line last:border-b-0">
          {row(r.s)}
          {(r.needs.length > 0 || r.children.length > 0) && (
            <div className="ml-4 border-l border-line">
              {r.needs.map((s) => row(s, true))}
              {r.children.length > 0 && (
                <Fold id={r.s.id} label={`${r.children.length} session${r.children.length === 1 ? '' : 's'}`}>
                  {r.children.map((s) => row(s, true))}
                </Fold>
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
  const [notify, setNotify] = useState<NotifyOwner>('needs_you');
  const [limit, setLimit] = useState('');
  const amount = parseLimit(limit);
  // the orchestrator's own model and effort: your default (Settings) until you pick here
  const { data: mine } = useOrchestratorDefaults();
  const [own, setOwn] = useState<Partial<OrchestratorDefaults>>({});
  const model = own.model ?? mine?.model ?? 'default';
  const effort = own.effort ?? mine?.effort ?? 'default';
  const [options, setOptions] = useState<RunOptions>(DEFAULT_RUN_OPTIONS);
  const start = useMutation({
    mutationFn: () => api.post<Orchestration>('/orchestrations', { goal, project_keys: keys, max_children: max, answer_children: answers, notify_owner: notify, cost_limit_usd: amount ?? null, model, effort, options }),
    onSuccess: (o) => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      onDone();
      nav(`/s/${o.session_id}`);
    },
  });
  const problem = orchestrationProblem(goal, keys);
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!problem && amount !== undefined) start.mutate(); }}>
      <p className="text-[13px] text-muted mb-3">An orchestrator plans a larger goal as steps, over one or more projects. You approve the plan; then it starts each step as a batch and goes on by itself when one is merged.</p>
      <Field label="Goal" hint="What should be true at the end. It asks you about the rest.">
        <textarea className={cx(inputCls, 'min-h-28')} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Move sign-in to the new tokens in the app and the admin tool" aria-label="Goal" />
      </Field>
      <ProjectChips projects={projects.filter((p) => !p.disabled)} keys={keys} setKeys={setKeys} />
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted mt-4 mb-2">The orchestrator itself</h3>
      <Field label="Model" group hint="It plans, starts the steps and answers its batches. Default: the server's default model. Your usual choice is in Settings.">
        <Segmented value={model} onChange={(v) => setOwn((o) => ({ ...o, model: v }))} options={opts('orchestratorModel')} />
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
      <Field label="Notify me about its batches" group hint={NOTIFY_HINT[notify]}>
        <Segmented value={notify} onChange={setNotify} options={NOTIFY_OPTIONS} />
      </Field>
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted mt-4 mb-2">Each step's batch</h3>
      <RunOptionsFields value={options} set={(p) => setOptions((o) => ({ ...o, ...p }))} />
      <ErrorText error={start.error} />
      <Button type="submit" variant="primary" className="w-full" disabled={!!problem || amount === undefined || start.isPending}>{problem ?? 'Start planning'}</Button>
    </form>
  );
}
