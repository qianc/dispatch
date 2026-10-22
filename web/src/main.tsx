import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { registerSW } from 'virtual:pwa-register';
import './styles.css';
import { api, ApiError, type Me } from './api.ts';
import { connectLive, liveHealthy } from './live.ts';
import { trackPresence } from './presence.ts';
import { initTheme } from './theme.ts';
import { Layout } from './components/Layout.tsx';
import { Login, SignedOut } from './pages/Login.tsx';
import { Inbox } from './pages/Inbox.tsx';
import { Activity } from './pages/Activity.tsx';
import { Projects } from './pages/Projects.tsx';
import { Project } from './pages/Project.tsx';
import { ItemDetail } from './pages/ItemDetail.tsx';
import { SessionView } from './pages/Session.tsx';
import { SourceView } from './pages/Source.tsx';
import { PrView } from './pages/Pr.tsx';
import { Settings } from './pages/Settings.tsx';
import { Assistant } from './pages/Assistant.tsx';
import { Discuss } from './pages/Discuss.tsx';
import { FileView } from './pages/FileView.tsx';

registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    // installed iOS apps rarely navigate, so look for a new version whenever the app is brought back
    if (reg) document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reg.update());
  },
});

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (n, e) => (e as { status?: number }).status !== 401 && n < 2,
      // live updates come over SSE; if a proxy holds the stream back, poll instead
      refetchInterval: () => (liveHealthy ? false : 4000),
    },
  },
});

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Inbox /> },
      { path: '/activity', element: <Activity /> },
      { path: '/projects', element: <Projects /> },
      { path: '/p/:key', element: <Project /> },
      { path: '/items/:id', element: <ItemDetail /> },
      { path: '/s/:id', element: <SessionView /> },
      { path: '/sources/:id', element: <SourceView /> },
      { path: '/pr/:id', element: <PrView /> },
      { path: '/settings', element: <Settings /> },
      { path: '/assistant', element: <Assistant /> },
      { path: '/items/:id/discuss', element: <Discuss /> },
      { path: '/files/:key', element: <FileView /> },
    ],
  },
]);

// a tapped notification: the service worker asks this window to show the chat it is about
navigator.serviceWorker?.addEventListener('message', (e: MessageEvent<{ type?: string; url?: string }>) => {
  if (e.data?.type !== 'navigate' || !e.data.url) return;
  const to = new URL(e.data.url, location.origin);
  if (to.origin === location.origin) void router.navigate(to.pathname + to.search + to.hash);
  e.ports[0]?.postMessage('ok');
});
navigator.serviceWorker?.startMessages();

function App() {
  const client = useQueryClient();
  const { data: me, error: meError } = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/me') });
  useEffect(() => {
    const onUnauthorized = () => client.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener('dispatch:unauthorized', onUnauthorized);
    return () => window.removeEventListener('dispatch:unauthorized', onUnauthorized);
  }, [client]);
  useEffect(() => (me?.authed ? connectLive(client) : undefined), [me?.authed, client]);
  useEffect(() => (me?.authed ? trackPresence() : undefined), [me?.authed]);
  // a sign-in proxy turned even /api/me away: its session expired
  if (!me && meError instanceof ApiError && meError.foreign) return <SignedOut />;
  if (!me) return null;
  if (!me.authed) return <Login passwordLogin={me.password_login} />;
  return <RouterProvider router={router} />;
}

(window as unknown as { __dispatchStarted: boolean }).__dispatchStarted = true;
initTheme();

// Fit the app to the visible area: when the iOS keyboard opens only the visual viewport shrinks, so
// without this the message box and the newest messages sit under the keyboard. Also mark
// "keyboard open" (the tab bar hides) and announce the change so chats can stay pinned to the bottom.
const vv = window.visualViewport;
// Only our own focused field can open the keyboard here. Back from another app that had its keyboard
// up, iOS still reports the shrunk visual viewport until the next touch: without a focused field,
// ignore that and use the full height.
const NO_KEYBOARD = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image']);
const typing = () => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el instanceof HTMLInputElement) return !NO_KEYBOARD.has(el.type);
  return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
};
// The full height for this width (a rotation changes both). Compared with this, not with innerHeight:
// with interactive-widget=resizes-content the layout viewport shrinks along with the keyboard, so
// innerHeight - visualViewport.height stays near 0 while the keyboard is up.
const fullHeight = new Map<number, number>();
const fitViewport = () => {
  const full = Math.max(fullHeight.get(window.innerWidth) ?? 0, window.innerHeight);
  fullHeight.set(window.innerWidth, full);
  const kb = !!vv && typing() && full - vv.height > 120;
  const h = vv && typing() ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
  document.documentElement.classList.toggle('kb-open', kb);
  if (vv?.offsetTop) window.scrollTo(0, 0);
  window.dispatchEvent(new Event('dispatch:viewport'));
};
vv?.addEventListener('resize', fitViewport);
vv?.addEventListener('scroll', fitViewport);
window.addEventListener('orientationchange', () => setTimeout(fitViewport, 300));
// back in the app: measure again, also after iOS has settled the viewport
const refit = () => {
  fitViewport();
  setTimeout(fitViewport, 100);
  setTimeout(fitViewport, 500);
};
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refit(); });
window.addEventListener('pageshow', refit);
window.addEventListener('focus', refit);
// focus moving into or out of a field opens or closes the keyboard, and iOS does not always send a
// viewport resize after it (e.g. focus lands after the resize, or the keyboard was already up):
// measure again then, also once the keyboard has finished moving
document.addEventListener('focusin', refit);
document.addEventListener('focusout', () => setTimeout(refit, 0)); // activeElement is the next field by then
fitViewport();

// The document is locked (only .scroll-area scrolls). If iOS scrolls it anyway (keyboard, focus),
// the layout shifts and taps miss the tab bar: put it back.
const unshift = () => {
  if (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop) {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }
};
window.addEventListener('scroll', unshift, { passive: true });
document.addEventListener('focusout', () => setTimeout(unshift, 50));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
