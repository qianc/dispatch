import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { registerSW } from 'virtual:pwa-register';
import './styles.css';
import { api, type Me } from './api.ts';
import { connectLive, liveHealthy } from './live.ts';
import { Layout } from './components/Layout.tsx';
import { Login } from './pages/Login.tsx';
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
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/me') });
  useEffect(() => {
    const onUnauthorized = () => client.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener('dispatch:unauthorized', onUnauthorized);
    return () => window.removeEventListener('dispatch:unauthorized', onUnauthorized);
  }, [client]);
  useEffect(() => (me?.authed ? connectLive(client) : undefined), [me?.authed, client]);
  if (!me) return null;
  if (!me.authed) return <Login />;
  return <RouterProvider router={router} />;
}

(window as unknown as { __dispatchStarted: boolean }).__dispatchStarted = true;

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
