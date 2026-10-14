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
    <Page title="Projects" actions={<Button small variant="ghost" onClick={() => setAdding(true)}>+ New</Button>}>
      {data && !data.length && <Empty>No projects yet. Create one to start.</Empty>}
      <Card className="mt-3">
        {data?.map((p) => (
          <Link key={p.id} to={`/p/${p.key}`} className="block px-3 py-3 border-b border-line last:border-b-0 active:bg-raised">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-semibold text-accent w-10">{p.key}</span>
              <span className="flex-1 font-medium truncate">{p.name}</span>
              {!!p.counts?.waiting && <Chip tone="wait">{p.counts.waiting} waiting</Chip>}
              {!!p.counts?.active_sessions && !p.counts.waiting && <Chip tone="run">{p.counts.active_sessions} live</Chip>}
            </div>
            <div className="text-[13px] text-muted mt-0.5 pl-12">
              {p.counts?.backlog ?? 0} backlog · {p.counts?.bugs ?? 0} bugs · {p.repos.length} repo{p.repos.length === 1 ? '' : 's'}
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
