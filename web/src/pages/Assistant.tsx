import { useEffect, useState, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AssistantChat, type Session } from '../api.ts';
import { ChatInput } from '../components/ChatInput.tsx';
import { useChatImages } from '../components/chatImages.tsx';
import { PendingMessages } from '../components/PendingMessages.tsx';
import { sendPending, usePending, type Pending } from '../pendingSends.ts';
import { Page } from '../components/Layout.tsx';
import { ErrorText } from '../components/ui.tsx';
import { SessionView } from './Session.tsx';

const EXAMPLES = [
  'New project Decks for github.com/me/decks',
  'Add a bug to HC: login drops after 10 min, high importance, effort S',
  'Read ~/projects/notes/retro.md and file the issues under Decks',
  "What's running right now?",
];

/** The app is on screen (not in the background, not a hidden browser tab). */
function useVisible() {
  return useSyncExternalStore(
    (cb) => {
      document.addEventListener('visibilitychange', cb);
      return () => document.removeEventListener('visibilitychange', cb);
    },
    () => document.visibilityState === 'visible',
  );
}

export function Assistant() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['assistant'], queryFn: () => api.get<AssistantChat>('/assistant') });
  const newChat = useMutation({
    mutationFn: () => api.post('/assistant/new'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assistant'] }),
  });
  // open and on screen: the replies are read (clears the badge on the Assistant menu)
  const visible = useVisible();
  const unreadSeq = data?.session_id && data.unread > 0 ? data.last_seq : 0;
  useEffect(() => {
    if (!visible || !unreadSeq || !data?.session_id) return;
    void api.post<AssistantChat>('/assistant/read', { session_id: data.session_id, seq: unreadSeq }).then(() => qc.invalidateQueries({ queryKey: ['assistant'] }));
  }, [visible, unreadSeq, data?.session_id, qc]);
  if (!data) return <Page title="Assistant">{null}</Page>;
  if (data.session_id) {
    return <SessionView key={data.session_id} chat={{ id: data.session_id, title: 'Assistant', subtitle: 'Ask me to set up projects, repos and items', onNew: () => newChat.mutate() }} />;
  }
  return <EmptyChat />;
}

/** Pending messages of an Assistant chat that does not exist yet: they move to it once it does. */
export const NEW_ASSISTANT = 'assistant:new';

function EmptyChat() {
  const qc = useQueryClient();
  const images = useChatImages();
  const [text, setText] = useState('');
  const pending = usePending(NEW_ASSISTANT);
  // the first message shows at once; the chat opens when the server has it (DISP-83)
  const send = () => {
    sendPending(NEW_ASSISTANT, { text, images: images.take() }, async (b) => {
      const s = await api.post<Session>('/assistant/messages', b);
      void qc.invalidateQueries({ queryKey: ['assistant'] });
      return { chat: `session:${s.id}` };
    });
    setText('');
  };
  const editAgain = (p: Pending) => {
    setText((t) => (t ? `${t}\n${p.text}` : p.text));
    images.restore(p.images);
  };
  return (
    <Page
      title="Assistant"
      subtitle="Ask me to set up projects, repos and items"
      footer={
        <ChatInput value={text} onChange={setText} onSubmit={send} canSubmit={!images.uploading} placeholder="Tell me what to do — or paste a screenshot of an error to log a bug" {...images.input} />
      }
    >
      {pending.length ? <div className="pt-3"><PendingMessages pending={pending} onEdit={editAgain} /></div> : (
        <div className="px-4 pt-6 space-y-2">
          <p className="text-sm text-muted mb-3">For example:</p>
          {EXAMPLES.map((ex) => (
            <button key={ex} onClick={() => setText(ex)} className="block w-full text-left rounded-lg border border-line bg-panel px-3 py-2 text-[14px] active:bg-raised">
              {ex}
            </button>
          ))}
        </div>
      )}
      <div className="px-4"><ErrorText error={images.error ? new Error(`An image could not be added: ${images.error}`) : null} /></div>
    </Page>
  );
}
