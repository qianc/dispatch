import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.ts';
import { Button, ErrorText, inputCls } from '../components/ui.tsx';

export function Login() {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api.post('/login', { password }),
    onSuccess: () => qc.invalidateQueries(),
  });
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
