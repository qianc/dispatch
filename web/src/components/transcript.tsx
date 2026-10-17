import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Proposal, ProposedItem, Question, SessionEventBody } from '../../../src/shared/types.ts';
import { api, type Item, type PendingInput, type Project, type Session, type SessionEvent } from '../api.ts';
import { Button, Chip, ErrorText, ITEM_STATUS_LABEL, ImportanceIcon, Md, cx, inputCls } from './ui.tsx';
import { effortLabel } from './items.tsx';
import { RichMd } from './RichMd.tsx';
import { HIDDEN_TOOLS, groupWork } from './turns.ts';
import { Lightbox } from './images.tsx';
import { RunOptionsFields, runOptionsSummary, useRunOptions } from './batch.tsx';


/** One assistant message. Memoized on primitives so a refetch does not re-parse every message's markdown. */
const AssistantText = memo(function AssistantText({ text, projectId, projectKey, sourceId }: { text: string; projectId?: number; projectKey?: string; sourceId: number | null }) {
  return projectId && projectKey ? <RichMd ctx={{ project: { id: projectId, key: projectKey }, sourceId }}>{text}</RichMd> : <Md>{text}</Md>;
});

type ToolUse = Extract<SessionEventBody, { kind: 'tool_use' }>;
type ToolResult = Extract<SessionEventBody, { kind: 'tool_result' }>;

function Thumbs({ images }: { images: { url: string }[] }) {
  const [full, setFull] = useState<string | null>(null);
  return (
    <div className="ml-3.5 mb-1 flex flex-wrap gap-2">
      {images.map((img) => (
        <button key={img.url} onClick={() => setFull(img.url)} className="rounded-lg overflow-hidden border border-line bg-raised" aria-label="Show image">
          <img src={img.url} alt="" loading="lazy" className="h-24 max-w-[60vw] object-cover" />
        </button>
      ))}
      {full && <Lightbox src={full} onClose={() => setFull(null)} />}
    </div>
  );
}

function ToolRow({ use, result }: { use: ToolUse; result?: ToolResult }) {
  const [open, setOpen] = useState(false);
  const name = use.name.replace(/^mcp__dispatch__/, '');
  return (
    <div className="my-0.5">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 text-left text-[13px] py-1 text-muted" aria-expanded={open}>
        <span className={cx('size-1.5 rounded-full shrink-0', !result ? 'bg-run animate-pulse' : result.is_error ? 'bg-bad' : 'bg-faint')} />
        <span className="font-medium text-fg/80 shrink-0">{name}</span>
        <span className="truncate font-mono text-[12px]">{use.summary}</span>
      </button>
      {result?.images?.length ? <Thumbs images={result.images} /> : null}
      {open && (
        <div className="ml-3.5 mb-2 rounded-lg bg-raised p-2 text-[12px] font-mono whitespace-pre-wrap break-all max-h-80 overflow-y-auto">
          {JSON.stringify(use.input, null, 2)}
          {result && <div className={cx('mt-2 pt-2 border-t border-line', result.is_error && 'text-bad')}>{result.text || '(no output)'}</div>}
        </div>
      )}
    </div>
  );
}

function WorkGroup({ events, live, render, results }: { events: SessionEvent[]; live: boolean; render: (e: SessionEvent) => ReactNode; results: Map<string, ToolResult> }) {
  const [open, setOpen] = useState(live);
  useEffect(() => { if (!live) setOpen(false); }, [live]);
  const uses = events.flatMap((e) => (e.body.kind === 'tool_use' && !HIDDEN_TOOLS.has(e.body.name) ? [e.body] : []));
  const failed = uses.filter((u) => results.get(u.tool_use_id)?.is_error).length;
  const names = [...new Set(uses.map((u) => u.name.replace(/^mcp__dispatch__/, '')))].slice(0, 4).join(', ');
  const images = uses.flatMap((u) => results.get(u.tool_use_id)?.images ?? []);
  return (
    <div className="rounded-lg border border-line/70">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-muted" aria-expanded={open}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={cx('shrink-0 transition-transform', open && 'rotate-90')}><path d="M9 6l6 6-6 6" /></svg>
        <span className="font-medium shrink-0">{live ? 'Working' : 'Worked'} · {uses.length} step{uses.length === 1 ? '' : 's'}</span>
        <span className="truncate text-faint">{names}</span>
        {failed > 0 && <span className="text-bad shrink-0">{failed} failed</span>}
      </button>
      {open ? (
        <div className="px-2.5 pb-2 space-y-2 border-t border-line/70 pt-2 text-[14px] text-muted">{events.map(render)}</div>
      ) : images.length > 0 && <div className="pb-2"><Thumbs images={images} /></div>}
    </div>
  );
}

export function Transcript({ session, events, inputs, project }: { session: Session; events: SessionEvent[]; inputs: PendingInput[]; project: Project | null }) {
  const results = useMemo(() => {
    const m = new Map<string, ToolResult>();
    for (const e of events) if (e.body.kind === 'tool_result') m.set(e.body.tool_use_id, e.body);
    return m;
  }, [events]);
  const units = useMemo(() => groupWork(events, session.status === 'running'), [events, session.status]);
  const inputById = new Map(inputs.map((i) => [i.id, i]));
  const proposalDone = new Map<number, string>();
  for (const e of events) if (e.body.kind === 'proposal_done') proposalDone.set(e.body.event_id, e.body.note);
  const render = (e: SessionEvent): ReactNode => {
    const b = e.body;
    switch (b.kind) {
      case 'user':
        return (
          <div key={e.seq} className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-strong/25 border border-accent/20 px-3 py-2 whitespace-pre-wrap">{b.text}</div>
          </div>
        );
      case 'assistant':
        return <AssistantText key={e.seq} text={b.text} projectId={project?.id} projectKey={project?.key} sourceId={session.source_id} />;
      case 'tool_use':
        return HIDDEN_TOOLS.has(b.name) ? null : <ToolRow key={e.seq} use={b} result={results.get(b.tool_use_id)} />;
      case 'tool_result':
        return null;
      case 'result':
        return (
          <div key={e.seq} className="flex items-center gap-2 text-[11px] text-faint py-1">
            <div className="h-px flex-1 bg-line" />
            {b.subtype === 'success' ? 'turn finished' : b.subtype.replace(/_/g, ' ')}
            {typeof b.cost_usd === 'number' && b.cost_usd > 0 && ` · $${b.cost_usd.toFixed(2)}`}
            <div className="h-px flex-1 bg-line" />
          </div>
        );
      case 'system':
        return <div key={e.seq} className="text-[12px] text-faint text-center">{b.text}</div>;
      case 'error':
        return <div key={e.seq} className="text-[13px] text-bad rounded-lg bg-bad/10 border border-bad/20 px-3 py-2 whitespace-pre-wrap">{b.text}</div>;
      case 'input_request': {
        const input = inputById.get(b.input_id);
        return input ? <InputCard key={e.seq} input={input} /> : null;
      }
      case 'proposal':
        return <ProposalLoader key={e.seq} eventId={e.id} done={proposalDone.get(e.id) ?? null} proposal={b.proposal} session={session} project={project} />;
      case 'proposal_done':
        return null;
    }
  };
  return (
    <div className="px-4 py-3 space-y-2">
      {units.map((u) =>
        u.t === 'event' ? render(u.e)
        : u.t === 'pending_proposal' ? <p key={`p-${u.key}`} className="text-[13px] text-accent animate-pulse">Claude is writing up a proposal…</p>
        : <WorkGroup key={`w-${u.key}`} events={u.events} live={u.live} render={render} results={results} />)}
    </div>
  );
}

// ---------- questions & plan approval ----------

function QuestionBlock({ q, value, onChange, disabled }: { q: Question; value: string; onChange: (v: string) => void; disabled: boolean }) {
  const picked = q.multiSelect ? value.split(', ').filter(Boolean) : [value];
  const known = new Set(q.options.map((o) => o.label));
  const other = picked.filter((p) => p && !known.has(p)).join(', ');
  const toggle = (label: string) => {
    if (!q.multiSelect) return onChange(label);
    const set = new Set(picked.filter((p) => known.has(p)));
    if (set.has(label)) set.delete(label);
    else set.add(label);
    onChange([...set, ...(other ? [other] : [])].join(', '));
  };
  return (
    <div className="mb-3 last:mb-0">
      <Chip tone="wait" className="mb-1">{q.header}</Chip>
      <p className="font-medium mb-2">{q.question}</p>
      <div className="space-y-1.5">
        {q.options.map((o) => {
          const on = picked.includes(o.label);
          return (
            <button
              key={o.label}
              type="button"
              disabled={disabled}
              onClick={() => toggle(o.label)}
              aria-pressed={on}
              className={cx('w-full text-left rounded-lg border px-3 py-2', on ? 'border-accent bg-accent/10' : 'border-line bg-bg', disabled && 'opacity-60')}
            >
              <div className="font-medium text-[14px]">{o.label}</div>
              {o.description && <div className="text-[13px] text-muted">{o.description}</div>}
              {o.preview && on && <pre className="mt-2 text-[12px] font-mono whitespace-pre-wrap bg-raised rounded p-2">{o.preview}</pre>}
            </button>
          );
        })}
        <input
          className={inputCls}
          placeholder="Other…"
          disabled={disabled}
          value={other}
          onChange={(e) => onChange(q.multiSelect ? [...picked.filter((p) => known.has(p)), e.target.value].filter(Boolean).join(', ') : e.target.value)}
        />
      </div>
    </div>
  );
}

export function InputCard({ input }: { input: PendingInput }) {
  const qc = useQueryClient();
  const open = !input.answered_at && !input.expired;
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    input.answer?.kind === 'question' ? input.answer.answers : {},
  );
  const [feedback, setFeedback] = useState('');
  const send = useMutation({
    mutationFn: (body: unknown) => api.post(`/inputs/${input.id}/answer`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session', input.session_id] }),
  });
  const p = input.payload;
  return (
    <div className={cx('rounded-xl border p-3', open ? 'border-wait/50 bg-wait/5' : 'border-line bg-panel')}>
      {!open && (
        <div className="text-[12px] text-faint mb-2">{input.expired ? 'Closed without an answer' : 'Answered'}</div>
      )}
      {p.kind === 'question' ? (
        <>
          {p.questions.map((q) => (
            <QuestionBlock key={q.question} q={q} value={answers[q.question] ?? ''} disabled={!open} onChange={(v) => setAnswers({ ...answers, [q.question]: v })} />
          ))}
          {open && (
            <Button
              variant="primary"
              className="w-full mt-3"
              disabled={send.isPending || p.questions.some((q) => !answers[q.question]?.trim())}
              onClick={() => send.mutate({ kind: 'question', answers })}
            >
              Send answer
            </Button>
          )}
        </>
      ) : (
        <>
          <div className="text-[12px] font-semibold uppercase tracking-wide text-wait mb-1">Plan for approval</div>
          <Md className="text-[14px]">{p.plan}</Md>
          {input.answer?.kind === 'plan_approval' && (
            <p className="mt-2 text-[13px] text-muted">{input.answer.approve ? 'Approved' : `Changes requested: ${input.answer.feedback ?? ''}`}</p>
          )}
          {open && (
            <div className="mt-3 space-y-2">
              <textarea className={cx(inputCls, 'min-h-16')} placeholder="Feedback (for changes)" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
              <div className="flex gap-2">
                <Button className="flex-1" disabled={send.isPending || !feedback.trim()} onClick={() => send.mutate({ kind: 'plan_approval', approve: false, feedback })}>Request changes</Button>
                <Button variant="primary" className="flex-1" disabled={send.isPending} onClick={() => send.mutate({ kind: 'plan_approval', approve: true })}>Approve</Button>
              </div>
            </div>
          )}
        </>
      )}
      <ErrorText error={send.error} />
    </div>
  );
}

// ---------- proposals ----------

/** Markdown as one line of plain text, for short previews. */
function plainExcerpt(md: string) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function ProposedItemRow({ item, project, on, toggle }: { item: ProposedItem; project: Project; on: boolean; toggle: () => void }) {
  return (
    <button type="button" onClick={toggle} aria-pressed={on} className="w-full flex items-start gap-2 py-1.5 text-left">
      <span className={cx('mt-0.5 size-4 rounded border shrink-0', on ? 'bg-accent-strong border-accent-strong' : 'border-line')} />
      <ImportanceIcon value={item.importance} label={project.importance_scale[item.importance - 1]} />
      <span className="flex-1 min-w-0">
        <span className="block text-[14px] [overflow-wrap:anywhere]">{item.title}</span>
        {item.body_md && <span className="text-[12px] text-muted line-clamp-2 [overflow-wrap:anywhere]">{plainExcerpt(item.body_md)}</span>}
      </span>
      {item.type === 'bug' && <Chip tone="bad">Bug</Chip>}
      {effortLabel(project, item.effort) && <Chip>{effortLabel(project, item.effort)}</Chip>}
    </button>
  );
}

/** Assistant proposals name their project; others belong to the session's project. */
function ProposalLoader(props: { eventId: number; done: string | null; proposal: Proposal; session: Session; project: Project | null }) {
  const key = 'project_key' in props.proposal ? props.proposal.project_key : undefined;
  const { data: loaded } = useQuery({ queryKey: ['project', key], queryFn: () => api.get<Project>(`/projects/${key}`), enabled: !!key });
  const project = key ? loaded : props.project;
  if (!project) return null;
  if (props.proposal.type === 'planner') return <PlannerProposalCard {...props} proposal={props.proposal} project={project} />;
  if (props.proposal.type === 'item_update') return <ItemUpdateCard {...props} proposal={props.proposal} project={project} />;
  return <ProposalCard {...props} proposal={props.proposal} project={project} />;
}

const FIELD_LABEL: Record<string, string> = { title: 'Title', body_md: 'Description', type: 'Type', status: 'Status', importance: 'Importance', effort: 'Effort', labels: 'Tags', modules: 'Modules' };

/** A change to an item that a Discuss chat suggests: old → new for each field, a comment, Apply / Dismiss. */
function ItemUpdateCard({ eventId, done, proposal, session, project }: { eventId: number; done: string | null; proposal: Extract<Proposal, { type: 'item_update' }>; session: Session; project: Project }) {
  const qc = useQueryClient();
  const [showBody, setShowBody] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['session', session.id] });
    qc.invalidateQueries({ queryKey: ['item', proposal.item_id] });
    qc.invalidateQueries({ queryKey: ['items', project.id] });
  };
  const apply = useMutation({ mutationFn: () => api.post(`/sessions/${session.id}/apply-update`, { event_id: eventId }), onSuccess: refresh });
  const dismiss = useMutation({ mutationFn: () => api.post(`/sessions/${session.id}/dismiss-proposal`, { event_id: eventId }), onSuccess: refresh });
  const show = (field: string, v: unknown): string => {
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return '—';
    if (field === 'importance') return project.importance_scale[Number(v) - 1] ?? String(v);
    if (field === 'effort') return project.effort_scale[Number(v)] ?? String(v);
    if (field === 'status') return ITEM_STATUS_LABEL[v as keyof typeof ITEM_STATUS_LABEL] ?? String(v);
    if (Array.isArray(v)) return v.join(', ');
    return String(v);
  };
  const fields = Object.keys(proposal.changes) as (keyof typeof proposal.changes)[];
  const replaced = !!done && /^(Replaced|Not used|Dismissed)/.test(done);
  return (
    <div className={cx('rounded-xl border border-accent/40 bg-accent/5 p-3', replaced && 'opacity-60')}>
      <div className="text-[12px] font-semibold uppercase tracking-wide text-accent mb-1">Suggested change · {proposal.item_key}</div>
      {proposal.reason && <p className="text-[13px] text-muted mb-2">{proposal.reason}</p>}
      <div className="space-y-1.5 text-[14px]">
        {fields.filter((f) => f !== 'body_md').map((f) => (
          <div key={f} className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[12px] text-faint w-20 shrink-0">{FIELD_LABEL[f]}</span>
            <span className="line-through text-faint">{show(f, proposal.before[f])}</span>
            <span aria-hidden="true">→</span>
            <span className="font-medium">{show(f, proposal.changes[f])}</span>
          </div>
        ))}
        {proposal.changes.body_md !== undefined && (
          <div>
            <button className="text-[13px] text-accent" onClick={() => setShowBody(!showBody)}>{showBody ? 'Hide' : 'Show'} the new description</button>
            {showBody && <div className="mt-1.5 rounded-lg bg-panel border border-line p-2.5"><Md className="text-[13.5px]">{proposal.changes.body_md}</Md></div>}
          </div>
        )}
        {proposal.comment && (
          <div>
            <div className="text-[12px] text-faint mb-1">New comment</div>
            <div className="rounded-lg bg-panel border border-line p-2.5"><Md className="text-[13.5px]">{proposal.comment}</Md></div>
          </div>
        )}
      </div>
      {done ? (
        <p className={cx('mt-2 text-[13px]', replaced ? 'text-faint' : 'text-ok')}>{done}</p>
      ) : (
        <div className="flex gap-2 mt-3">
          <Button variant="primary" className="flex-1" disabled={apply.isPending || dismiss.isPending} onClick={() => apply.mutate()}>Apply</Button>
          <Button disabled={apply.isPending || dismiss.isPending} onClick={() => dismiss.mutate()}>Dismiss</Button>
        </div>
      )}
      <ErrorText error={apply.error ?? dismiss.error} />
    </div>
  );
}

function PlannerProposalCard({ eventId, done, proposal, session, project }: { eventId: number; done: string | null; proposal: Extract<Proposal, { type: 'planner' }>; session: Session; project: Project }) {
  const nav = useNavigate();
  const [prompt, setPrompt] = useState(proposal.prompt);
  const start = useMutation({
    mutationFn: () => api.post<Session>(`/projects/${project.key}/planner`, { prompt, proposal: { session_id: session.id, event_id: eventId } }),
    onSuccess: (s) => nav(`/s/${s.id}`),
  });
  return (
    <div className="rounded-xl border border-accent/40 bg-accent/5 p-3">
      <div className="text-[12px] font-semibold uppercase tracking-wide text-accent mb-2">Planning chat · {project.name}</div>
      {done ? (
        <p className={cx('text-[13px]', /^(Replaced|Not used)/.test(done) ? 'text-faint' : 'text-ok')}>{done}</p>
      ) : (
        <>
          <textarea className={cx(inputCls, 'min-h-16 text-[14px]')} placeholder="Focus (optional)" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <Button variant="primary" className="w-full mt-3" disabled={start.isPending} onClick={() => start.mutate()}>Start planning chat</Button>
        </>
      )}
      <ErrorText error={start.error} />
    </div>
  );
}

function ProposalCard({ eventId, done, proposal, session, project }: { eventId: number; done: string | null; proposal: Exclude<Proposal, { type: 'planner' } | { type: 'item_update' }>; session: Session; project: Project }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data: items = [] } = useQuery({
    queryKey: ['items', project.id],
    queryFn: () => api.get<Item[]>(`/projects/${project.key}/items`),
    enabled: proposal.type === 'batch',
  });
  const [picked, setPicked] = useState<Set<number>>(() => new Set(proposal.type === 'batch' ? proposal.item_ids : []));
  const newItems = proposal.type === 'batch' ? proposal.new_items : proposal.items;
  const [pickedNew, setPickedNew] = useState<Set<number>>(() => new Set(newItems.map((_, i) => i)));
  const [title, setTitle] = useState(proposal.type === 'batch' ? proposal.title : '');
  const [prompt, setPrompt] = useState(proposal.type === 'batch' ? proposal.prompt : '');
  const [forcePlan, setForcePlan] = useState(proposal.type === 'batch' ? proposal.force_plan : false);
  const [options, setOptions] = useRunOptions(project.key);
  const [showOptions, setShowOptions] = useState(false);

  const start = useMutation({
    mutationFn: () =>
      api.post<Session>(`/projects/${project.key}/batches`, {
        title, item_ids: [...picked], new_items: newItems.filter((_, i) => pickedNew.has(i)), prompt, force_plan: forcePlan, options,
        proposal: { session_id: session.id, event_id: eventId },
      }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['items', project.id] });
      nav(`/s/${s.id}`);
    },
  });
  const create = useMutation({
    mutationFn: () =>
      api.post<Item[]>(`/sessions/${session.id}/accept-items`, {
        items: newItems.filter((_, i) => pickedNew.has(i)),
        source_id: proposal.type === 'items' ? proposal.source_id : null,
        event_id: eventId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items', project.id] });
    },
  });

  const toggle = <T,>(set: Set<T>, v: T, apply: (s: Set<T>) => void) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    apply(n);
  };
  const existing = items.filter((i) => picked.has(i.id) || (proposal.type === 'batch' && proposal.item_ids.includes(i.id)));
  const replaced = !!done && /^(Replaced|Not used)/.test(done);

  return (
    <div className={cx('rounded-xl border border-accent/40 bg-accent/5 p-3', replaced && 'opacity-60')}>
      <div className="text-[12px] font-semibold uppercase tracking-wide text-accent mb-2">
        {proposal.type === 'batch' ? 'Proposed batch' : 'Proposed items'}{session.kind === 'assistant' && ` · ${project.name}`}
      </div>
      {proposal.type === 'batch' && (
        <input className={cx(inputCls, 'mb-2 font-medium')} value={title} onChange={(e) => setTitle(e.target.value)} disabled={!!done} aria-label="Batch title" />
      )}
      {existing.map((it) => (
        <button key={it.id} type="button" disabled={!!done} onClick={() => toggle(picked, it.id, setPicked)} aria-pressed={picked.has(it.id)} className="w-full flex items-center gap-2 py-1.5 text-left">
          <span className={cx('size-4 rounded border shrink-0', picked.has(it.id) ? 'bg-accent-strong border-accent-strong' : 'border-line')} />
          <ImportanceIcon value={it.importance} />
          <span className="text-[12px] text-faint">{it.key}</span>
          <span className="flex-1 min-w-0 truncate text-[14px]">{it.title}</span>
          {effortLabel(project, it.effort) && <Chip>{effortLabel(project, it.effort)}</Chip>}
        </button>
      ))}
      {newItems.length > 0 && proposal.type === 'batch' && <div className="text-[12px] text-muted mt-2">New items</div>}
      {newItems.map((it, i) => (
        <ProposedItemRow key={i} item={it} project={project} on={pickedNew.has(i)} toggle={() => !done && toggle(pickedNew, i, setPickedNew)} />
      ))}
      {proposal.type === 'batch' && !done && (
        <>
          <textarea className={cx(inputCls, 'mt-2 min-h-16 text-[14px]')} placeholder="Instructions for the session" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <label className="flex items-center gap-2 mt-2 text-[14px]">
            <input type="checkbox" checked={forcePlan} onChange={(e) => setForcePlan(e.target.checked)} className="size-4 accent-[var(--color-accent-strong)]" />
            Plan first (spec + approval before code)
          </label>
          <button type="button" className="mt-2 text-[13px] text-accent" onClick={() => setShowOptions(!showOptions)} aria-expanded={showOptions}>
            Run options{runOptionsSummary(options).length ? `: ${runOptionsSummary(options).join(', ')}` : ' (defaults)'} {showOptions ? '▴' : '▾'}
          </button>
          {showOptions && <div className="mt-2"><RunOptionsFields value={options} set={setOptions} project={project} /></div>}
        </>
      )}
      {done ? (
        <p className={cx('mt-2 text-[13px]', /^(Replaced|Not used)/.test(done) ? 'text-faint' : 'text-ok')}>{done}</p>
      ) : proposal.type === 'batch' ? (
        <Button variant="primary" className="w-full mt-3" disabled={start.isPending || (!picked.size && !pickedNew.size)} onClick={() => start.mutate()}>
          Start batch ({picked.size + pickedNew.size})
        </Button>
      ) : (
        <Button variant="primary" className="w-full mt-3" disabled={create.isPending || !pickedNew.size} onClick={() => create.mutate()}>
          Create {pickedNew.size} items
        </Button>
      )}
      <ErrorText error={start.error ?? create.error} />
    </div>
  );
}
