import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { registerSW } from 'virtual:pwa-register';
import './styles.css';
import { api, ApiError, type Me } from './api.ts';
import { connectLive, liveHealthy } from './live.ts';
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

function App() {
  const client = useQueryClient();
  const { data: me, error: meError } = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/me') });
  useEffect(() => {
    const onUnauthorized = () => client.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener('dispatch:unauthorized', onUnauthorized);
    return () => window.removeEventListener('dispatch:unauthorized', onUnauthorized);
  }, [client]);
  useEffect(() => (me?.authed ? connectLive(client) : undefined), [me?.authed, client]);
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
const typing = () => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};
const fitViewport = () => {
  const kb = !!vv && typing() && window.innerHeight - vv.height > 120;
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
