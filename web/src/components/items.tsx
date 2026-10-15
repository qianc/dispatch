import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TokenInput } from './TokenInput.tsx';
import { ITEM_STATUSES, type ItemStatus, type ItemType, type ProposedItem } from '../../../src/shared/types.ts';
import { api, type Item, type Project, type Session } from '../api.ts';
import {
  Button, Chip, ErrorText, Field, ITEM_STATUS_LABEL, ImportanceIcon, ItemStatusIcon, Segmented, SessionStatusChip, Sheet, cx, inputCls, timeAgo,
} from './ui.tsx';

export function effortLabel(p: Pick<Project, 'effort_scale'>, effort: number | null) {
  return effort === null ? null : p.effort_scale[effort] ?? String(effort);
}

const LONG_PRESS_MS = 450;

/**
 * One item in a list. Checkboxes only in select mode (always on desktop); a long press anywhere on
 * the row enters select mode and marks that item. Tapping the text always opens the item; the
 * checkbox column marks it. On phones the key shows as its number only. `onOpen` replaces
 * navigation (the desktop drawer).
 */
export function ItemRow({ item, project, selectMode, onToggle, onLongPress, onOpen, active, wrap }: {
  item: Item;
  project: Project;
  selectMode?: boolean;
  onToggle?: (it: Item) => void;
  onLongPress?: (it: Item) => void;
  onOpen?: (it: Item) => void;
  active?: boolean;
  wrap?: boolean;
}) {
  const effort = effortLabel(project, item.effort);
  const markable = item.status !== 'in_progress' && item.status !== 'in_review';
  const timer = useRef<number | undefined>(undefined);
  const pressed = useRef(false);
  const start = () => {
    pressed.current = false;
    if (!onLongPress || !markable) return;
    timer.current = window.setTimeout(() => {
      pressed.current = true;
      navigator.vibrate?.(10);
      onLongPress(item);
    }, LONG_PRESS_MS);
  };
  const cancel = () => window.clearTimeout(timer.current);
  const meta = [...item.modules, ...item.labels];
  return (
    <div className={cx('flex items-stretch border-b border-line last:border-b-0 select-none [-webkit-touch-callout:none]', active && 'bg-raised')}>
      {selectMode && (
        markable ? (
          <button
            onClick={() => onToggle?.(item)}
            className="pl-3 pr-2 flex items-center shrink-0 active:bg-raised"
            aria-label={item.marked ? `Unmark ${item.key}` : `Mark ${item.key} for the agent`}
            aria-pressed={item.marked}
          >
            <span className={cx('size-5 rounded-md border flex items-center justify-center', item.marked ? 'bg-accent-strong border-accent-strong' : 'border-faint/60')}>
              {item.marked && <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2"><path d="M2.5 6.5l2.5 2.5 4.5-6" /></svg>}
            </span>
          </button>
        ) : <span className="w-10 shrink-0" />
      )}
      <Link
        to={`/items/${item.id}`}
        onClick={(e) => {
          if (pressed.current) e.preventDefault(); // the long press already marked it
          else if (onOpen) {
            e.preventDefault();
            onOpen(item);
          }
          pressed.current = false;
        }}
        onPointerDown={start}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => onLongPress && e.preventDefault()}
        className={cx('flex-1 min-w-0 flex gap-2.5 px-3 py-2.5 active:bg-raised', selectMode && 'pl-1', wrap ? 'items-start' : 'items-center')}
      >
        <span className={cx('flex items-center gap-2 shrink-0', wrap && 'pt-0.5')}>
          <ImportanceIcon value={item.importance} label={project.importance_scale[item.importance - 1]} />
          <span className="text-[12px] text-faint tabular-nums min-w-6 sm:hidden" aria-label={item.key}>{item.number}</span>
          <span className="text-[12px] text-faint tabular-nums w-14 hidden sm:inline">{item.key}</span>
          <ItemStatusIcon status={item.status} />
        </span>
        <span className="flex-1 min-w-0">
          <span className={cx('block', wrap ? 'leading-snug' : 'truncate')}>{item.title}</span>
          {wrap && meta.length > 0 && (
            <span className="flex flex-wrap gap-1 mt-1">
              {item.modules.map((m) => <span key={`m-${m}`} className="text-[11px] text-accent">{m}</span>)}
              {item.labels.map((t) => <span key={`t-${t}`} className="text-[11px] text-muted">#{t}</span>)}
            </span>
          )}
        </span>
        <span className={cx('flex items-center gap-1 shrink-0', wrap && 'pt-0.5')}>
          {effort && <Chip>{effort}</Chip>}
          {item.type === 'bug' && <Chip tone="bad">Bug</Chip>}
        </span>
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

/** Status as icon + label; tap for the list of statuses, each with its icon. */
export function StatusPicker({ value, onChange, disabled }: { value: ItemStatus; onChange: (s: ItemStatus) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2.5 h-10 px-3 rounded-lg bg-bg border border-line text-left active:bg-raised disabled:opacity-50"
        aria-label={`Status: ${ITEM_STATUS_LABEL[value]}. Change status`}
      >
        <ItemStatusIcon status={value} size={18} />
        <span className="flex-1 font-medium">{ITEM_STATUS_LABEL[value]}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-faint"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Status">
        <div className="-mx-1">
          {ITEM_STATUSES.map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => { onChange(st); setOpen(false); }}
              aria-pressed={st === value}
              className={cx('w-full flex items-center gap-3 h-12 px-3 rounded-lg text-left active:bg-raised', st === value && 'bg-raised')}
            >
              <ItemStatusIcon status={st} size={20} />
              <span className="flex-1">{ITEM_STATUS_LABEL[st]}</span>
              {st === value && <span className="text-accent">✓</span>}
            </button>
          ))}
        </div>
      </Sheet>
    </>
  );
}

type Draft = { type: ItemType; title: string; body_md: string; importance: number; effort: number | null; status: ItemStatus; labels: string[]; modules: string[] };

export interface Facets { tags: { name: string; count: number }[]; modules: { name: string; count: number }[] }

export const useFacets = (projectKey: string) =>
  useQuery({ queryKey: ['facets', projectKey], queryFn: () => api.get<Facets>(`/projects/${projectKey}/facets`) });

export function ItemFields({ project, draft, set, showStatus }: { project: Project; draft: Draft | ProposedItem; set: (d: Partial<Draft>) => void; showStatus?: boolean }) {
  const { data: facets } = useFacets(project.key);
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
      <TokenInput label="Modules" value={draft.modules ?? []} onChange={(modules) => set({ modules })} suggestions={facets?.modules.map((m) => m.name) ?? []} placeholder="e.g. charts, export" />
      <TokenInput label="Tags" value={draft.labels ?? []} onChange={(labels) => set({ labels })} suggestions={facets?.tags.map((t) => t.name) ?? []} placeholder="e.g. ux, quick-win" />
      {showStatus && 'status' in draft && (
        <Field label="Status" group>
          <StatusPicker value={draft.status} onChange={(status) => set({ status })} />
        </Field>
      )}
    </>
  );
}

export function NewItemForm({ project, type, sourceId, onDone }: { project: Project; type: ItemType; sourceId?: number; onDone: (it: Item) => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>({ type, title: '', body_md: '', importance: 2, effort: null, status: type === 'bug' ? 'triage' : 'backlog', labels: [], modules: [] });
  const create = useMutation({
    mutationFn: () => api.post<Item>(`/projects/${project.key}/items`, { ...draft, source_id: sourceId ?? null }),
    onSuccess: (it) => {
      qc.invalidateQueries({ queryKey: ['items', project.id] });
      qc.invalidateQueries({ queryKey: ['facets', project.key] });
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
