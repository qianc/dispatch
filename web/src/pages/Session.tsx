import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useNavigationType, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CHAT_KINDS, FINAL_STATUSES } from '../../../src/shared/types.ts';
import { api, type PartOf, type SessionDetail } from '../api.ts';
import { withLive } from '../live.ts';
import { ChatInput } from '../components/ChatInput.tsx';
import { PendingMessages } from '../components/PendingMessages.tsx';
import { reconcile, sendPending, usePending, type Pending } from '../pendingSends.ts';
import { taggedKeys, type MentionProject } from '../mentions.ts';
import { useChatImages } from '../components/chatImages.tsx';
import { Page } from '../components/Layout.tsx';
import { Transcript } from '../components/transcript.tsx';
import { useItemPeek } from '../components/itemPeek.tsx';
import { ItemDetail } from './ItemDetail.tsx';
import { runOptionsSummary } from '../components/batch.tsx';
import { NextSteps } from '../components/nextSteps.tsx';
import { FailedActions } from '../components/failedActions.tsx';
import { CheckProgressCard } from '../components/checkProgress.tsx';
import { SessionPrompt } from '../components/sessionPrompt.tsx';
import { OrchestrationPanel } from '../components/orchestration.tsx';
import { orchBusyLabel } from '../orchestration.ts';
import { attentionOf } from '../../../src/shared/attention.ts';
import { PrStateChip } from '../components/PrState.tsx';
import { claudeLabel, useAccounts } from '../accounts.ts';
import { useWorkers, workerName } from '../workers.ts';
import { useVeryWide } from '../wide.ts';
import { canAct, readOnlyText, startedBy } from '../access.ts';
import { Button, Chip, CloseButton, Empty, ErrorText, SessionStatusChip, Sheet, cx, inputCls } from '../components/ui.tsx';

/** "Part of Auth rework (step 2 of 6)": the orchestration a step's batch belongs to. */
export const partOfText = (p: PartOf) => `Part of ${p.title}${p.step_position ? ` (step ${p.step_position} of ${p.step_count})` : ''}`;

/** Where each chat was scrolled to (null: at the newest message), for coming back to it. This app run only. */
const chatScroll = new Map<number, number | null>();

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
  /** @ tags these projects in a message (the Assistant, DISP-82) */
  projects?: MentionProject[];
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
  const images = useChatImages();
  // the message shows at once and the box is free again; the server's copy replaces it (DISP-83)
  const pendingKey = `session:${id}`;
  const pending = usePending(pendingKey);
  const send = () => {
    const project_keys = chat?.projects ? taggedKeys(text, new Set(chat.projects.map((p) => p.key))) : [];
    sendPending(pendingKey, { text, images: images.take(), project_keys }, (b) => api.post(`/sessions/${id}/messages`, b));
    setText('');
  };
  const editAgain = (p: Pending) => {
    setText((t) => (t ? `${t}\n${p.text}` : p.text));
    images.restore(p.images);
  };
  useEffect(() => { if (data) reconcile(pendingKey, data.events); }, [data?.events, pendingKey]);
  const interrupt = useMutation({ mutationFn: () => api.post(`/sessions/${id}/interrupt`) });
  const finish = useMutation({
    mutationFn: (b: { status: 'completed' | 'stopped'; cleanup: boolean }) => api.post(`/sessions/${id}/finish`, b),
    onSuccess: () => { setMenu(false); refresh(); },
  });
  const startNow = useMutation({ mutationFn: () => api.post(`/sessions/${id}/start-now`), onSuccess: refresh });
  const nav = useNavigate();
  const sidePanel = useVeryWide();
  const { data: workerList } = useWorkers();
  const workers = workerList?.workers ?? [];
  const pause = useMutation({ mutationFn: (on: boolean) => api.post(`/sessions/${id}/${on ? 'pause' : 'resume'}`), onSuccess: refresh });
  const move = useMutation({
    mutationFn: (worker_id: number) => api.post<{ id: number }>(`/sessions/${id}/move`, { worker_id }),
    onSuccess: (r) => { setMenu(false); if (r.id !== Number(id)) nav(`/s/${r.id}`); else refresh(); },
  });
  const syncPrs = useMutation({ mutationFn: () => api.post(`/sessions/${id}/sync-prs`), onSuccess: refresh });
  const createPr = useMutation({ mutationFn: (repo_id: number) => api.post(`/sessions/${id}/prs`, { repo_id }), onSuccess: refresh });

  // keep the view pinned to the bottom while new events arrive, unless the user scrolled up
  const endRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [unseen, setUnseen] = useState(false);
  // Back from an item opened in a card (phone): the chat is where you left it, not at the newest message
  const navType = useNavigationType();
  const placed = useRef(false);
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
    // (asked again in the frame: you may have scrolled up since)
    const onViewport = () => {
      if (pinned.current) requestAnimationFrame(() => { if (pinned.current) el.scrollTop = el.scrollHeight; });
    };
    window.addEventListener('dispatch:viewport', onViewport);
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('dispatch:viewport', onViewport);
    };
  }, [data?.session.id]);
  useLayoutEffect(() => {
    const el = endRef.current?.closest('.scroll-area');
    if (!el) return;
    // a layout effect: its cleanup runs while the chat is still on the page and can be measured.
    // The exact place unless right at the bottom (near it counts as pinned, but Back should not move the card).
    return () => void chatScroll.set(id, el.scrollHeight - el.scrollTop - el.clientHeight < 2 ? null : el.scrollTop);
  }, [data?.session.id]);
  useLayoutEffect(() => {
    // set the chat area's own scrollTop: scrollIntoView() also scrolls the locked page on iOS,
    // which shifts the layout so taps on the tab bar land in the wrong place
    const el = endRef.current?.closest('.scroll-area');
    if (!el) return;
    if (!placed.current) {
      placed.current = true;
      const top = navType === 'POP' ? chatScroll.get(id) : undefined;
      if (typeof top === 'number') {
        let tries = 0;
        let frame = 0;
        const restore = () => {
          el.scrollTop = top;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          if (Math.abs(el.scrollTop - top) > 2 && tries++ < 60) frame = requestAnimationFrame(restore); // content still loading
        };
        restore();
        return () => cancelAnimationFrame(frame);
      }
    }
    if (pinned.current) el.scrollTop = el.scrollHeight;
    else setUnseen(true); // something new arrived below while you read further up
  }, [data?.events.length, data?.inputs.length, pending.length]);
  // desktop: an item opened from a card shows beside the chat; in a narrow side panel, over it
  const { peek, close: closePeek } = useItemPeek();

  if (!data) return <Page title="Session" back><Empty>Loading…</Empty></Page>;
  const { session: s, project } = data;
  const attention = attentionOf(s, data.prs, data.events);
  if (isAssistant && !s) return null;
  const final = FINAL_STATUSES.includes(s.status);
  // a chat that has not started yet takes more messages: they go with its first turn (DISP-83)
  const canSend = s.status !== 'waiting_input' && (s.status !== 'queued' || CHAT_KINDS.includes(s.kind));
  // someone else's session: read it, but no replies, answers or proposals (DISP-63)
  const drive = canAct(data.access, 'drive');
  const stop = canAct(data.access, 'stop');
  const starter = startedBy(s);
  // a failed agent session: why, and Mark as ignored / What would fix the issue? / Retry (DISP-81).
  // From xl they sit in the side panel; a login problem keeps them next to the sign-in steps.
  const failed = s.status === 'failed' && !CHAT_KINDS.includes(s.kind) && !!data.failure;
  const failedInChat = failed && (!sidePanel || !!chat || attention.kind === 'login');

  // an orchestrator that only waits for its steps is at work, not "your turn"
  const orchBusy = data.orchestration ? orchBusyLabel(data.orchestration, s.status) : undefined;

  const peekPanel = peek && <ItemDetail key={peek} itemId={peek} onClose={closePeek} />;
  // one tree whether or not the item shows, so opening it does not rebuild the chat and lose its place
  return (
    <div className="relative flex-1 min-h-0 flex">
    <div className="flex-1 min-w-0 flex flex-col">
    <Page
      aside={chat || peek ? undefined : (
        <div className="px-4 pt-4 space-y-5 text-[13px]">
          {failed && !failedInChat && (
            <div role="status" aria-label="Session failed">
              <h2 className="text-[12px] font-semibold uppercase tracking-wide text-bad mb-1.5">Failed</h2>
              <p className="text-bad">{data.failure!.reason}</p>
              {drive && <div className="mt-2"><FailedActions s={s} failure={data.failure} compact /></div>}
            </div>
          )}
          {data.orchestration && <OrchestrationPanel o={data.orchestration} mine={drive} />}
          {s.initial_prompt && <SessionPrompt key={s.id} sessionId={s.id} text={s.initial_prompt} />}
          <div>
            <h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted mb-1.5">Details</h2>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <dt className="text-muted">Status</dt><dd><SessionStatusChip status={s.status} busy={orchBusy} /></dd>
              {s.started_by && <><dt className="text-muted">Started by</dt><dd className="truncate">{s.started_by}{s.github_login && <span className="text-muted"> as @{s.github_login}</span>}</dd></>}
              {workers.length > 0 && <><dt className="text-muted">Worker</dt><dd className="truncate">{workerName(workers, s.worker_id)}</dd></>}
              {(accounts?.claude.length ?? 0) > 0 && <><dt className="text-muted">Claude</dt><dd className="truncate">{claudeLabel(accounts, s.claude_account)}</dd></>}
              {project?.github_account && <><dt className="text-muted">GitHub</dt><dd className="truncate">{project.github_account}</dd></>}
              {s.branch && <><dt className="text-muted">Branch</dt><dd className="font-mono text-[12px] break-all">{s.branch}</dd></>}
              {s.kind === 'work' && runOptionsSummary(s.options).length > 0 && <><dt className="text-muted">Options</dt><dd>{runOptionsSummary(s.options).join(' · ')}</dd></>}
              {data.part_of && <><dt className="text-muted">Orchestration</dt><dd><Link className="text-accent" to={`/s/${data.part_of.orchestrator_id}`}>{partOfText(data.part_of)}</Link></dd></>}
              {s.moved_from && <><dt className="text-muted">Moved from</dt><dd><Link className="text-accent" to={`/s/${s.moved_from}`}>#{s.moved_from}</Link></dd></>}
              {s.retry_of && <><dt className="text-muted">Retry of</dt><dd><Link className="text-accent" to={`/s/${s.retry_of}`}>#{s.retry_of}</Link></dd></>}
              {s.about_session && <><dt className="text-muted">About</dt><dd><Link className="text-accent" to={`/s/${s.about_session}`}>#{s.about_session}</Link> (failed)</dd></>}
              {s.usage?.cost_usd !== undefined && <><dt className="text-muted">Usage</dt><dd>${s.usage.cost_usd.toFixed(2)} · {s.usage.turns ?? 0} turns</dd></>}
            </dl>
          </div>
          {(data.items.length > 0 || data.source) && (
            <div>
              <h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted mb-1.5">Items</h2>
              <ul className="space-y-1">
                {data.items.map((i) => (
                  <li key={i.id}><Link to={`/items/${i.id}`} className="flex gap-2 rounded-md px-1.5 py-1 -mx-1.5 hover:bg-raised"><span className="text-faint shrink-0">{i.key}</span><span className="min-w-0">{i.title}</span></Link></li>
                ))}
                {data.source && <li><Link to={`/sources/${data.source.id}`} className="block rounded-md px-1.5 py-1 -mx-1.5 hover:bg-raised text-muted">Source: {data.source.title}</Link></li>}
              </ul>
            </div>
          )}
          {data.prs.length > 0 && (
            <div>
              <h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted mb-1.5">Pull requests</h2>
              <ul className="space-y-1.5">
                {data.prs.map((pr) => (
                  <li key={pr.id}><Link to={`/pr/${pr.id}`} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2 hover:border-faint">
                    <PrStateChip pr={pr} autoMerge={s.options.auto_merge} />
                    <span className="flex-1 min-w-0 truncate">{pr.title}</span>
                  </Link></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      title={chat ? chat.title : s.title}
      subtitle={chat ? chat.subtitle : <span className="flex items-center gap-1.5"><span className="truncate">{data.orchestration ? `${data.orchestration.project_keys.join(' · ')} · orchestration` : <>{project?.key} · {s.kind === 'planner' ? 'planning chat' : s.release ? `release ${s.release.version}` : s.branch}</>}{starter && ` · ${starter}`}</span></span>}
      back={chat ? chat.back : true}
      keepScroll={false}
      actions={
        <>
          {!isAssistant && <SessionStatusChip status={s.status} busy={orchBusy} />}
          {chat && <Button small variant="ghost" onClick={chat.onNew}>New chat</Button>}
          {chat?.onClose && <CloseButton onClick={chat.onClose} label="Close chat" />}
          {!isAssistant && <Button small variant="ghost" onClick={() => setMenu(true)} aria-label="Session actions">•••</Button>}
        </>
      }
      footer={drive && (
        <ChatInput
          value={text}
          onChange={setText}
          onSubmit={send}
          canSubmit={canSend && !images.uploading}
          projects={chat?.projects}
          disabled={!canSend}
          placeholder={s.status === 'waiting_input' ? 'Answer the question above first' : final ? 'Message to reopen the session' : 'Message Claude'}
          {...images.input}
          action={s.status === 'running' && !text && !images.files.length ? <Button type="button" onClick={() => interrupt.mutate()} disabled={interrupt.isPending} aria-label="Interrupt">■</Button> : undefined}
        />
      )}
    >
      {/* below xl these sit above the conversation; from xl they are in the side panel */}
      {(chat || !sidePanel) && (<div>
      {(s.kind === 'work' || (accounts?.claude.length ?? 0) > 1 || workers.length > 1) && (
        <div className="px-4 pt-3 text-[12px] text-muted flex flex-wrap gap-x-2">
          {workers.length > 1 && <span>Worker: {workerName(workers, s.worker_id)}</span>}
          {s.moved_from && <Link className="text-accent" to={`/s/${s.moved_from}`}>moved from #{s.moved_from}</Link>}
          {s.retry_of && <Link className="text-accent" to={`/s/${s.retry_of}`}>retry of #{s.retry_of}</Link>}
          {(accounts?.claude.length ?? 0) > 1 && <span>Claude: {claudeLabel(accounts, s.claude_account)}</span>}
          {(accounts?.github.length ?? 0) > 1 && project?.github_account && <span>GitHub: {project.github_account}</span>}
          {s.kind === 'work' && runOptionsSummary(s.options).length > 0 && <span>{runOptionsSummary(s.options).join(' · ')}</span>}
        </div>
      )}
      </div>)}
      {chat?.intro}
      {(chat || !sidePanel) && (<div>
      {data.orchestration && <div className="px-3 pt-3"><OrchestrationPanel o={data.orchestration} mine={drive} /></div>}
      {data.part_of && <Link to={`/s/${data.part_of.orchestrator_id}`} className="block px-4 pt-3 text-[13px] text-accent">{partOfText(data.part_of)}</Link>}
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
              <PrStateChip pr={pr} autoMerge={s.options.auto_merge} />
              <span className="text-[13px] text-faint">{pr.local ? `${pr.repo_full_name.split('/')[1]} · local branch` : `${pr.repo_full_name.split('/')[1]}#${pr.number}`}</span>
              <span className="flex-1 truncate text-[14px]">{pr.title}</span>
              <span className="text-muted">›</span>
            </Link>
          ))}
        </div>
      )}
      </div>)}
      {!drive && (
        <div role="status" className="mx-4 mt-3 rounded-xl border border-wait/40 bg-wait/5 px-3 py-2.5 text-[14px]">{readOnlyText(s)}</div>
      )}
      <Transcript session={s} events={data.events} inputs={data.inputs} project={project} readOnly={!drive} />
      <PendingMessages pending={pending} onEdit={editAgain} />
      {s.status === 'queued' && (
        <div className="mx-4 my-2 rounded-xl border border-line bg-panel px-3 py-2.5 text-[14px]">
          <p>{s.waiting_reason ?? 'Waiting for a free worker slot…'}</p>
          {s.pending_prompt && <p className="text-[12.5px] text-muted mt-0.5">Your reply is delivered when the session starts.</p>}
          {drive && <div className="flex flex-wrap gap-2 mt-2">
            <Button small disabled={pause.isPending} onClick={() => pause.mutate(!s.paused)}>{s.paused ? 'Resume' : 'Pause'}</Button>
            {workers.length > 1 && (
              <select className="h-8 rounded-lg border border-line-strong bg-panel pl-2.5 text-[13px] text-fg" aria-label="Move to worker" value="" onChange={(e) => e.target.value && move.mutate(Number(e.target.value))}>
                <option value="">Move to…</option>
                {workers.filter((w) => w.id !== s.worker_id).map((w) => <option key={w.id} value={w.id}>{w.name}{w.connected ? '' : ' (offline)'}</option>)}
              </select>
            )}
          </div>}
          <ErrorText error={pause.error ?? move.error} />
          {drive && s.waiting_reason && s.waiting_reason.startsWith('Waiting for #') && (
            <>
              <p className="text-[12.5px] text-muted mt-0.5">This batch starts from the main branch once the earlier batch is merged, so their changes do not collide.</p>
              <Button small className="mt-2" disabled={startNow.isPending} onClick={() => startNow.mutate()}>Start anyway</Button>
              <ErrorText error={startNow.error} />
            </>
          )}
        </div>
      )}
      {s.status === 'running' && <p className="px-4 text-[13px] text-run animate-pulse">Claude is working…</p>}
      {data.checks?.map((c) => <CheckProgressCard key={`${c.pr_id ?? 'turn'}-${c.repo}`} run={c} />)}
      {drive && ((s.status === 'idle' && s.kind === 'work') || (attention.kind === 'login' && (s.status === 'idle' || s.status === 'failed'))) && (
        <div className="px-4 pt-2 pb-1">
          {attention.kind === 'checking' && !data.checks?.length && <p className="text-[13px] text-run animate-pulse mb-2">{attention.text}</p>}
          <NextSteps sessionId={s.id} attention={attention} compact />
        </div>
      )}
      {failedInChat && (
        <div role="status" aria-label="Session failed" className="mx-4 my-2 rounded-xl border border-bad/40 bg-bad/5 px-3 py-2.5 text-[14px]">
          <p className="font-medium text-bad">Failed: {data.failure!.reason}</p>
          {drive && <FailedActions s={s} failure={data.failure} />}
        </div>
      )}
      <ErrorText error={images.error ? new Error(`An image could not be added: ${images.error}`) : null} />
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
          {!drive && <p className="text-[13px] text-muted">{readOnlyText(s)}</p>}
          {s.kind === 'work' && (
            <>
              {drive && <Button className="w-full" disabled={syncPrs.isPending} onClick={() => syncPrs.mutate()}>Check for PRs and branches</Button>}
              {drive && data.repos.filter((r) => !data.prs.some((p) => p.repo_id === r.id)).map((r) => (
                <Button key={r.id} className="w-full" disabled={createPr.isPending} onClick={() => createPr.mutate(r.id)}>{r.local_path ? `Push branch for review in ${r.github_name}` : `Push branch & open PR in ${r.github_name}`}</Button>
              ))}
            </>
          )}
          {stop && s.status === 'running' && <Button className="w-full" onClick={() => interrupt.mutate()}>Interrupt Claude</Button>}
          {drive && !final && s.status !== 'queued' && s.kind === 'work' && workers.length > 1 && (
            <select className={cx(inputCls)} aria-label="Move to another worker" value="" onChange={(e) => {
              const to = workers.find((w) => w.id === Number(e.target.value));
              if (to && confirm(`This stops the session and starts a new one on ${to.name} from the pushed branch.`)) move.mutate(to.id);
            }}>
              <option value="">Move to another worker…</option>
              {workers.filter((w) => w.id !== s.worker_id).map((w) => <option key={w.id} value={w.id}>{w.name}{w.connected ? '' : ' (offline)'}</option>)}
            </select>
          )}
          {/* an orchestrator is paused and stopped from its plan, which also asks about its running sessions */}
          {data.orchestration && !final && <p className="text-[13px] text-muted">Pause or stop it from the plan on its page.</p>}
          {stop && !final && !data.orchestration && <Button variant="primary" className="w-full" onClick={() => finish.mutate({ status: 'completed', cleanup: false })}>Mark complete</Button>}
          {stop && !final && !data.orchestration && <Button variant="danger" className="w-full" onClick={() => confirm('Stop this session? Its items go back to Todo.') && finish.mutate({ status: 'stopped', cleanup: false })}>Stop session</Button>}
          {stop && final && <Button className="w-full" onClick={() => finish.mutate({ status: s.status as 'completed' | 'stopped', cleanup: true })}>Delete worktree from disk</Button>}
          <ErrorText error={finish.error ?? syncPrs.error ?? createPr.error ?? move.error ?? interrupt.error} />
          {s.usage?.cost_usd !== undefined && <p className="text-[12px] text-faint text-center pt-2">Estimated usage ${s.usage.cost_usd.toFixed(2)} · {s.usage.turns ?? 0} model turns</p>}
        </div>
      </Sheet>
    </Page>
    </div>
    {peekPanel && (chat?.onClose
      ? <div className="absolute inset-0 z-10 flex flex-col bg-bg" role="region" aria-label="Item">{peekPanel}</div>
      : <aside className="w-[min(560px,46%)] shrink-0 min-h-0 flex flex-col border-l border-line bg-bg" aria-label="Item">{peekPanel}</aside>)}
    </div>
  );
}
