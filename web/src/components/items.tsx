import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ITEM_STATUSES, type ItemStatus, type ItemType, type ProposedItem } from '../../../src/shared/types.ts';
import { api, type Item, type Project, type Session } from '../api.ts';
import {
  Button, Chip, ErrorText, Field, ITEM_STATUS_LABEL, ImportanceIcon, ItemStatusIcon, Segmented, SessionStatusChip, cx, inputCls, timeAgo,
} from './ui.tsx';

export function effortLabel(p: Pick<Project, 'effort_scale'>, effort: number | null) {
  return effort === null ? null : p.effort_scale[effort] ?? String(effort);
}

export function ItemRow({ item, project, selectable, onToggle }: { item: Item; project: Project; selectable?: boolean; onToggle?: (it: Item) => void }) {
  const effort = effortLabel(project, item.effort);
  return (
    <div className="flex items-center border-b border-line last:border-b-0">
      {selectable && (item.status === 'in_progress' || item.status === 'in_review') && <span className="w-9 shrink-0" />}
      {selectable && item.status !== 'in_progress' && item.status !== 'in_review' && (
        <button
          onClick={() => onToggle?.(item)}
          className="pl-3 pr-1 h-12 flex items-center"
          aria-label={item.marked ? `Unmark ${item.key}` : `Mark ${item.key} for the agent`}
          aria-pressed={item.marked}
        >
          <span className={cx('size-5 rounded-md border flex items-center justify-center', item.marked ? 'bg-accent-strong border-accent-strong' : 'border-line')}>
            {item.marked && <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2"><path d="M2.5 6.5l2.5 2.5 4.5-6" /></svg>}
          </span>
        </button>
      )}
      <Link to={`/items/${item.id}`} className="flex-1 min-w-0 flex items-center gap-2.5 px-3 py-2.5 active:bg-raised">
        <ImportanceIcon value={item.importance} label={project.importance_scale[item.importance - 1]} />
        <span className="text-[12px] text-faint tabular-nums w-12 shrink-0">{item.key}</span>
        <ItemStatusIcon status={item.status} />
        <span className="flex-1 min-w-0 truncate">{item.title}</span>
        {effort && <Chip>{effort}</Chip>}
        {item.type === 'bug' && <Chip tone="bad">Bug</Chip>}
      </Link>
    </div>
  );
}

export function SessionRow({ s, showProject }: { s: Session; showProject?: boolean }) {
  return (
    <Link to={`/s/${s.id}`} className="block px-3 py-2.5 border-b border-line last:border-b-0 active:bg-raised">
      <div className="flex items-center gap-2">
        {showProject && <span className="text-[12px] font-semibold text-accent">{s.project_key}</span>}
        <span className="flex-1 min-w-0 truncate font-medium">{s.kind === 'planner' ? '💬 ' : ''}{s.title}</span>
        <SessionStatusChip status={s.status} />
      </div>
      <div className="flex items-center gap-2 mt-0.5 text-[13px] text-muted">
        <span className="flex-1 min-w-0 truncate">{s.status === 'waiting_input' ? s.waiting_reason : s.last_text ?? s.initial_prompt}</span>
        <span className="text-faint text-[12px] shrink-0">{timeAgo(s.updated_at)}</span>
      </div>
    </Link>
  );
}

type Draft = { type: ItemType; title: string; body_md: string; importance: number; effort: number | null; status: ItemStatus };

export function ItemFields({ project, draft, set, showStatus }: { project: Project; draft: Draft | ProposedItem; set: (d: Partial<Draft>) => void; showStatus?: boolean }) {
  return (
    <>
      <Field label="Type" group>
        <Segmented<ItemType> value={draft.type} onChange={(type) => set({ type })} options={[{ value: 'backlog', label: 'Backlog' }, { value: 'bug', label: 'Bug' }]} />
      </Field>
      <Field label="Title">
        <input className={inputCls} value={draft.title} onChange={(e) => set({ title: e.target.value })} autoFocus />
      </Field>
      <Field label="Description (markdown)">
        <textarea className={cx(inputCls, 'min-h-28')} value={draft.body_md} onChange={(e) => set({ body_md: e.target.value })} />
      </Field>
      <Field label="Importance" group>
        <Segmented<number> value={draft.importance} onChange={(importance) => set({ importance })} options={project.importance_scale.map((l, i) => ({ value: i + 1, label: l }))} />
      </Field>
      <Field label="Effort" group>
        <Segmented<number> value={draft.effort ?? -1} onChange={(v) => set({ effort: v < 0 ? null : v })} options={[{ value: -1, label: '–' }, ...project.effort_scale.map((l, i) => ({ value: i, label: l }))]} />
      </Field>
      {showStatus && 'status' in draft && (
        <Field label="Status">
          <select className={inputCls} value={draft.status} onChange={(e) => set({ status: e.target.value as ItemStatus })}>
            {ITEM_STATUSES.map((s) => <option key={s} value={s}>{ITEM_STATUS_LABEL[s]}</option>)}
          </select>
        </Field>
      )}
    </>
  );
}

export function NewItemForm({ project, type, sourceId, onDone }: { project: Project; type: ItemType; sourceId?: number; onDone: (it: Item) => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>({ type, title: '', body_md: '', importance: 2, effort: null, status: type === 'bug' ? 'triage' : 'backlog' });
  const create = useMutation({
    mutationFn: () => api.post<Item>(`/projects/${project.key}/items`, { ...draft, source_id: sourceId ?? null }),
    onSuccess: (it) => {
      qc.invalidateQueries({ queryKey: ['items', project.id] });
      onDone(it);
    },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <ItemFields project={project} draft={draft} set={(d) => setDraft({ ...draft, ...d })} showStatus />
      <ErrorText error={create.error} />
      <Button variant="primary" className="w-full" disabled={!draft.title.trim() || create.isPending}>Create</Button>
    </form>
  );
}
