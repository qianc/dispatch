import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { registerSW } from 'virtual:pwa-register';
import './styles.css';
import { api, type Me } from './api.ts';
import { connectLive } from './live.ts';
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

registerSW({ immediate: true });

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: (n, e) => (e as { status?: number }).status !== 401 && n < 2 } },
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
