import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ITEM_STATUSES, type ItemStatus } from '../../../src/shared/types.ts';
import { api, type Item, type ItemDetail as Detail, type Session } from '../api.ts';
import { Page } from '../components/Layout.tsx';
import { ItemFields, SessionRow, effortLabel } from '../components/items.tsx';
import { Button, Card, Chip, Empty, ErrorText, ITEM_STATUS_LABEL, ImportanceIcon, Md, Section, Sheet, cx, inputCls, timeAgo } from '../components/ui.tsx';

export function ItemDetail() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState('');
  const { data: it } = useQuery({ queryKey: ['item', id], queryFn: () => api.get<Detail>(`/items/${id}`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['item', id] });
    if (it) qc.invalidateQueries({ queryKey: ['items', it.project_id] });
  };
  const patch = useMutation({ mutationFn: (p: Partial<Item>) => api.patch<Item>(`/items/${id}`, p), onSuccess: refresh });
  const addComment = useMutation({ mutationFn: () => api.post(`/items/${id}/comments`, { body_md: comment }), onSuccess: () => { setComment(''); refresh(); } });
  const start = useMutation({
    mutationFn: () => api.post<Session>(`/projects/${it!.project.key}/batches`, { item_ids: [id], prompt: '' }),
    onSuccess: (s) => nav(`/s/${s.id}`),
  });
  const remove = useMutation({ mutationFn: () => api.del(`/items/${id}`), onSuccess: () => nav(`/p/${it!.project.key}`) });
  if (!it) return <Page title="Item" back><Empty>Loading…</Empty></Page>;
  const p = it.project;
  const busy = it.status === 'in_progress' || it.status === 'in_review';

  return (
    <Page title={it.key} subtitle={p.name} back={`/p/${p.key}${it.type === 'bug' ? '?tab=bugs' : ''}`} actions={<Button small variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}>
      <div className="px-4 pt-4">
        <h2 className="text-lg font-semibold leading-snug">{it.title}</h2>
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {it.type === 'bug' && <Chip tone="bad">Bug</Chip>}
          <Chip><ImportanceIcon value={it.importance} /> {p.importance_scale[it.importance - 1]}</Chip>
          {effortLabel(p, it.effort) && <Chip>Effort {effortLabel(p, it.effort)}</Chip>}
          {it.labels.map((l) => <Chip key={l}>{l}</Chip>)}
        </div>
        <select
          className={cx(inputCls, 'mt-3')}
          value={it.status}
          onChange={(e) => patch.mutate({ status: e.target.value as ItemStatus })}
          aria-label="Status"
        >
          {ITEM_STATUSES.map((s) => <option key={s} value={s}>{ITEM_STATUS_LABEL[s]}</option>)}
        </select>
        {it.source && (
          <Link to={`/sources/${it.source.id}`} className="block mt-3 rounded-lg border border-line bg-panel px-3 py-2 active:bg-raised">
            <div className="text-[12px] text-faint">From {it.source.kind === 'manual' ? 'document' : it.source.kind.replace('_', ' ')}</div>
            <div className="text-[14px] font-medium truncate">{it.source.title}</div>
            <div className="text-[12px] text-muted">{[it.source.reporter, it.source.version_tag, it.source.skill_name].filter(Boolean).join(' · ')}</div>
          </Link>
        )}
        <div className="mt-4">{it.body_md ? <Md>{it.body_md}</Md> : <p className="text-muted text-sm">No description.</p>}</div>
        {!busy && (
          <div className="flex gap-2 mt-4">
            <Button variant="primary" className="flex-1" disabled={start.isPending} onClick={() => start.mutate()}>Start agent on this</Button>
            <Button onClick={() => patch.mutate({ marked: !it.marked })}>{it.marked ? 'Unmark' : 'Mark'}</Button>
          </div>
        )}
        <ErrorText error={start.error ?? patch.error} />
      </div>

      {it.sessions.length > 0 && (
        <Section title="Sessions">
          <Card>{it.sessions.map((s) => <SessionRow key={s.id} s={s} />)}</Card>
        </Section>
      )}

      <Section title="Comments">
        <div className="px-4 space-y-3">
          {it.comments.map((c) => (
            <div key={c.id}>
              <div className="text-[12px] text-faint">{c.author} · {timeAgo(c.created_at)}</div>
              <Md className="text-[14px]">{c.body_md}</Md>
            </div>
          ))}
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); addComment.mutate(); }}>
            <input className={inputCls} placeholder="Add a comment" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" />
            <Button disabled={!comment.trim() || addComment.isPending}>Add</Button>
          </form>
        </div>
      </Section>

      <Sheet open={editing} onClose={() => setEditing(false)} title={`Edit ${it.key}`}>
        <EditItem item={it} onDone={() => { setEditing(false); refresh(); }} onDelete={() => confirm(`Delete ${it.key}?`) && remove.mutate()} />
      </Sheet>
    </Page>
  );
}

function EditItem({ item, onDone, onDelete }: { item: Detail; onDone: () => void; onDelete: () => void }) {
  const [draft, setDraft] = useState({ type: item.type, title: item.title, body_md: item.body_md, importance: item.importance, effort: item.effort, status: item.status });
  const save = useMutation({ mutationFn: () => api.patch(`/items/${item.id}`, draft), onSuccess: onDone });
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <ItemFields project={item.project} draft={draft} set={(d) => setDraft({ ...draft, ...d })} showStatus />
      <ErrorText error={save.error} />
      <Button variant="primary" className="w-full" disabled={!draft.title.trim() || save.isPending}>Save</Button>
      <Button type="button" variant="danger" className="w-full mt-2" onClick={onDelete}>Delete item</Button>
    </form>
  );
}
