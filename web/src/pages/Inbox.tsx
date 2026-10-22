import { ProjectKey } from '../components/ProjectBadge.tsx';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Inbox as InboxData } from '../api.ts';
import { Page } from '../components/Layout.tsx';
import { NextSteps } from '../components/nextSteps.tsx';
import { Button, Card, Chip, Empty, ErrorText, Section, cx, timeAgo } from '../components/ui.tsx';

type Idle = InboxData['idle'][number];
const ORDER: Record<Idle['attention']['kind'], number> = { merge_blocked: 0, review: 1, turn: 2, merged: 3, checking: 4 };
const LOOK: Record<Idle['attention']['kind'], { tone: 'bad' | 'run' | 'wait' | 'ok'; label: string; icon: string; spin?: boolean }> = {
  merge_blocked: { tone: 'bad', label: 'Merge stopped', icon: 'M12 8v5M12 16.5v.5M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' },
  // in progress, like a running session: Dispatch checks and merges it, nothing to do yet
  checking: { tone: 'run', label: 'Checking', icon: 'M21 12a9 9 0 1 1-6.219-8.56', spin: true },
  review: { tone: 'wait', label: 'Ready to review', icon: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9' },
  turn: { tone: 'wait', label: 'Your reply', icon: 'M4 5h16v11H9l-5 4z' },
  merged: { tone: 'ok', label: 'Done and merged', icon: 'M5 12.5l4.5 4.5L19 7.5' },
};
const TONE_TEXT = { bad: 'text-bad', run: 'text-run', wait: 'text-wait', ok: 'text-ok' };
const TONE_EDGE = { bad: 'border-l-bad', run: 'border-l-run', wait: 'border-l-wait', ok: 'border-l-ok' };

/** An idle session: what it needs from you in plain words, and buttons for the usual next steps. */
function TurnCard({ s }: { s: Idle }) {
  const look = LOOK[s.attention.kind];
  return (
    <div className={cx('mx-3 rounded-xl bg-panel border border-line border-l-[3px] px-3 py-2.5', TONE_EDGE[look.tone])}>
      <Link to={`/s/${s.id}`} className="block">
        <div className="flex items-center gap-2">
          <ProjectKey k={s.project_key} badge />
          <span className="flex-1 min-w-0 truncate font-medium">{s.title}</span>
          <span className="text-faint text-[12px] shrink-0">{timeAgo(s.updated_at)}</span>
        </div>
        <div className={cx('flex items-start gap-1.5 mt-1.5 text-[14px] font-medium', TONE_TEXT[look.tone])}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cx('shrink-0 mt-0.5', look.spin && 'animate-spin')}><path d={look.icon} /></svg>
          <span><span className="sr-only">{look.label}: </span>{s.attention.text}</span>
        </div>
        {s.last_text && <p className="text-[13px] text-muted mt-1 line-clamp-2">{s.last_text}</p>}
      </Link>
      <NextSteps sessionId={s.id} attention={s.attention} />
    </div>
  );
}

export function Inbox() {
  const { data } = useQuery({ queryKey: ['inbox'], queryFn: () => api.get<InboxData>('/inbox') });
  const { data: worker } = useQuery({ queryKey: ['worker'], queryFn: () => api.get<{ connected: boolean }>('/worker'), refetchInterval: 15_000 });
  if (!data) return <Page title="Inbox"><Empty>Loading…</Empty></Page>;
  const sessionById = new Map(data.sessions.map((s) => [s.id, s]));
  const checking = data.idle.filter((s) => s.attention.kind === 'checking');
  const yours = data.idle.filter((s) => s.attention.kind !== 'checking');
  const nothing = !data.inputs.length && !data.idle.length && !data.prs.length && !data.cleanup;
  return (
    <Page title="Inbox" subtitle="Everything waiting on you" wide>
      {worker && !worker.connected && (
        <div className="m-3 rounded-lg border border-bad/30 bg-bad/10 text-bad text-sm px-3 py-2">The worker is not connected. Sessions will start when it is back.</div>
      )}
      {nothing && <Empty>Nothing needs you right now.</Empty>}
      {data.inputs.length > 0 && (
        <Section title="Questions & approvals">
          <Card>
            {data.inputs.map((i) => {
              const s = sessionById.get(i.session_id);
              const text = i.payload.kind === 'plan_approval' ? 'Plan ready for approval' : i.payload.questions.map((q) => q.question).join(' · ');
              return (
                <Link key={i.id} to={`/s/${i.session_id}`} className="block px-3 py-2.5 border-b border-line last:border-b-0 active:bg-raised">
                  <div className="flex items-center gap-2">
                    <ProjectKey k={s?.project_key} badge />
                    <span className="flex-1 min-w-0 truncate font-medium">{s?.title}</span>
                    <Chip tone="wait">{i.payload.kind === 'plan_approval' ? 'Plan' : 'Question'}</Chip>
                  </div>
                  <div className="flex gap-2 text-[13px] text-muted mt-0.5">
                    <span className="flex-1 min-w-0 line-clamp-2">{text}</span>
                    <span className="text-faint text-[12px]">{timeAgo(i.created_at)}</span>
                  </div>
                </Link>
              );
            })}
          </Card>
        </Section>
      )}
      {yours.length > 0 && (
        <Section title="Your turn">
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 lg:gap-x-0 lg:items-start">
            {yours.sort((a, b) => ORDER[a.attention.kind] - ORDER[b.attention.kind]).map((s) => <TurnCard key={s.id} s={s} />)}
          </div>
        </Section>
      )}
      {checking.length > 0 && (
        <Section title="Checking and merging">
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 lg:gap-x-0 lg:items-start">
            {checking.map((s) => <TurnCard key={s.id} s={s} />)}
          </div>
        </Section>
      )}
      <div className="lg:grid lg:grid-cols-2 lg:items-start">
      {data.cleanup && <CleanupCard offer={data.cleanup} />}
      {data.prs.length > 0 && (
        <Section title="To review">
          <Card>
            {data.prs.map((pr) => (
              <Link key={pr.id} to={`/pr/${pr.id}`} className="flex items-center gap-2 px-3 py-2.5 border-b border-line last:border-b-0 active:bg-raised">
                <span className="text-[12px] text-faint shrink-0">{pr.local ? `${pr.repo_full_name.split('/')[1]} branch` : `${pr.repo_full_name.split('/')[1]}#${pr.number}`}</span>
                <span className="flex-1 min-w-0 truncate">{pr.title}</span>
                {pr.mergeable === false && <Chip tone="bad">Conflict</Chip>}
              </Link>
            ))}
          </Card>
        </Section>
      )}
      </div>
    </Page>
  );
}

/** Finished sessions left worktrees or merged branches on disk: offer to remove them. */
function CleanupCard({ offer }: { offer: NonNullable<InboxData['cleanup']> }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const clean = useMutation({
    mutationFn: () => api.post<{ left: InboxData['cleanup'] }>('/cleanup'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inbox'] }),
  });
  const parts = [offer.branches ? `${offer.branches} merged branch${offer.branches === 1 ? '' : 'es'}` : '', offer.worktrees ? `${offer.worktrees} worktree${offer.worktrees === 1 ? '' : 's'}` : ''].filter(Boolean);
  return (
    <Section title="Tidy up">
      <div className="mx-3 rounded-xl bg-panel border border-line px-3 py-2.5">
        <p className="text-[14px]">
          {offer.sessions.length} finished session{offer.sessions.length === 1 ? '' : 's'} left {parts.join(' and ')} on disk.
        </p>
        <p className="text-[12.5px] text-muted mt-0.5">Clean up removes them. Branches that are not merged, and worktrees with uncommitted changes, stay.</p>
        {open && (
          <ul className="mt-2 text-[13px] text-muted space-y-0.5">
            {offer.sessions.map((s) => (
              <li key={s.id} className="truncate">
                <Link to={`/s/${s.id}`} className="text-fg">{s.project_key ? `${s.project_key} ` : ''}#{s.id} {s.title}</Link>
                {' · '}{[s.branches ? `${s.branches} branch${s.branches === 1 ? '' : 'es'}` : '', s.worktrees ? `${s.worktrees} worktree${s.worktrees === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2 mt-2.5">
          <Button small variant="primary" disabled={clean.isPending} onClick={() => clean.mutate()}>{clean.isPending ? 'Cleaning up…' : 'Clean up'}</Button>
          <Button small onClick={() => setOpen(!open)}>{open ? 'Hide list' : 'Show list'}</Button>
        </div>
        <ErrorText error={clean.error} />
      </div>
    </Section>
  );
}
