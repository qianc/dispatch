import { editPending, retryPending, type Pending } from '../pendingSends.ts';
import { Thumbs } from './transcript.tsx';
import { Button } from './ui.tsx';

const STATUS: Record<Pending['state'], string | null> = { sending: 'Sending…', slow: 'Still sending', sent: null, failed: 'Not sent' };

/**
 * The owner's messages that the server has not shown yet (DISP-83), after the conversation, as the
 * owner's bubbles with a small status. A message that was not sent keeps its text and images, with
 * Retry and Edit (its text and images back in the input).
 */
export function PendingMessages({ pending, onEdit }: { pending: Pending[]; onEdit?: (p: Pending) => void }) {
  if (!pending.length) return null;
  return (
    <div className="px-4 pb-3 space-y-2" aria-label="Messages being sent">
      {pending.map((p) => (
        <div key={p.client_id} className="flex flex-col items-end" data-state={p.state}>
          {p.images.length ? <Thumbs images={p.images.map((i) => ({ url: i.preview }))} className="justify-end mb-1 max-w-[85%]" /> : null}
          {p.text && <div className={`max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft border px-3 py-2 whitespace-pre-wrap ${p.state === 'failed' ? 'border-bad/50' : 'border-accent/25'}`}>{p.text}</div>}
          {STATUS[p.state] && (
            <span role="status" className={`mt-0.5 text-[11px] leading-4 ${p.state === 'failed' ? 'text-bad' : 'text-faint'}`} title={p.error}>
              {STATUS[p.state]}{p.state === 'failed' && p.error ? `: ${p.error}` : ''}
            </span>
          )}
          {p.state === 'failed' && (
            <div className="flex gap-1.5 mt-1">
              <Button small onClick={() => retryPending(p.client_id)}>Retry</Button>
              {onEdit && <Button small variant="ghost" onClick={() => { const back = editPending(p.client_id); if (back) onEdit(back); }}>Edit</Button>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
