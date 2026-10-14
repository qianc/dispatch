import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Session, type SourceDetail } from '../api.ts';
import { Page } from '../components/Layout.tsx';
import { ItemRow, NewItemForm } from '../components/items.tsx';
import { Button, Card, Chip, Empty, ErrorText, Md, Section, Sheet, timeAgo } from '../components/ui.tsx';

export function SourceView() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const { data: s } = useQuery({ queryKey: ['source', id], queryFn: () => api.get<SourceDetail>(`/sources/${id}`) });
  const split = useMutation({
    mutationFn: () => api.post<Session>(`/projects/${s!.project_key}/planner`, { source_id: id }),
    onSuccess: (session) => nav(`/s/${session.id}`),
  });
  if (!s) return <Page title="Source" back><Empty>Loading…</Empty></Page>;
  return (
    <Page title={s.title} subtitle={`${s.project_key} · ${s.kind.replace('_', ' ')}`} back={`/p/${s.project_key}?tab=sources`}>
      <div className="px-4 pt-3 flex flex-wrap gap-1.5">
        {s.reporter && <Chip>by {s.reporter}</Chip>}
        {s.version_tag && <Chip tone="accent">{s.version_tag}</Chip>}
        {s.skill_name && <Chip>skill {s.skill_name}</Chip>}
        <Chip>{timeAgo(s.created_at)} ago</Chip>
      </div>
      <div className="flex gap-2 px-3 mt-3">
        <Button variant="primary" className="flex-1" disabled={split.isPending || !s.body_md.trim()} onClick={() => split.mutate()}>Split into items with Claude</Button>
        <Button onClick={() => setAdding(true)}>+ Item</Button>
      </div>
      <ErrorText error={split.error} />
      <Section title={`Items from this source · ${s.items.length}`}>
        {s.items.length ? <Card>{s.items.map((it) => <ItemRow key={it.id} item={it} project={s.project} />)}</Card> : <Empty>No items yet.</Empty>}
      </Section>
      <Section title="Text">
        <div className="px-4">{s.body_md ? <Md>{s.body_md}</Md> : <p className="text-muted text-sm">Empty.</p>}</div>
      </Section>
      <Sheet open={adding} onClose={() => setAdding(false)} title="New item from source">
        <NewItemForm project={s.project} type="bug" sourceId={s.id} onDone={() => { setAdding(false); qc.invalidateQueries({ queryKey: ['source', id] }); }} />
      </Sheet>
    </Page>
  );
}
