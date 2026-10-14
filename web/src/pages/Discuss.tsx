import { useState } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ItemDetail } from '../api.ts';
import { Page } from '../components/Layout.tsx';
import { Button, ErrorText, cx, inputCls } from '../components/ui.tsx';
import { SessionView } from './Session.tsx';

const STARTERS = ['Explain this item in plain words', 'Which files and parts of the code are involved?', 'How big is this, and what is the risk?', 'What would a good first step be?'];

/** "Discuss this": a read-only chat about one item. Doing the work stays on the item page. */
export function Discuss() {
  const id = Number(useParams().id);
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
        chat={{ id: data.session_id, title, subtitle: item?.title ?? '', back: `/items/${id}`, onNew: () => newChat.mutate() }}
      />
    );
  }
  return <EmptyDiscuss id={id} title={title} subtitle={item?.title ?? ''} />;
}

function EmptyDiscuss({ id, title, subtitle }: { id: number; title: string; subtitle: string }) {
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
      back={`/items/${id}`}
      footer={
        <form className="flex items-end gap-2 p-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send.mutate(text); }}>
          <textarea className={cx(inputCls, 'min-h-10 max-h-40 resize-none py-2')} rows={1} placeholder="Ask about this item" value={text} onChange={(e) => setText(e.target.value)} aria-label="Message" />
          <Button variant="primary" disabled={!text.trim() || send.isPending} aria-label="Send">↑</Button>
        </form>
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
