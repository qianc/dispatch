import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SOURCE_KINDS, type ItemType } from '../../../src/shared/types.ts';
import { api, type Item, type ProjectSummary, type Repo, type Session, type SourceSummary } from '../api.ts';
import { Page } from '../components/Layout.tsx';
import { ItemRow, NewItemForm, SessionRow } from '../components/items.tsx';
import { Button, Card, Chip, Empty, ErrorText, Field, Section, Segmented, Sheet, cx, inputCls, timeAgo } from '../components/ui.tsx';

type Tab = 'backlog' | 'bugs' | 'sessions' | 'sources' | 'settings';
const OPEN = ['triage', 'backlog', 'todo', 'in_progress', 'in_review'];

export function Project() {
  const { key = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'backlog';
  const nav = useNavigate();
  const [sheet, setSheet] = useState<null | 'item' | 'batch' | 'planner'>(null);
  const { data: project } = useQuery({ queryKey: ['project', key], queryFn: () => api.get<ProjectSummary>(`/projects/${key}`) });
  const { data: items = [] } = useQuery({
    queryKey: ['items', project?.id],
    queryFn: () => api.get<Item[]>(`/projects/${key}/items`),
    enabled: !!project,
  });
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (it: Item) => api.patch<Item>(`/items/${it.id}`, { marked: !it.marked }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['items', project?.id] }),
  });
  if (!project) return <Page title={key} back="/projects"><Empty>Loading…</Empty></Page>;

  const marked = items.filter((i) => i.marked);
  const type: ItemType = tab === 'bugs' ? 'bug' : 'backlog';

  return (
    <Page
      title={project.name}
      subtitle={project.key}
      back="/projects"
      actions={
        <>
          <Button small variant="ghost" onClick={() => setSheet('planner')} aria-label="Plan with Claude">💬 Plan</Button>
          {(tab === 'backlog' || tab === 'bugs') && <Button small variant="ghost" onClick={() => setSheet('item')} aria-label="New item">+</Button>}
        </>
      }
      footer={marked.length > 0 && (tab === 'backlog' || tab === 'bugs') ? (
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="flex-1 text-[14px]">{marked.length} marked for the agent</span>
          <Button small onClick={() => marked.forEach((m) => toggle.mutate(m))}>Clear</Button>
          <Button small variant="primary" onClick={() => setSheet('batch')}>Start batch</Button>
        </div>
      ) : undefined}
    >
      <div className="px-3 pt-3 overflow-x-auto">
        <Segmented<Tab>
          value={tab}
          onChange={(t) => setParams({ tab: t }, { replace: true })}
          options={[
            { value: 'backlog', label: 'Backlog' },
            { value: 'bugs', label: 'Bugs' },
            { value: 'sessions', label: 'Sessions' },
            { value: 'sources', label: 'Sources' },
            { value: 'settings', label: 'Settings' },
          ]}
        />
      </div>

      {(tab === 'backlog' || tab === 'bugs') && <ItemList items={items.filter((i) => i.type === type)} project={project} onToggle={(it) => toggle.mutate(it)} />}
      {tab === 'sessions' && <ProjectSessions project={project} />}
      {tab === 'sources' && <Sources project={project} />}
      {tab === 'settings' && <ProjectSettings project={project} />}

      <Sheet open={sheet === 'item'} onClose={() => setSheet(null)} title={tab === 'bugs' ? 'New bug' : 'New backlog item'}>
        <NewItemForm project={project} type={type} onDone={() => setSheet(null)} />
      </Sheet>
      <Sheet open={sheet === 'batch'} onClose={() => setSheet(null)} title="Start batch">
        <BatchForm project={project} items={marked} onStarted={(s) => nav(`/s/${s.id}`)} />
      </Sheet>
      <Sheet open={sheet === 'planner'} onClose={() => setSheet(null)} title="Plan with Claude">
        <PlannerForm project={project} onStarted={(s) => nav(`/s/${s.id}`)} />
      </Sheet>
    </Page>
  );
}

function ItemList({ items, project, onToggle }: { items: Item[]; project: ProjectSummary; onToggle: (it: Item) => void }) {
  const [showClosed, setShowClosed] = useState(false);
  const open = items.filter((i) => OPEN.includes(i.status));
  const closed = items.filter((i) => !OPEN.includes(i.status));
  const groups = [
    { title: 'In review', items: open.filter((i) => i.status === 'in_review') },
    { title: 'In progress', items: open.filter((i) => i.status === 'in_progress') },
    { title: 'Todo', items: open.filter((i) => i.status === 'todo') },
    { title: 'Triage', items: open.filter((i) => i.status === 'triage') },
    { title: 'Backlog', items: open.filter((i) => i.status === 'backlog').sort((a, b) => b.importance - a.importance || b.number - a.number) },
  ].filter((g) => g.items.length);
  return (
    <>
      {!open.length && <Empty>Nothing open. Tap + to add one.</Empty>}
      {groups.map((g) => (
        <Section key={g.title} title={`${g.title} · ${g.items.length}`}>
          <Card>{g.items.map((it) => <ItemRow key={it.id} item={it} project={project} selectable onToggle={onToggle} />)}</Card>
        </Section>
      ))}
      {closed.length > 0 && (
        <Section title={`Closed · ${closed.length}`} action={<button className="text-[12px] text-accent" onClick={() => setShowClosed(!showClosed)}>{showClosed ? 'Hide' : 'Show'}</button>}>
          {showClosed && <Card>{closed.map((it) => <ItemRow key={it.id} item={it} project={project} />)}</Card>}
        </Section>
      )}
    </>
  );
}

function BatchForm({ project, items, onStarted }: { project: ProjectSummary; items: Item[]; onStarted: (s: Session) => void }) {
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [forcePlan, setForcePlan] = useState(project.default_force_plan);
  const start = useMutation({
    mutationFn: () => api.post<Session>(`/projects/${project.key}/batches`, { item_ids: items.map((i) => i.id), prompt, title: title || undefined, force_plan: forcePlan }),
    onSuccess: onStarted,
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
      <p className="text-[13px] text-muted mb-3">One Claude session works through these items on one branch and opens one PR per changed repo.</p>
      <ul className="mb-3 space-y-1">
        {items.map((i) => <li key={i.id} className="text-[14px]"><span className="text-faint mr-2">{i.key}</span>{i.title}</li>)}
      </ul>
      <Field label="Title (optional)"><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={items.map((i) => i.key).join(', ')} /></Field>
      <Field label="Extra instructions"><textarea className={cx(inputCls, 'min-h-20')} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></Field>
      <label className="flex items-center gap-2 mb-4 text-[14px]">
        <input type="checkbox" checked={forcePlan} onChange={(e) => setForcePlan(e.target.checked)} className="size-4 accent-[var(--color-accent-strong)]" />
        Plan first (Claude writes a plan and waits for approval)
      </label>
      {!project.repos.length && <p className="text-wait text-sm mb-2">Add a repo in Settings first.</p>}
      <ErrorText error={start.error} />
      <Button variant="primary" className="w-full" disabled={start.isPending || !project.repos.length}>Start session</Button>
    </form>
  );
}

function PlannerForm({ project, onStarted }: { project: ProjectSummary; onStarted: (s: Session) => void }) {
  const [prompt, setPrompt] = useState('');
  const start = useMutation({ mutationFn: () => api.post<Session>(`/projects/${project.key}/planner`, { prompt }), onSuccess: onStarted });
  return (
    <form onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
      <p className="text-[13px] text-muted mb-3">Claude reads the code and the tracker (no changes) and proposes the next batch as a card you can edit and start.</p>
      <Field label="What do you want to focus on? (optional)">
        <textarea className={cx(inputCls, 'min-h-24')} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. quick wins before the release" />
      </Field>
      <ErrorText error={start.error} />
      <Button variant="primary" className="w-full" disabled={start.isPending}>Start planning chat</Button>
    </form>
  );
}

function ProjectSessions({ project }: { project: ProjectSummary }) {
  const { data = [] } = useQuery({ queryKey: ['sessions', 'project', project.key], queryFn: () => api.get<Session[]>(`/sessions?project=${project.key}`) });
  return data.length ? <Card className="mt-3">{data.map((s) => <SessionRow key={s.id} s={s} />)}</Card> : <Empty>No sessions yet.</Empty>;
}

function Sources({ project }: { project: ProjectSummary }) {
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const { data = [] } = useQuery({ queryKey: ['sources', project.id], queryFn: () => api.get<SourceSummary[]>(`/projects/${project.key}/sources`) });
  return (
    <>
      <div className="px-3 mt-3"><Button className="w-full" onClick={() => setAdding(true)}>+ Capture retro or report</Button></div>
      {!data.length && <Empty>Sources are retros, skill-run reports and user reports. Items split from them link back here.</Empty>}
      {data.length > 0 && (
        <Card className="mt-3">
          {data.map((s) => (
            <Link key={s.id} to={`/sources/${s.id}`} className="block px-3 py-2.5 border-b border-line last:border-b-0 active:bg-raised">
              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate font-medium">{s.title}</span>
                <Chip>{s.kind.replace('_', ' ')}</Chip>
              </div>
              <div className="text-[13px] text-muted mt-0.5">
                {[s.reporter, s.version_tag, s.skill_name].filter(Boolean).join(' · ') || '—'} · {s.item_count} items · {timeAgo(s.created_at)}
              </div>
            </Link>
          ))}
        </Card>
      )}
      <Sheet open={adding} onClose={() => setAdding(false)} title="Capture source">
        <NewSourceForm project={project} onDone={(id) => nav(`/sources/${id}`)} />
      </Sheet>
    </>
  );
}

function NewSourceForm({ project, onDone }: { project: ProjectSummary; onDone: (id: number) => void }) {
  const [f, setF] = useState({ kind: 'retro', title: '', body_md: '', reporter: '', version_tag: '', skill_name: '' });
  const create = useMutation({
    mutationFn: () => api.post<{ id: number }>(`/projects/${project.key}/sources`, {
      ...f, reporter: f.reporter || null, version_tag: f.version_tag || null, skill_name: f.skill_name || null,
    }),
    onSuccess: (s) => onDone(s.id),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <Field label="Kind">
        <select className={inputCls} value={f.kind} onChange={set('kind')}>
          {SOURCE_KINDS.filter((k) => k !== 'agent_session').map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
        </select>
      </Field>
      <Field label="Title"><input className={inputCls} value={f.title} onChange={set('title')} autoFocus /></Field>
      <div className="grid grid-cols-2 gap-x-2">
        <Field label="Reporter"><input className={inputCls} value={f.reporter} onChange={set('reporter')} placeholder="who" /></Field>
        <Field label="Version tag"><input className={inputCls} value={f.version_tag} onChange={set('version_tag')} placeholder="v1.4.2" /></Field>
      </div>
      <Field label="Skill (if from a skill run)"><input className={inputCls} value={f.skill_name} onChange={set('skill_name')} /></Field>
      <Field label="Retro / report text (markdown)"><textarea className={cx(inputCls, 'min-h-48 font-mono text-[14px]')} value={f.body_md} onChange={set('body_md')} /></Field>
      <ErrorText error={create.error} />
      <Button variant="primary" className="w-full" disabled={!f.title || create.isPending}>Save source</Button>
    </form>
  );
}

function ProjectSettings({ project }: { project: ProjectSummary }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['project', project.key] });
  const [f, setF] = useState({ name: project.name, description: project.description, importance: project.importance_scale.join(', '), effort: project.effort_scale.join(', ') });
  const save = useMutation({
    mutationFn: (patch: object) => api.patch(`/projects/${project.key}`, patch),
    onSuccess: refresh,
  });
  const [repo, setRepo] = useState({ full: '', default_branch: 'main', check_command: '' });
  const addRepo = useMutation({
    mutationFn: () => {
      const [github_owner, github_name] = repo.full.replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '').split('/');
      return api.post(`/projects/${project.key}/repos`, { github_owner, github_name, default_branch: repo.default_branch, check_command: repo.check_command || null });
    },
    onSuccess: () => { setRepo({ full: '', default_branch: 'main', check_command: '' }); refresh(); },
  });
  const delRepo = useMutation({ mutationFn: (r: Repo) => api.del(`/repos/${r.id}`), onSuccess: refresh });
  return (
    <>
      <Section title="Repos">
        <Card>
          {project.repos.map((r) => (
            <div key={r.id} className="flex items-center gap-2 px-3 py-2.5 border-b border-line">
              <div className="flex-1 min-w-0">
                <div className="truncate">{r.github_owner}/{r.github_name}</div>
                <div className="text-[12px] text-muted truncate">base {r.default_branch}{r.check_command ? ` · check: ${r.check_command}` : ''}</div>
              </div>
              <Button small variant="ghost" onClick={() => confirm(`Remove ${r.github_name}?`) && delRepo.mutate(r)}>Remove</Button>
            </div>
          ))}
          <form className="p-3 space-y-2" onSubmit={(e) => { e.preventDefault(); addRepo.mutate(); }}>
            <input className={inputCls} placeholder="owner/repo" value={repo.full} onChange={(e) => setRepo({ ...repo, full: e.target.value })} aria-label="Repository" />
            <div className="grid grid-cols-2 gap-2">
              <input className={inputCls} placeholder="base branch" value={repo.default_branch} onChange={(e) => setRepo({ ...repo, default_branch: e.target.value })} aria-label="Base branch" />
              <input className={inputCls} placeholder="check cmd (optional)" value={repo.check_command} onChange={(e) => setRepo({ ...repo, check_command: e.target.value })} aria-label="Check command" />
            </div>
            <ErrorText error={addRepo.error} />
            <Button className="w-full" disabled={!repo.full.includes('/') || addRepo.isPending}>Add repo</Button>
          </form>
        </Card>
      </Section>
      <Section title="Agent & notifications">
        <Card className="p-3 space-y-3">
          <label className="flex items-center justify-between text-[14px]">
            Plan first by default
            <input type="checkbox" checked={project.default_force_plan} onChange={(e) => save.mutate({ default_force_plan: e.target.checked })} className="size-5 accent-[var(--color-accent-strong)]" />
          </label>
          <label className="flex items-center justify-between text-[14px]">
            Mute push notifications
            <input type="checkbox" checked={project.muted} onChange={(e) => save.mutate({ muted: e.target.checked })} className="size-5 accent-[var(--color-accent-strong)]" />
          </label>
        </Card>
      </Section>
      <Section title="Project">
        <form className="mx-3" onSubmit={(e) => {
          e.preventDefault();
          save.mutate({
            name: f.name, description: f.description,
            importance_scale: f.importance.split(',').map((s) => s.trim()).filter(Boolean),
            effort_scale: f.effort.split(',').map((s) => s.trim()).filter(Boolean),
          });
        }}>
          <Field label="Name"><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Description"><textarea className={inputCls} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label="Importance scale" hint="Exactly 4 labels, lowest first"><input className={inputCls} value={f.importance} onChange={(e) => setF({ ...f, importance: e.target.value })} /></Field>
          <Field label="Effort scale" hint="Smallest first. Existing items keep their index."><input className={inputCls} value={f.effort} onChange={(e) => setF({ ...f, effort: e.target.value })} /></Field>
          <ErrorText error={save.error} />
          <Button className="w-full" disabled={save.isPending}>Save</Button>
        </form>
      </Section>
    </>
  );
}
