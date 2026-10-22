// Scheduled planner runs (DISP-13): a project's schedules, on its Sessions tab.
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_RUN_OPTIONS, type RunOptions } from '../../../src/shared/types.ts';
import { api, type ProjectSummary, type ScheduleView, type Session } from '../api.ts';
import { RunOptionsFields, runOptionsSummary } from './batch.tsx';
import { Button, Card, ErrorText, Field, Section, SessionStatusChip, Sheet, cx, inputCls } from './ui.tsx';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Monday first, as the owner reads a week */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

export function daysLabel(days: number[]) {
  if (days.length === 7) return 'every day';
  if (days.join() === '1,2,3,4,5') return 'weekdays';
  if (days.join() === '0,6') return 'weekends';
  return WEEK.filter((d) => days.includes(d)).map((d) => DAYS[d]).join(', ');
}

/** "today 02:00", "tomorrow 02:00", "Mon 02:00" */
function when(iso: string) {
  const d = new Date(iso);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (day === today) return `today ${time}`;
  if (day === today + 86_400_000) return `tomorrow ${time}`;
  return `${DAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} ${time}`;
}

export function Schedules({ project }: { project: ProjectSummary }) {
  const { data = [] } = useQuery({ queryKey: ['schedules', project.key], queryFn: () => api.get<ScheduleView[]>(`/projects/${project.key}/schedules`) });
  const [editing, setEditing] = useState<ScheduleView | 'new' | null>(null);
  return (
    <Section title="Schedules" action={<button className="text-[12px] text-accent" onClick={() => setEditing('new')}>+ Add schedule</button>}>
      {data.length ? (
        <Card>
          {data.map((s) => (
            <button key={s.id} type="button" onClick={() => setEditing(s)} className="block w-full text-left px-3 py-2.5 border-b border-line last:border-b-0 active:bg-raised" aria-label={`Schedule ${s.name}`}>
              <div className="flex items-center gap-2">
                <span className={cx('flex-1 min-w-0 truncate font-medium', !s.enabled && 'text-muted')}>{s.name}</span>
                <span className="text-[13px] text-muted shrink-0">{s.at_time} · {daysLabel(s.days)}</span>
              </div>
              <div className="text-[13px] text-muted mt-0.5 truncate">
                {s.enabled ? (s.next_run ? `Next: ${when(s.next_run)}` : '') : 'Off'}
                {s.last_error ? <span className="text-bad"> · Last run failed: {s.last_error}</span>
                  : s.last_session ? <> · Last: {s.last_session.last_text ?? s.last_session.status}</> : null}
              </div>
            </button>
          ))}
        </Card>
      ) : (
        <p className="px-4 text-[13px] text-muted">A planner can run here at set times, e.g. every night, and start the work it picks within a scope you write. Each run shows below with its result.</p>
      )}
      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'New schedule' : editing ? editing.name : 'Schedule'}>
        {editing && <ScheduleForm key={editing === 'new' ? 'new' : editing.id} project={project} schedule={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      </Sheet>
    </Section>
  );
}

function ScheduleForm({ project, schedule, onDone }: { project: ProjectSummary; schedule: ScheduleView | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: schedule?.name ?? 'Nightly',
    at_time: schedule?.at_time ?? '02:00',
    days: schedule?.days ?? [0, 1, 2, 3, 4, 5, 6],
    scope_md: schedule?.scope_md ?? '',
    max_batches: schedule?.max_batches ?? 1,
    enabled: schedule?.enabled ?? true,
  });
  const [options, setOptions] = useState<RunOptions>(schedule?.options ?? DEFAULT_RUN_OPTIONS);
  const refresh = () => qc.invalidateQueries({ queryKey: ['schedules', project.key] });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, options };
      return schedule ? api.patch(`/schedules/${schedule.id}`, body) : api.post(`/projects/${project.key}/schedules`, body);
    },
    onSuccess: () => { refresh(); onDone(); },
  });
  const run = useMutation({ mutationFn: () => api.post<Session>(`/schedules/${schedule!.id}/run`), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => api.del(`/schedules/${schedule!.id}`), onSuccess: () => { refresh(); onDone(); } });
  const toggleDay = (d: number) => setF({ ...f, days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d].sort() });
  const summary = runOptionsSummary(options);
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <p className="text-[13px] text-muted mb-3">At this time a planner looks at the backlog within the scope and starts the batches it picks, with the options below. It asks nothing; starting nothing is fine. It never starts items on hold.</p>
      <Field label="Name"><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Schedule name" /></Field>
      <Field label="Time" hint="The server's local time.">
        <input type="time" className={inputCls} value={f.at_time} onChange={(e) => setF({ ...f, at_time: e.target.value })} aria-label="Time" required />
      </Field>
      <Field label="Days" group>
        <div className="flex flex-wrap gap-1.5">
          {WEEK.map((d) => (
            <button key={d} type="button" aria-pressed={f.days.includes(d)} onClick={() => toggleDay(d)}
              className={cx('rounded-md border text-[13px] h-8 px-2.5', f.days.includes(d) ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted')}>
              {DAYS[d]}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Scope" hint="What the planner may pick, in your words: modules, tags, kinds of work, or a task such as triaging new bugs.">
        <textarea className={cx(inputCls, 'min-h-24')} value={f.scope_md} onChange={(e) => setF({ ...f, scope_md: e.target.value })} placeholder="e.g. Bugs in the ui module, small effort only. Triage new bugs first." aria-label="Scope" />
      </Field>
      <Field label="Most batches per run">
        <input type="number" min={1} max={10} className={inputCls} value={f.max_batches} onChange={(e) => setF({ ...f, max_batches: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} aria-label="Most batches per run" />
      </Field>
      <details className="mb-3">
        <summary className="text-[14px] py-2 cursor-pointer">Run options for its batches{summary.length ? <span className="text-muted"> · {summary.join(', ')}</span> : ''}</summary>
        <div className="pt-2"><RunOptionsFields value={options} set={(p) => setOptions({ ...options, ...p })} project={project} /></div>
      </details>
      <label className="flex items-center justify-between text-[14px] py-2 border-t border-line mb-3">
        On
        <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} className="size-5 accent-[var(--color-accent-strong)]" aria-label="Schedule on" />
      </label>
      <ErrorText error={save.error ?? run.error ?? remove.error} />
      <Button variant="primary" className="w-full" disabled={!f.name.trim() || !f.days.length || save.isPending}>{schedule ? 'Save' : 'Add schedule'}</Button>
      {schedule && (
        <>
          {schedule.last_session && (
            <Link to={`/s/${schedule.last_session.id}`} className="flex items-center gap-2 mt-3 px-3 py-2 rounded-lg border border-line text-[14px]">
              <span className="flex-1 min-w-0 truncate">Last run: {schedule.last_session.last_text ?? schedule.last_session.title}</span>
              <SessionStatusChip status={schedule.last_session.status} />
            </Link>
          )}
          {run.data && <p className="text-[13px] text-muted mt-2">Started <Link className="text-accent" to={`/s/${run.data.id}`}>session #{run.data.id}</Link>.</p>}
          <div className="flex gap-2 mt-3">
            <Button type="button" className="flex-1" disabled={run.isPending} onClick={() => run.mutate()}>Run now</Button>
            <Button type="button" variant="danger" className="flex-1" onClick={() => { if (confirm(`Delete the schedule "${schedule.name}"?`)) remove.mutate(); }}>Delete</Button>
          </div>
        </>
      )}
    </form>
  );
}
