import { useEffect, useState } from 'react';
import { Button } from '../components/ui.tsx';

// Pairing this device (the home-screen app's start page). Used where the sign-in proxy's SSO cannot
// run, e.g. an iPhone web app under a managed-browser-only policy: this screen shows a code, a person
// signed in on another device approves it in Settings, and this device gets its own session.
// Plain fetch, outside the app's sign-in gate: nothing here needs a session.

type Start = { authed: true } | { pair_id: string; code: string; expires_at: string };

async function signedIn() {
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin', redirect: 'error' });
    return r.ok && (await r.json()).authed === true;
  } catch {
    return false; // the proxy sent us to its sign-in: not signed in here
  }
}

export function Pair() {
  const [code, setCode] = useState<string | null>(null);
  const [pairId, setPairId] = useState<string | null>(null);
  const [state, setState] = useState<'checking' | 'waiting' | 'expired' | 'error'>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stop = false;
    void (async () => {
      if (await signedIn()) return location.replace('/');
      try {
        const r = await fetch('/api/devices/pair', { method: 'POST', credentials: 'same-origin' });
        const body = (await r.json()) as Start;
        if (stop) return;
        if ('authed' in body) return location.replace('/');
        setCode(body.code);
        setPairId(body.pair_id);
        setState('waiting');
      } catch {
        if (!stop) setState('error');
      }
    })();
    return () => { stop = true; };
  }, [attempt]);

  useEffect(() => {
    if (state !== 'waiting' || !pairId) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/devices/pair/${pairId}`, { credentials: 'same-origin' });
        const { status } = (await r.json()) as { status: string };
        if (status === 'approved') location.replace('/');
        else if (status === 'expired') setState('expired');
      } catch { /* offline for a moment: keep polling */ }
    }, 2000);
    return () => clearInterval(t);
  }, [state, pairId]);

  const again = () => { setCode(null); setPairId(null); setState('checking'); setAttempt((n) => n + 1); };
  return (
    <div className="flex-1 flex items-center justify-center p-6 pt-safe">
      <div className="w-full max-w-xs text-center">
        <img src="/icon.svg" alt="" className="size-14 mx-auto mb-4 rounded-2xl" />
        <h1 className="text-lg font-semibold mb-2">Pair this device</h1>
        {state === 'checking' && <p className="text-sm text-muted">One moment…</p>}
        {state === 'waiting' && code && (
          <>
            <p className="text-sm text-muted mb-4">On a computer where you are signed in, open Dispatch → Settings → Paired devices and enter:</p>
            <div className="font-mono text-3xl tracking-widest font-semibold mb-4 select-all" aria-label="Pairing code">{code}</div>
            <p className="text-[13px] text-muted">The code works for 10 minutes. This page continues by itself.</p>
          </>
        )}
        {state === 'expired' && (
          <>
            <p className="text-sm text-muted mb-5">The code ran out.</p>
            <Button variant="primary" className="w-full" onClick={again}>New code</Button>
          </>
        )}
        {state === 'error' && (
          <>
            <p className="text-sm text-muted mb-5">Could not reach Dispatch.</p>
            <Button variant="primary" className="w-full" onClick={again}>Try again</Button>
          </>
        )}
      </div>
    </div>
  );
}
