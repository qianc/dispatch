import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AssistantChat, type ProjectSummary, type Session } from '../api.ts';
import { taggedKeys } from '../mentions.ts';
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
    () => false,
  );
}

/**
 * `/assistant?project=KEY` (Ask on a project, DISP-84): what goes in the new chat's box, and what to
 * tell the owner. An unknown key: an empty box and a notice. A locked one: the tag, and a notice.
 */
export function assistantLink(key: string, projects: Pick<ProjectSummary, 'key' | 'disabled'>[]): { prefill: string; notice: string | null } {
  const p = projects.find((x) => x.key === key.trim().toUpperCase());
  if (!p) return { prefill: '', notice: `Project ${key} was not found.` };
  return { prefill: `@${p.key} `, notice: p.disabled ? `${p.key} is locked (read-only). The Assistant can unlock it if you ask.` : null };
}

function LinkNotice({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div role="status" className="mx-4 mt-3 flex items-start gap-2 rounded-xl border border-wait/40 bg-wait/5 px-3 py-2.5 text-[14px]">
      <p className="flex-1">{text}</p>
      <button onClick={onClose} aria-label="Dismiss" className="text-muted px-1">✕</button>
    </div>
  );
}

export function Assistant() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['assistant'], queryFn: () => api.get<AssistantChat>('/assistant') });
  // for @ tags (DISP-82): the same list as the menu's
  const { data: projects = [], isSuccess: projectsLoaded } = useQuery({ queryKey: ['projects'], queryFn: () => api.get<ProjectSummary[]>('/projects') });
  const newChat = useMutation({
    mutationFn: () => api.post('/assistant/new'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assistant'] }),
  });
  // Ask on a project (DISP-84): a new chat with the project tagged in its box. The link is used once:
  // it leaves the address, so a reload does not fill the box or start a chat again.
  const [params, setParams] = useSearchParams();
  const linked = params.get('project');
  const [prefill, setPrefill] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const linkUsed = useRef(false);
  useEffect(() => {
    if (!linked || linkUsed.current || !data || !projectsLoaded) return;
    linkUsed.current = true;
    const r = assistantLink(linked, projects);
    setNotice(r.notice);
    if (r.prefill) {
      setPrefill(r.prefill);
      if (data.session_id) newChat.mutate();
    }
    setParams({}, { replace: true });
  }, [linked, data, projectsLoaded]);
  const noticeView = notice ? <LinkNotice text={notice} onClose={() => setNotice(null)} /> : undefined;
  // open and on screen: the replies are read (clears the badge on the Assistant menu)
  const visible = useVisible();
  const unreadSeq = data?.session_id && data.unread > 0 ? data.last_seq : 0;
  useEffect(() => {
    if (!visible || !unreadSeq || !data?.session_id) return;
    void api.post<AssistantChat>('/assistant/read', { session_id: data.session_id, seq: unreadSeq }).then(() => qc.invalidateQueries({ queryKey: ['assistant'] }));
  }, [visible, unreadSeq, data?.session_id, qc]);
  if (!data) return <Page title="Assistant">{null}</Page>;
  if (data.session_id) {
    return <SessionView key={data.session_id} chat={{ id: data.session_id, title: 'Assistant', subtitle: 'Ask me to set up projects, repos and items', onNew: () => newChat.mutate(), projects, intro: noticeView }} />;
  }
  return <EmptyChat projects={projects} notice={noticeView} prefill={prefill} onPrefilled={() => setPrefill(null)} />;
}

/** Pending messages of an Assistant chat that does not exist yet: they move to it once it does. */
export const NEW_ASSISTANT = 'assistant:new';

export function EmptyChat({ projects, notice, prefill = null, onPrefilled }: { projects: ProjectSummary[]; notice?: ReactNode; prefill?: string | null; onPrefilled?: () => void }) {
  const qc = useQueryClient();
  const images = useChatImages();
  const [text, setText] = useState(prefill ?? '');
  const [focus, setFocus] = useState(false);
  // the tag from Ask on a project, once, with the caret after it
  useEffect(() => {
    if (prefill === null) return;
    setText(prefill);
    setFocus(true);
    onPrefilled?.();
  }, [prefill]);
  const pending = usePending(NEW_ASSISTANT);
  // the first message shows at once; the chat opens when the server has it (DISP-83)
  const send = () => {
    const project_keys = taggedKeys(text, new Set(projects.map((p) => p.key)));
    sendPending(NEW_ASSISTANT, { text, images: images.take(), project_keys }, async (b) => {
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
        <ChatInput value={text} onChange={setText} onSubmit={send} canSubmit={!images.uploading} projects={projects} autoFocus={focus} placeholder="Tell me what to do — @ tags a project; paste a screenshot of an error to log a bug" {...images.input} />
      }
    >
      {notice}
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
