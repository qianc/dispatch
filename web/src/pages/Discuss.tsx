import { useState } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ItemDetail } from '../api.ts';
import { ChatInput } from '../components/ChatInput.tsx';
import { Page } from '../components/Layout.tsx';
import { CloseButton, ErrorText } from '../components/ui.tsx';
import { SessionView } from './Session.tsx';

const STARTERS = ['Explain this item in plain words', 'Which files and parts of the code are involved?', 'How big is this, and what is the risk?', 'What would a good first step be?'];

/**
 * "Discuss this": a read-only chat about one item. Doing the work stays on the item page.
 * Its own screen on phones; on desktop a panel beside the item (`itemId` + `onClose`).
 */
export function Discuss({ itemId, onClose }: { itemId?: number; onClose?: () => void } = {}) {
  const params = useParams();
  const id = itemId ?? Number(params.id);
  const qc = useQueryClient();
  const { data: item } = useQuery({ queryKey: ['item', id], queryFn: () => api.get<ItemDetail>(`/items/${id}`) });
  const { data } = useQuery({ queryKey: ['discuss', id], queryFn: () => api.get<{ session_id: number | null }>(`/items/${id}/discuss`) });
  const newChat = useMutation({
    mutationFn: () => api.post(`/items/${id}/discuss/new`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['discuss', id] }),
  });
  const title = item ? `Discuss ${item.key}` : 'Discuss';
  if (data?.session_id) {
    return (
      <SessionView
        key={data.session_id}
        chat={{ id: data.session_id, title, subtitle: item?.title ?? '', back: onClose ? undefined : `/items/${id}`, onNew: () => newChat.mutate(), onClose }}
      />
    );
  }
  return <EmptyDiscuss id={id} title={title} subtitle={item?.title ?? ''} onClose={onClose} />;
}

function EmptyDiscuss({ id, title, subtitle, onClose }: { id: number; title: string; subtitle: string; onClose?: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: (t: string) => api.post(`/items/${id}/discuss`, { text: t }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['discuss', id] }),
  });
  return (
    <Page
      title={title}
      subtitle={subtitle}
      back={onClose ? undefined : `/items/${id}`}
      keepScroll={!onClose}
      actions={onClose && <CloseButton onClick={onClose} label="Close chat" />}
      footer={
        <ChatInput value={text} onChange={setText} onSubmit={() => send.mutate(text)} canSubmit={!send.isPending} placeholder="Ask about this item" />
      }
    >
      <div className="px-4 pt-5 space-y-2">
        <p className="text-sm text-muted mb-3">A quick, read-only chat about this item. It knows the item and the repo's CLAUDE.md and can look at the code, but it never changes anything.</p>
        {STARTERS.map((s) => (
          <button key={s} onClick={() => send.mutate(s)} disabled={send.isPending} className="block w-full text-left rounded-lg border border-line bg-panel px-3 py-2 text-[14px] active:bg-raised">
            {s}
          </button>
        ))}
        <ErrorText error={send.error} />
      </div>
    </Page>
  );
}
