import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { api, type Session, type SessionFailure } from '../api.ts';
import { Button, ErrorText, cx } from './ui.tsx';

/**
 * A failed session's way forward (DISP-81), in this order: set it aside (Mark as ignored), ask
 * Claude what went wrong (a discussion; the session does not run again), or start it again once
 * the cause is fixed. Ignored: it can be shown in Needs you again. Retried: a link to the retry.
 */
export function FailedActions({ s, failure, compact }: { s: Pick<Session, 'id' | 'closed_reason'>; failure?: Pick<SessionFailure, 'retried_as' | 'discussion'> | null; compact?: boolean }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['inbox'] });
    qc.invalidateQueries({ queryKey: ['sessions'] });
    qc.invalidateQueries({ queryKey: ['session', s.id] });
  };
  const ignore = useMutation({ mutationFn: (ignored: boolean) => api.post<Session>(`/sessions/${s.id}/ignore`, { ignored }), onSuccess: refresh });
  const discuss = useMutation({
    mutationFn: () => api.post<Session>(`/sessions/${s.id}/discuss-failure`, {}),
    onSuccess: (chat) => { refresh(); nav(`/s/${chat.id}`); },
  });
  const retry = useMutation({
    mutationFn: () => api.post<Session>(`/sessions/${s.id}/retry`, {}),
    onSuccess: (next) => { refresh(); nav(`/s/${next.id}`); },
  });
  const busy = ignore.isPending || discuss.isPending || retry.isPending;
  if (s.closed_reason === 'retried') {
    return (
      <p className={cx('text-[13px] text-muted', !compact && 'mt-2.5')}>
        Retried{failure?.retried_as ? <> in <Link className="text-accent" to={`/s/${failure.retried_as}`}>#{failure.retried_as}</Link></> : ''}.
      </p>
    );
  }
  return (
    <div className={cx(!compact && 'mt-2.5')}>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Failed session actions">
        {s.closed_reason === 'ignored'
          ? <Button small disabled={busy} onClick={() => ignore.mutate(false)}>Show in Needs you again</Button>
          : <Button small disabled={busy} onClick={() => ignore.mutate(true)}>Mark as ignored</Button>}
        <Button small disabled={busy} onClick={() => discuss.mutate()}>{failure?.discussion ? 'What would fix the issue? (open chat)' : 'What would fix the issue?'}</Button>
        <Button small variant="primary" disabled={busy} onClick={() => retry.mutate()}>I've fixed it, please retry</Button>
      </div>
      {s.closed_reason === 'ignored' && <p className="text-[12.5px] text-muted mt-1.5">Ignored: it is not in Needs you.</p>}
      <ErrorText error={ignore.error ?? discuss.error ?? retry.error} />
    </div>
  );
}
