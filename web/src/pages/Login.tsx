import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.ts';
import { Button, ErrorText, inputCls } from '../components/ui.tsx';

/** Where to go after signing in: ?next= (same site only), e.g. back to an OAuth approval. */
function nextPath() {
  const next = new URLSearchParams(location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : null;
}

/** Signed out behind a sign-in proxy: its login opens on /signin (a server route, past the offline cache). */
export function SignedOut() {
  return (
    <div className="flex-1 flex items-center justify-center p-6 pt-safe">
      <div className="w-full max-w-xs text-center">
        <img src="/icon.svg" alt="" className="size-14 mx-auto mb-4 rounded-2xl" />
        <h1 className="text-lg font-semibold mb-2">Signed out</h1>
        <p className="text-sm text-muted mb-5">Your sign-in has expired.</p>
        <Button variant="primary" className="w-full" onClick={() => location.assign(`/signin?to=${encodeURIComponent(location.pathname + location.search)}`)}>Sign in again</Button>
      </div>
    </div>
  );
}

export function Login({ passwordLogin = true }: { passwordLogin?: boolean }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api.post('/login', { password }),
    onSuccess: () => {
      const next = nextPath();
      if (next) location.assign(next);
      else qc.invalidateQueries();
    },
  });
  if (!passwordLogin) return <SignedOut />;
  return (
    <div className="flex-1 flex items-center justify-center p-6 pt-safe">
      <form className="w-full max-w-xs" onSubmit={(e) => { e.preventDefault(); login.mutate(); }}>
        <img src="/icon.svg" alt="" className="size-14 mx-auto mb-4 rounded-2xl" />
        <h1 className="text-center text-lg font-semibold mb-6">Dispatch</h1>
        <input type="password" autoComplete="current-password" className={inputCls} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus aria-label="Password" />
        <ErrorText error={login.error} />
        <Button variant="primary" className="w-full mt-3" disabled={!password || login.isPending}>Sign in</Button>
      </form>
    </div>
  );
}
