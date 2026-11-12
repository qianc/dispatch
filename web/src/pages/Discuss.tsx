import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ItemDetail, type Session } from '../api.ts';
import { ChatInput } from '../components/ChatInput.tsx';
import { PendingMessages } from '../components/PendingMessages.tsx';
import { sendPending, usePending, type Pending } from '../pendingSends.ts';
import { useChatImages } from '../components/chatImages.tsx';
import { Page } from '../components/Layout.tsx';
import { CloseButton, ErrorText, ITEM_STATUS_LABEL, ItemStatusIcon, cx } from '../components/ui.tsx';
import { RichMd } from '../components/RichMd.tsx';
import { SessionView } from './Session.tsx';

/** Phone: the item itself above the chat, so you can read what you are asking about. */
function ItemIntro({ item }: { item: ItemDetail }) {
  const [all, setAll] = useState(false);
  const long = item.body_md.length > 400;
  return (
    <div className="mx-3 mt-3 rounded-xl border border-line bg-panel p-3" aria-label="The item">
      <Link to={`/items/${item.id}`} className="flex items-center gap-2 text-[12px] text-muted">
        <ItemStatusIcon status={item.status} />
        <span className="font-semibold">{item.key}</span>
        <span>{ITEM_STATUS_LABEL[item.status]}</span>
        <span className="ml-auto text-accent">Open ›</span>
      </Link>
      <h2 className="font-semibold leading-snug mt-1.5 [overflow-wrap:anywhere]">{item.title}</h2>
      {item.body_md ? (
        <div className={cx('relative mt-1.5', !all && long && 'max-h-40 overflow-hidden')}>
          <RichMd className="text-[14px]" ctx={{ project: item.project, sourceId: item.source_id }}>{item.body_md}</RichMd>
          {!all && long && <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-panel to-transparent" />}
        </div>
      ) : <p className="text-[13px] text-muted mt-1">No description.</p>}
      {long && <button className="mt-1.5 text-[13px] text-accent" onClick={() => setAll(!all)}>{all ? 'Show less' : 'Show all'}</button>}
    </div>
  );
}

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
        chat={{ id: data.session_id, title, subtitle: item?.title ?? '', back: onClose ? undefined : `/items/${id}`, onNew: () => newChat.mutate(), onClose, intro: !onClose && item ? <ItemIntro item={item} /> : undefined }}
      />
    );
  }
  return <EmptyDiscuss id={id} title={title} subtitle={item?.title ?? ''} onClose={onClose} intro={!onClose && item ? <ItemIntro item={item} /> : undefined} />;
}

function EmptyDiscuss({ id, title, subtitle, onClose, intro }: { id: number; title: string; subtitle: string; onClose?: () => void; intro?: ReactNode }) {
  const qc = useQueryClient();
  const images = useChatImages();
  const [text, setText] = useState('');
  const pendingKey = `discuss:new:${id}`;
  const pending = usePending(pendingKey);
  // the first message shows at once; the chat opens when the server has it (DISP-83)
  const send = (t: string) => {
    sendPending(pendingKey, { text: t, images: images.take() }, async (b) => {
      const s = await api.post<Session>(`/items/${id}/discuss`, b);
      void qc.invalidateQueries({ queryKey: ['discuss', id] });
      return { chat: `session:${s.id}` };
    });
    setText('');
  };
  const editAgain = (p: Pending) => {
    setText((v) => (v ? `${v}\n${p.text}` : p.text));
    images.restore(p.images);
  };
  return (
    <Page
      title={title}
      subtitle={subtitle}
      back={onClose ? undefined : `/items/${id}`}
      keepScroll={!onClose}
      actions={onClose && <CloseButton onClick={onClose} label="Close chat" />}
      footer={
        <ChatInput value={text} onChange={setText} onSubmit={() => send(text)} canSubmit={!images.uploading} placeholder="Ask about this item" {...images.input} />
      }
    >
      {intro}
      <div className="px-4 pt-5 space-y-2">
        <p className="text-sm text-muted mb-3">A quick, read-only chat about this item. It knows the item and the repo's CLAUDE.md and can look at the code, but it never changes anything.</p>
        {pending.length ? <PendingMessages pending={pending} onEdit={editAgain} /> : STARTERS.map((s) => (
          <button key={s} onClick={() => send(s)} className="block w-full text-left rounded-lg border border-line bg-panel px-3 py-2 text-[14px] active:bg-raised">
            {s}
          </button>
        ))}
        <ErrorText error={(images.error ? new Error(`An image could not be added: ${images.error}`) : null)} />
      </div>
    </Page>
  );
}
