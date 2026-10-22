import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import type { Attention, OpenProposal } from '../../../src/shared/types.ts';
import { api, type Project, type Repo } from '../api.ts';
import { useChosenWorker, useRunOptions } from './batch.tsx';
import { useProposalActions } from './proposals.ts';
import { Button, ErrorText, cx } from './ui.tsx';

interface Ask { label: string; text: string }

/** Ready-made replies for what a session needs. They go to Claude as your next message. */
export function asksFor(a: Attention): Ask[] {
  if (a.kind === 'merge_blocked') {
    return [
      { label: 'Explain the merge failure', text: `${a.text}\n\nExplain in plain words what went wrong and what the options are. Do not change anything yet.` },
      { label: 'Try to fix it', text: `${a.text}\n\nFix it: bring the branch up to date with the default branch, resolve any conflicts, run the tests, and push. Then tell me when it is ready to merge.` },
      { label: 'Tell me what to do', text: `${a.text}\n\nWhat do you need from me to get this merged? Give me short, concrete steps.` },
    ];
  }
  if (a.kind === 'merged') {
    return [
      { label: 'Any checks for me?', text: 'Are there any verifications owned by me? List what I should check by hand, with exact steps.' },
      { label: 'Show new output', text: 'Show me examples of the new or updated output from this work (for example screenshots, sample files, or before/after). Link to the files in the repo so I can open them in the app.' },
    ];
  }
  if (a.kind === 'review') {
    return [
      { label: 'Summarise the change', text: 'Summarise what changed in this branch and why, and anything I should look at closely before merging.' },
    ];
  }
  return [];
}

/**
 * A planning chat's open card, as the card in the chat offers it: start the batch or create the
 * items as proposed, or dismiss it. Dismissing the last open card completes the planning chat.
 */
function ProposalActions({ sessionId, projectKey, card, many }: { sessionId: number; projectKey: string; card: OpenProposal; many: boolean }) {
  const { data: project } = useQuery({ queryKey: ['project', projectKey], queryFn: () => api.get<Project & { repos?: Repo[] }>(`/projects/${projectKey}`) });
  const [options] = useRunOptions(projectKey);
  const p = card.proposal;
  const [workerId] = useChosenWorker(project ?? { worker_id: null }, p.type === 'batch' ? p.worker : undefined);
  const { start, create, dismiss, busy, error } = useProposalActions({ sessionId, eventId: card.event_id, project });
  return (
    <>
      {p.type === 'batch' ? (
        <Button small variant="primary" disabled={busy || !project} onClick={() => start.mutate({ title: p.title, item_ids: p.item_ids, new_items: p.new_items, prompt: p.prompt, force_plan: p.force_plan, options: { ...options, worker_id: workerId } })}>
          Start {many ? `"${p.title}"` : 'batch'} ({p.item_ids.length + p.new_items.length})
        </Button>
      ) : (
        <Button small variant="primary" disabled={busy} onClick={() => create.mutate({ items: p.items, source_id: p.source_id })}>
          Create {p.items.length} item{p.items.length === 1 ? '' : 's'}
        </Button>
      )}
      <Button small disabled={busy} onClick={() => dismiss.mutate()} aria-label={many ? `Dismiss ${p.type === 'batch' ? `"${p.title}"` : 'the items'}` : undefined}>Dismiss</Button>
      <ErrorText error={error} />
    </>
  );
}

/**
 * What an idle session needs, with buttons. Ready-made replies are sent and open the session so
 * you see the answer; "Mark as complete" closes it in place.
 */
export function NextSteps({ sessionId, projectKey, attention, compact }: { sessionId: number; projectKey?: string | null; attention: Attention; compact?: boolean }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: (text: string) => api.post(`/sessions/${sessionId}/messages`, { text }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inbox'] });
      nav(`/s/${sessionId}`);
    },
  });
  const complete = useMutation({
    mutationFn: () => api.post(`/sessions/${sessionId}/finish`, { status: 'completed', cleanup: false }), // the janitor removes merged branches and worktrees
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inbox'] });
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  const busy = send.isPending || complete.isPending;
  const asks = asksFor(attention);
  return (
    <div className={cx('flex flex-wrap gap-2', compact ? '' : 'mt-2.5')}>
      {attention.kind === 'merged' && (
        <Button small variant="primary" disabled={busy} onClick={() => complete.mutate()}>✓ Mark as complete</Button>
      )}
      {(attention.kind === 'review' || attention.kind === 'merge_blocked' || attention.kind === 'checking' || attention.kind === 'merging') && (
        <Link to={`/pr/${attention.pr_id}`} className="inline-flex items-center h-8 px-2.5 rounded-lg text-[13px] font-medium bg-raised border border-line active:bg-line">
          {attention.kind === 'review' ? 'Review & merge' : 'See the change'}
        </Link>
      )}
      {attention.kind === 'proposal' && projectKey && attention.proposals.map((c) => (
        <ProposalActions key={c.event_id} sessionId={sessionId} projectKey={projectKey} card={c} many={attention.proposals.length > 1} />
      ))}
      {attention.kind === 'proposal' && (
        <Link to={`/s/${sessionId}`} className="inline-flex items-center h-8 px-2.5 rounded-lg text-[13px] font-medium bg-raised border border-line active:bg-line">Open to edit</Link>
      )}
      {asks.map((a) => (
        <Button key={a.label} small disabled={busy} onClick={() => send.mutate(a.text)}>{a.label}</Button>
      ))}
      {attention.kind === 'turn' && (
        <Button small disabled={busy} onClick={() => complete.mutate()}>Mark as complete</Button>
      )}
      <ErrorText error={send.error ?? complete.error} />
    </div>
  );
}
