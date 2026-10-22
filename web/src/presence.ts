// Tells the server whether this device has the app in focus: while it has, the server sends this
// device no system notifications (the open app shows them itself, see Notices in Layout.tsx).
import { currentSubscription } from './push.ts';

/** The server forgets focus after 45 s without a renewal, so a closed app gets notifications again. */
const RENEW_MS = 20_000;

export const appFocused = () => document.visibilityState === 'visible' && document.hasFocus();

export function trackPresence(): () => void {
  let endpoint: string | null = null;
  let reported: boolean | null = null;
  let timer: number | undefined;

  const send = (active: boolean) => {
    if (!endpoint || (!active && reported === false)) return;
    reported = active;
    // keepalive: going to the background, the page may be frozen before an ordinary request leaves
    void fetch('/api/push/presence', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, active }),
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => undefined);
  };
  const report = () => {
    clearTimeout(timer);
    const active = appFocused();
    // synchronous with the last known subscription: the page can be frozen right after it is hidden
    send(active);
    if (!active) return;
    timer = window.setTimeout(report, RENEW_MS);
    // notifications can be turned on or off meanwhile (Settings)
    void currentSubscription().then((sub) => {
      const next = sub?.endpoint ?? null;
      if (next === endpoint) return;
      if (endpoint && !next) send(false);
      endpoint = next;
      reported = null;
      if (next && appFocused()) send(true);
    }, () => undefined);
  };

  report();
  const events = ['focus', 'blur', 'pagehide', 'pageshow'] as const;
  document.addEventListener('visibilitychange', report);
  for (const e of events) window.addEventListener(e, report);
  return () => {
    clearTimeout(timer);
    send(false);
    document.removeEventListener('visibilitychange', report);
    for (const e of events) window.removeEventListener(e, report);
  };
}
