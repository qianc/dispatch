import { ProjectBadge, ProjectKey } from '../components/ProjectBadge.tsx';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { DEFAULT_EFFORT_SCALE, DEFAULT_IMPORTANCE_SCALE } from '../../../src/shared/types.ts';
import { api, type Project, type ProjectSummary } from '../api.ts';
import { Page } from '../components/Layout.tsx';
import { Button, Card, Chip, Empty, ErrorText, Field, Sheet, inputCls } from '../components/ui.tsx';

function NewProject({ onDone }: { onDone: (p: Project) => void }) {
  const [f, setF] = useState({ key: '', name: '', description: '', importance: DEFAULT_IMPORTANCE_SCALE.join(', '), effort: DEFAULT_EFFORT_SCALE.join(', ') });
  const create = useMutation({
    mutationFn: () => api.post<Project>('/projects', {
      key: f.key, name: f.name, description: f.description,
      importance_scale: f.importance.split(',').map((s) => s.trim()).filter(Boolean),
      effort_scale: f.effort.split(',').map((s) => s.trim()).filter(Boolean),
    }),
    onSuccess: onDone,
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <Field label="Name"><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, key: f.key || '' })} autoFocus /></Field>
      <Field label="Key" hint="Prefix for item keys, e.g. HC → HC-42"><input className={inputCls} value={f.key} onChange={(e) => setF({ ...f, key: e.target.value.toUpperCase() })} maxLength={10} /></Field>
      <Field label="Description"><textarea className={inputCls} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="Importance scale" hint="Exactly 4 labels, lowest first"><input className={inputCls} value={f.importance} onChange={(e) => setF({ ...f, importance: e.target.value })} /></Field>
      <Field label="Effort scale" hint="Smallest first"><input className={inputCls} value={f.effort} onChange={(e) => setF({ ...f, effort: e.target.value })} /></Field>
      <ErrorText error={create.error} />
      <Button variant="primary" className="w-full" disabled={!f.key || !f.name || create.isPending}>Create project</Button>
    </form>
  );
}

export function Projects() {
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const { data } = useQuery({ queryKey: ['projects'], queryFn: () => api.get<ProjectSummary[]>('/projects') });
  return (
    <Page title="Projects" wide actions={<Button small variant="ghost" onClick={() => setAdding(true)}>+ New</Button>}>
      {data && !data.length && <Empty>No projects yet. Create one to start.</Empty>}
      {/* phone: one list; desktop: a grid of cards */}
      <Card className="mt-3 lg:mt-5 lg:grid lg:grid-cols-2 xl:grid-cols-3 lg:gap-3 lg:border-0 lg:bg-transparent">
        {data?.map((p) => (
          <Link key={p.id} to={`/p/${p.key}`} className="flex items-center gap-3 px-3 py-3 border-b border-line last:border-b-0 active:bg-raised lg:rounded-xl lg:border lg:last:border-b lg:bg-panel lg:px-4 lg:py-4 hover:border-faint">
            <ProjectBadge project={p} size={36} />
            <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex-1 font-medium truncate">{p.name}</span>
              {!!p.counts?.waiting && <Chip tone="wait">{p.counts.waiting} waiting</Chip>}
              {!!p.counts?.running && !p.counts.waiting && <Chip tone="run">{p.counts.running} running</Chip>}
              {!!p.counts?.queued && !p.counts.waiting && !p.counts.running && <Chip>{p.counts.queued} queued</Chip>}
            </div>
            <div className="text-[13px] text-muted mt-0.5">
              <ProjectKey k={p.key} className="mr-1.5" />{p.counts?.backlog ?? 0} backlog · {p.counts?.bugs ?? 0} bugs · {p.repos.length} repo{p.repos.length === 1 ? '' : 's'}
            </div>
            </div>
          </Link>
        ))}
      </Card>
      <Sheet open={adding} onClose={() => setAdding(false)} title="New project">
        <NewProject onDone={(p) => nav(`/p/${p.key}`)} />
      </Sheet>
    </Page>
  );
}
