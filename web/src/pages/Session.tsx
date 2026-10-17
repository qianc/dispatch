import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FINAL_STATUSES } from '../../../src/shared/types.ts';
import { api, type SessionDetail } from '../api.ts';
import { withLive } from '../live.ts';
import { ChatInput } from '../components/ChatInput.tsx';
import { Page } from '../components/Layout.tsx';
import { Transcript } from '../components/transcript.tsx';
import { runOptionsSummary } from '../components/batch.tsx';
import { NextSteps } from '../components/nextSteps.tsx';
import { attentionOf } from '../../../src/shared/attention.ts';
import { claudeLabel, useAccounts } from '../accounts.ts';
import { Button, Chip, CloseButton, Empty, ErrorText, SessionStatusChip, Sheet } from '../components/ui.tsx';

export interface ChatMode {
  id: number;
  title: string;
  subtitle: string;
  back?: string;
  onNew: () => void;
  /** in a side panel: a close button instead of back */
  onClose?: () => void;
  /** shown above the conversation (Discuss on a phone: the item itself) */
  intro?: ReactNode;
}

/** A session screen. With `chat` it renders a chat (assistant, discuss) instead of an agent session. */
export function SessionView({ chat }: { chat?: ChatMode } = {}) {
  const params = useParams();
  const id = chat?.id ?? Number(params.id);
  const isAssistant = !!chat;
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [menu, setMenu] = useState(false);
  const { data: accounts } = useAccounts();
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
  const startNow = useMutation({ mutationFn: () => api.post(`/sessions/${id}/start-now`), onSuccess: refresh });
  const syncPrs = useMutation({ mutationFn: () => api.post(`/sessions/${id}/sync-prs`), onSuccess: refresh });
  const createPr = useMutation({ mutationFn: (repo_id: number) => api.post(`/sessions/${id}/prs`, { repo_id }), onSuccess: refresh });

  // keep the view pinned to the bottom while new events arrive, unless the user scrolled up
  const endRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [unseen, setUnseen] = useState(false);
  useEffect(() => {
    const el = endRef.current?.closest('.scroll-area');
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      setAwayFromBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 400);
      if (pinned.current) setUnseen(false);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // keyboard opening/closing resizes the chat area: stay at the newest message if we were there
    const onViewport = () => {
      if (pinned.current) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
    };
    window.addEventListener('dispatch:viewport', onViewport);
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('dispatch:viewport', onViewport);
    };
  }, [data?.session.id]);
  useLayoutEffect(() => {
    // set the chat area's own scrollTop: scrollIntoView() also scrolls the locked page on iOS,
    // which shifts the layout so taps on the tab bar land in the wrong place
    const el = endRef.current?.closest('.scroll-area');
    if (pinned.current && el) el.scrollTop = el.scrollHeight;
    else if (el) setUnseen(true); // something new arrived below while you read further up
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
          {chat?.onClose && <CloseButton onClick={chat.onClose} label="Close chat" />}
          {!isAssistant && <Button small variant="ghost" onClick={() => setMenu(true)} aria-label="Session actions">•••</Button>}
        </>
      }
      footer={
        <ChatInput
          value={text}
          onChange={setText}
          onSubmit={() => send.mutate()}
          canSubmit={canSend && !send.isPending}
          disabled={!canSend}
          placeholder={s.status === 'waiting_input' ? 'Answer the question above first' : final ? 'Message to reopen the session' : 'Message Claude'}
          action={s.status === 'running' && !text ? <Button type="button" onClick={() => interrupt.mutate()} disabled={interrupt.isPending} aria-label="Interrupt">■</Button> : undefined}
        />
      }
    >
      {(s.kind === 'work' || (accounts?.claude.length ?? 0) > 1) && (
        <div className="px-4 pt-3 text-[12px] text-muted flex flex-wrap gap-x-2">
          {(accounts?.claude.length ?? 0) > 1 && <span>Claude: {claudeLabel(accounts, s.claude_account)}</span>}
          {(accounts?.github.length ?? 0) > 1 && project?.github_account && <span>GitHub: {project.github_account}</span>}
          {s.kind === 'work' && runOptionsSummary(s.options).length > 0 && <span>{runOptionsSummary(s.options).join(' · ')}</span>}
        </div>
      )}
      {chat?.intro}
      {!chat?.intro && (data.items.length > 0 || data.source) && (
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
      {s.status === 'queued' && (
        <div className="mx-4 my-2 rounded-xl border border-line bg-panel px-3 py-2.5 text-[14px]">
          <p>{s.waiting_reason ?? 'Waiting for a free worker slot…'}</p>
          {s.waiting_reason && (
            <>
              <p className="text-[12.5px] text-muted mt-0.5">This batch starts from the main branch once the earlier batch is merged, so their changes do not collide.</p>
              <Button small className="mt-2" disabled={startNow.isPending} onClick={() => startNow.mutate()}>Start anyway</Button>
              <ErrorText error={startNow.error} />
            </>
          )}
        </div>
      )}
      {s.status === 'running' && <p className="px-4 text-[13px] text-run animate-pulse">Claude is working…</p>}
      {s.status === 'idle' && s.kind === 'work' && (
        <div className="px-4 pt-2 pb-1">
          <NextSteps sessionId={s.id} attention={attentionOf(s, data.prs)} compact />
        </div>
      )}
      <ErrorText error={send.error} />
      <div ref={endRef} />
      {awayFromBottom && (
        // sticky at the bottom of the chat area: stays in view while you read further up
        <div className="sticky bottom-3 flex justify-end pr-3 pointer-events-none">
          <button
            onClick={() => {
              const el = endRef.current?.closest('.scroll-area');
              el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
              setUnseen(false);
            }}
            className="pointer-events-auto relative size-10 rounded-full bg-raised border border-line shadow-lg flex items-center justify-center text-fg active:bg-line"
            aria-label="Scroll to the newest message"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
            {unseen && <span className="absolute -top-0.5 -right-0.5 size-3 rounded-full bg-accent border-2 border-bg" aria-label="New messages" />}
          </button>
        </div>
      )}

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
