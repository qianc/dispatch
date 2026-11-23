import { useEffect, useState } from 'react';
import { Button } from '../components/ui.tsx';

// Pairing this device (the home-screen app's start page). Used where the sign-in proxy's SSO cannot
// run, e.g. an iPhone web app under a managed-browser-only policy: this screen shows a code, a person
// signed in on another device approves it in Settings, and this device gets its own session.
// Plain fetch, outside the app's sign-in gate: nothing here needs a session.

type PairState = 'checking' | 'waiting' | 'expired' | 'error';
type StartResult = { authed: true } | { pair_id: string; code: string } | { error: string };

/** The answer to `POST /api/devices/pair`. A refusal (429: the queue is full, or too many from this address) is an error with its message (DISP-214). */
export async function readStart(r: Response): Promise<StartResult> {
  const body = (await r.json().catch(() => ({}))) as { authed?: true; pair_id?: string; code?: string; error?: string };
  if (!r.ok) return { error: body.error || `Dispatch answered ${r.status}.` };
  if (body.authed) return { authed: true };
  if (!body.code || !body.pair_id) return { error: 'Dispatch gave no pairing code.' };
  return { pair_id: body.pair_id, code: body.code };
}

async function signedIn() {
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin', redirect: 'manual' });
    return r.ok && (await r.json()).authed === true;
  } catch {
    return false; // the proxy sent us to its sign-in: not signed in here
  }
}

export function Pair() {
  const [code, setCode] = useState<string | null>(null);
  const [pairId, setPairId] = useState<string | null>(null);
  const [state, setState] = useState<PairState>('checking');
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    void (async () => {
      if (await signedIn()) return location.replace('/');
      try {
        const r = await fetch('/api/devices/pair', { method: 'POST', credentials: 'same-origin' });
        const body = await readStart(r);
        if (stop) return;
        if ('authed' in body) return location.replace('/');
        if ('error' in body) {
          setError(body.error);
          setState('error');
          return;
        }
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

  const again = () => { setCode(null); setPairId(null); setError(null); setState('checking'); setAttempt((n) => n + 1); };
  return <PairScreen state={state} code={code} error={error} onAgain={again} />;
}

export function PairScreen({ state, code, error, onAgain: again }: { state: PairState; code: string | null; error: string | null; onAgain: () => void }) {
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
            <p className="text-sm text-muted mb-5">{error ?? 'Could not reach Dispatch.'}</p>
            <Button variant="primary" className="w-full" onClick={again}>Try again</Button>
          </>
        )}
      </div>
    </div>
  );
}
