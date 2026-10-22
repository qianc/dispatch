import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { CloseButton } from './ui.tsx';

interface Notice { title: string; body: string; url: string; tag?: string }

/**
 * Notifications while the app is open: a banner in the page. A device with the app in focus gets no
 * system notification (presence.ts), so this is where it sees them.
 */
export function Notices() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => {
    const onNotice = (e: Event) => {
      const n = (e as CustomEvent<Notice>).detail;
      if (document.visibilityState !== 'visible') return;
      // already on that screen: the update shows there
      if (new URL(n.url, location.origin).pathname === location.pathname) return;
      setNotice(n);
    };
    window.addEventListener('dispatch:notice', onNotice);
    return () => window.removeEventListener('dispatch:notice', onNotice);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);
  // going to the screen it is about answers it
  useEffect(() => {
    if (notice && new URL(notice.url, location.origin).pathname === loc.pathname) setNotice(null);
  }, [loc.pathname]);
  if (!notice) return null;
  return (
    <div className="fixed inset-x-2 top-[calc(env(safe-area-inset-top)+3.5rem)] z-40 lg:left-auto lg:right-4 lg:w-96" role="status" aria-label="Notification">
      <div className="flex items-start rounded-xl border border-line bg-panel shadow-lg">
        <button type="button" className="flex-1 min-w-0 text-left px-3 py-2.5" onClick={() => { setNotice(null); nav(notice.url); }}>
          <div className="text-[14px] font-medium truncate">{notice.title}</div>
          {notice.body && <div className="text-[13px] text-muted line-clamp-2 [overflow-wrap:anywhere]">{notice.body}</div>}
        </button>
        <CloseButton onClick={() => setNotice(null)} label="Dismiss notification" />
      </div>
    </div>
  );
}
