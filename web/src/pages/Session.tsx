import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FINAL_STATUSES } from '../../../src/shared/types.ts';
import { api, type SessionDetail } from '../api.ts';
import { withLive } from '../live.ts';
import { Page } from '../components/Layout.tsx';
import { Transcript } from '../components/transcript.tsx';
import { runOptionsSummary } from '../components/batch.tsx';
import { Button, Chip, Empty, ErrorText, SessionStatusChip, Sheet, cx, inputCls } from '../components/ui.tsx';

export interface ChatMode {
  id: number;
  title: string;
  subtitle: string;
  back?: string;
  onNew: () => void;
}

/** A session screen. With `chat` it renders a chat (assistant, discuss) instead of an agent session. */
export function SessionView({ chat }: { chat?: ChatMode } = {}) {
  const params = useParams();
  const id = chat?.id ?? Number(params.id);
  const isAssistant = !!chat;
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [menu, setMenu] = useState(false);
  const { data } = useQuery({
    queryKey: ['session', id],
    queryFn: async () => {
      // after the first load, ask only for new events and keep the ones we have
      const prev = qc.getQueryData<SessionDetail>(['session', id]);
      const after = prev?.events.at(-1)?.seq ?? 0;
      const d = await api.get<SessionDetail>(`/sessions/${id}${after ? `?after=${after}` : ''}`);
      return withLive(prev && after ? { ...d, events: [...prev.events, ...d.events.filter((e) => e.seq > after)] } : d);
    },
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['session', id] });
  const send = useMutation({ mutationFn: () => api.post(`/sessions/${id}/messages`, { text }), onSuccess: () => setText('') });
  const interrupt = useMutation({ mutationFn: () => api.post(`/sessions/${id}/interrupt`) });
  const finish = useMutation({
    mutationFn: (b: { status: 'completed' | 'stopped'; cleanup: boolean }) => api.post(`/sessions/${id}/finish`, b),
    onSuccess: () => { setMenu(false); refresh(); },
  });
  const syncPrs = useMutation({ mutationFn: () => api.post(`/sessions/${id}/sync-prs`), onSuccess: refresh });
  const createPr = useMutation({ mutationFn: (repo_id: number) => api.post(`/sessions/${id}/prs`, { repo_id }), onSuccess: refresh });

  // keep the view pinned to the bottom while new events arrive, unless the user scrolled up
  const endRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = endRef.current?.closest('.scroll-area');
    if (!el) return;
    const onScroll = () => (pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [data?.session.id]);
  useLayoutEffect(() => {
    // set the chat area's own scrollTop: scrollIntoView() also scrolls the locked page on iOS,
    // which shifts the layout so taps on the tab bar land in the wrong place
    const el = endRef.current?.closest('.scroll-area');
    if (pinned.current && el) el.scrollTop = el.scrollHeight;
  }, [data?.events.length, data?.inputs.length]);

  if (!data) return <Page title="Session" back><Empty>Loading…</Empty></Page>;
  const { session: s, project } = data;
  if (isAssistant && !s) return null;
  const final = FINAL_STATUSES.includes(s.status);
  const canSend = s.status !== 'queued' && s.status !== 'waiting_input';

  return (
    <Page
      title={chat ? chat.title : s.title}
      subtitle={chat ? chat.subtitle : <span className="flex items-center gap-1.5"><span>{project?.key} · {s.kind === 'planner' ? 'planning chat' : s.branch}</span></span>}
      back={chat ? chat.back : true}
      keepScroll={false}
      actions={
        <>
          {!isAssistant && <SessionStatusChip status={s.status} />}
          {chat && <Button small variant="ghost" onClick={chat.onNew}>New chat</Button>}
          {!isAssistant && <Button small variant="ghost" onClick={() => setMenu(true)} aria-label="Session actions">•••</Button>}
        </>
      }
      footer={
        <form className="flex items-end gap-2 p-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send.mutate(); }}>
          <textarea
            className={cx(inputCls, 'min-h-10 max-h-40 resize-none py-2')}
            rows={1}
            placeholder={s.status === 'waiting_input' ? 'Answer the question above first' : final ? 'Message to reopen the session' : 'Message Claude'}
            disabled={!canSend}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) send.mutate();
            }}
            aria-label="Message"
          />
          {s.status === 'running' && !text ? (
            <Button type="button" onClick={() => interrupt.mutate()} disabled={interrupt.isPending} aria-label="Interrupt">■</Button>
          ) : (
            <Button variant="primary" disabled={!canSend || !text.trim() || send.isPending} aria-label="Send">↑</Button>
          )}
        </form>
      }
    >
      {s.kind === 'work' && runOptionsSummary(s.options).length > 0 && (
        <div className="px-4 pt-3 text-[12px] text-muted">{runOptionsSummary(s.options).join(' · ')}</div>
      )}
      {(data.items.length > 0 || data.source) && (
        <div className="px-4 pt-3 flex flex-wrap gap-1.5">
          {data.items.map((i) => (
            <Link key={i.id} to={`/items/${i.id}`}><Chip tone="accent">{i.key} {i.title.slice(0, 28)}</Chip></Link>
          ))}
          {data.source && <Link to={`/sources/${data.source.id}`}><Chip>Source: {data.source.title.slice(0, 30)}</Chip></Link>}
        </div>
      )}
      {data.prs.length > 0 && (
        <div className="px-3 pt-3 space-y-2">
          {data.prs.map((pr) => (
            <Link key={pr.id} to={`/pr/${pr.id}`} className="flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2.5 active:bg-raised">
              <Chip tone={pr.state === 'merged' ? 'accent' : pr.state === 'open' ? 'ok' : 'neutral'}>{pr.state}</Chip>
              <span className="text-[13px] text-faint">{pr.local ? `${pr.repo_full_name.split('/')[1]} · local branch` : `${pr.repo_full_name.split('/')[1]}#${pr.number}`}</span>
              <span className="flex-1 truncate text-[14px]">{pr.title}</span>
              <span className="text-muted">›</span>
            </Link>
          ))}
        </div>
      )}
      <Transcript session={s} events={data.events} inputs={data.inputs} project={project} />
      {s.status === 'queued' && <p className="text-center text-sm text-muted">Waiting for a free worker slot…</p>}
      {s.status === 'running' && <p className="px-4 text-[13px] text-run animate-pulse">Claude is working…</p>}
      <ErrorText error={send.error} />
      <div ref={endRef} />

      <Sheet open={menu} onClose={() => setMenu(false)} title="Session">
        <div className="space-y-2">
          {s.kind === 'work' && (
            <>
              <Button className="w-full" disabled={syncPrs.isPending} onClick={() => syncPrs.mutate()}>Check for PRs and branches</Button>
              {data.repos.filter((r) => !data.prs.some((p) => p.repo_id === r.id)).map((r) => (
                <Button key={r.id} className="w-full" disabled={createPr.isPending} onClick={() => createPr.mutate(r.id)}>{r.local_path ? `Push branch for review in ${r.github_name}` : `Push branch & open PR in ${r.github_name}`}</Button>
              ))}
            </>
          )}
          {s.status === 'running' && <Button className="w-full" onClick={() => interrupt.mutate()}>Interrupt Claude</Button>}
          {!final && <Button variant="primary" className="w-full" onClick={() => finish.mutate({ status: 'completed', cleanup: false })}>Mark complete</Button>}
          {!final && <Button variant="danger" className="w-full" onClick={() => confirm('Stop this session? Its items go back to Todo.') && finish.mutate({ status: 'stopped', cleanup: false })}>Stop session</Button>}
          {final && <Button className="w-full" onClick={() => finish.mutate({ status: s.status as 'completed' | 'stopped', cleanup: true })}>Delete worktree from disk</Button>}
          <ErrorText error={finish.error ?? syncPrs.error ?? createPr.error} />
          {s.usage?.cost_usd !== undefined && <p className="text-[12px] text-faint text-center pt-2">Estimated usage ${s.usage.cost_usd.toFixed(2)} · {s.usage.turns ?? 0} model turns</p>}
        </div>
      </Sheet>
    </Page>
  );
}
