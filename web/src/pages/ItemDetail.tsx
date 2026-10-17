import { Icon } from '../components/icons.tsx';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, uploadImage, type Item, type ItemDetail as Detail, type ItemImage, type ProjectSummary, type Repo } from '../api.ts';
import { AddImageButton, ImageStrip, usePastedImages } from '../components/images.tsx';
import { Page } from '../components/Layout.tsx';
import { RichMd } from '../components/RichMd.tsx';
import { BatchForm } from '../components/batch.tsx';
import { ItemFields, SessionRow, StatusPicker, effortLabel } from '../components/items.tsx';
import { noteProject } from '../nav.ts';
import { useVeryWide, useWide } from '../wide.ts';
import { Discuss } from './Discuss.tsx';
import { Button, Card, Chip, CloseButton, Empty, ErrorText, ImportanceIcon, Section, Sheet, cx, inputCls, timeAgo } from '../components/ui.tsx';

/** An item. With `itemId` + `onClose` it renders as the desktop drawer next to the project list. */
export function ItemDetail({ itemId, onClose }: { itemId?: number; onClose?: () => void } = {}) {
  const params = useParams();
  const id = itemId ?? Number(params.id);
  const drawer = !!onClose;
  const nav = useNavigate();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState('');
  const { data: it } = useQuery({ queryKey: ['item', id], queryFn: () => api.get<Detail>(`/items/${id}`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['item', id] });
    if (it) qc.invalidateQueries({ queryKey: ['items', it.project_id] });
    if (it) qc.invalidateQueries({ queryKey: ['facets', it.project.key] });
  };
  const patch = useMutation({ mutationFn: (p: Partial<Item>) => api.patch<Item>(`/items/${id}`, p), onSuccess: refresh });
  const addComment = useMutation({ mutationFn: () => api.post(`/items/${id}/comments`, { body_md: comment }), onSuccess: () => { setComment(''); refresh(); } });
  const [starting, setStarting] = useState(false);
  // same key and shape as the project page's query: the cache holds the whole project
  const { data: projectFull } = useQuery({ queryKey: ['project', it?.project.key], queryFn: () => api.get<ProjectSummary>(`/projects/${it!.project.key}`), enabled: !!it });
  const repos: Repo[] = projectFull?.repos ?? [];
  const remove = useMutation({ mutationFn: () => api.del(`/items/${id}`), onSuccess: () => (onClose ? onClose() : nav(`/p/${it!.project.key}`)) });
  useEffect(() => { if (it) noteProject(it.project.key); }, [it?.project.key]);
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) await uploadImage(id, f);
    },
    onSettled: refresh,
  });
  const deleteImage = useMutation({ mutationFn: (img: ItemImage) => api.del(`/images/${img.id}`), onSuccess: refresh });
  usePastedImages((files) => upload.mutate(files), !!it);
  const closeBtn = drawer && <CloseButton onClick={onClose} label="Close item" />;
  // desktop: Discuss opens beside the item (?discuss=1), not on its own screen
  const wide = useWide();
  const veryWide = useVeryWide();
  const [search, setSearch] = useSearchParams();
  const discussing = wide && search.get('discuss') === '1';
  const setDiscuss = (on: boolean) => {
    const next = new URLSearchParams(search);
    if (on) next.set('discuss', '1');
    else next.delete('discuss');
    setSearch(next, { replace: true });
  };
  if (!it) return <Page title="Item" back={drawer ? undefined : true} keepScroll={!drawer} actions={closeBtn}><Empty>Loading…</Empty></Page>;
  const p = it.project;
  const busy = it.status === 'in_progress' || it.status === 'in_review';

  const page = (
    <Page
      title={it.key}
      subtitle={p.name}
      back={drawer ? undefined : `/p/${p.key}${it.type === 'bug' ? '?tab=bugs' : ''}`}
      keepScroll={!drawer}
      actions={<>
        {drawer && <Link to={`/items/${it.id}`} className="text-[13px] text-muted px-2" aria-label="Open full page">Open</Link>}
        <Button small variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
        {closeBtn}
      </>}
    >
      <div className="px-4 pt-4">
        <h2 className="text-lg font-semibold leading-snug [overflow-wrap:anywhere]">{it.title}</h2>
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {it.type === 'bug' && <Chip tone="bad">Bug</Chip>}
          <Chip><ImportanceIcon value={it.importance} /> {p.importance_scale[it.importance - 1]}</Chip>
          {effortLabel(p, it.effort) && <Chip>Effort {effortLabel(p, it.effort)}</Chip>}
          {it.modules.map((m) => <Chip key={`m-${m}`} tone="accent">{m}</Chip>)}
          {it.labels.map((l) => <Chip key={`t-${l}`}>#{l}</Chip>)}
        </div>
        <div className="mt-3"><StatusPicker value={it.status} onChange={(status) => patch.mutate({ status })} /></div>
        {it.source && (
          <Link to={`/sources/${it.source.id}`} className="block mt-3 rounded-lg border border-line bg-panel px-3 py-2 active:bg-raised">
            <div className="text-[12px] text-faint">From {it.source.kind === 'manual' ? 'document' : it.source.kind.replace('_', ' ')}</div>
            <div className="text-[14px] font-medium truncate">{it.source.title}</div>
            <div className="text-[12px] text-muted">{[it.source.reporter, it.source.version_tag, it.source.skill_name].filter(Boolean).join(' · ')}</div>
          </Link>
        )}
        <div className="mt-4">{it.body_md ? <RichMd ctx={{ project: p, sourceId: it.source_id }}>{it.body_md}</RichMd> : <p className="text-muted text-sm">No description.</p>}</div>
        <div className="mt-4">
          <ImageStrip images={it.images.filter((i) => !i.comment_id)} onDelete={(img) => deleteImage.mutate(img)} className="mb-2" />
          <div className="flex items-center gap-2">
            <AddImageButton onFiles={(files) => upload.mutate(files)} busy={upload.isPending} />
            {wide && <span className="text-[12px] text-faint">or paste a screenshot</span>}
          </div>
          <ErrorText error={upload.error ?? deleteImage.error} />
        </div>
        {wide ? (
          <button onClick={() => setDiscuss(!discussing)} aria-pressed={discussing} className={cx('mt-4 w-full flex items-center justify-center gap-1.5 h-10 rounded-lg border font-medium', discussing ? 'border-accent bg-accent/15' : 'border-line bg-raised hover:bg-line')}>
            <Icon name="discuss" size={20} /> {discussing ? 'Hide the discussion' : 'Discuss this'}
          </button>
        ) : (
          <Link to={`/items/${it.id}/discuss`} className="mt-4 flex items-center justify-center gap-1.5 h-10 rounded-lg border border-line bg-raised font-medium active:bg-line">
            <Icon name="discuss" size={20} /> Discuss this
          </Link>
        )}
        {!busy && (
          <div className="flex gap-2 mt-2">
            <Button variant="primary" className="flex-1" onClick={() => setStarting(true)}>Start agent on this</Button>
            <Button onClick={() => patch.mutate({ marked: !it.marked })}>{it.marked ? 'Unmark' : 'Mark'}</Button>
          </div>
        )}
        <ErrorText error={patch.error} />
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
              <RichMd className="text-[14px]" ctx={{ project: p, sourceId: it.source_id }}>{c.body_md}</RichMd>
              <ImageStrip images={it.images.filter((i) => i.comment_id === c.id)} onDelete={(img) => deleteImage.mutate(img)} className="mt-1.5" />
            </div>
          ))}
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); addComment.mutate(); }}>
            <input className={inputCls} placeholder="Add a comment" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" />
            <Button disabled={!comment.trim() || addComment.isPending}>Add</Button>
          </form>
        </div>
      </Section>

      <Sheet open={starting} onClose={() => setStarting(false)} title={`Start agent on ${it.key}`}>
        <BatchForm project={{ ...p, repos }} items={[it]} onStarted={(s) => nav(`/s/${s.id}`)} />
      </Sheet>
      <Sheet open={editing} onClose={() => setEditing(false)} title={`Edit ${it.key}`}>
        <EditItem item={it} onDone={() => { setEditing(false); refresh(); }} onDelete={() => confirm(`Delete ${it.key}?`) && remove.mutate()} />
      </Sheet>
    </Page>
  );
  if (!discussing) return page;
  const chat = <Discuss key={it.id} itemId={it.id} onClose={() => setDiscuss(false)} />;
  // a drawer next to the list without room for a third column: the chat takes the drawer, ✕ goes back
  if (drawer && !veryWide) return chat;
  return (
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 flex flex-col">{page}</div>
      <aside className="w-[420px] max-w-[50%] shrink-0 min-h-0 flex flex-col border-l border-line bg-bg" aria-label="Discussion">{chat}</aside>
    </div>
  );
}

function EditItem({ item, onDone, onDelete }: { item: Detail; onDone: () => void; onDelete: () => void }) {
  const [draft, setDraft] = useState({ type: item.type, title: item.title, body_md: item.body_md, importance: item.importance, effort: item.effort, status: item.status, labels: item.labels, modules: item.modules });
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
