import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Me } from '../api.ts';
import { Page } from '../components/Layout.tsx';
import { Button, Card, ErrorText, Section } from '../components/ui.tsx';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../push.ts';

export function Settings() {
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/me') });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ api_token: string; github: boolean }>('/settings') });
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [showToken, setShowToken] = useState(false);
  useEffect(() => { currentSubscription().then((s) => setSubscribed(!!s)).catch(() => setSubscribed(false)); }, []);
  const toggle = useMutation({
    mutationFn: async () => (subscribed ? disablePush() : enablePush(me!.vapid_public_key)),
    onSuccess: () => currentSubscription().then((s) => setSubscribed(!!s)),
  });
  const test = useMutation({ mutationFn: () => api.post<{ subscriptions: number }>('/push/test') });
  const logout = useMutation({ mutationFn: () => api.post('/logout'), onSuccess: () => qc.invalidateQueries() });
  const standalone = window.matchMedia('(display-mode: standalone)').matches;

  return (
    <Page title="Settings">
      <Section title="Notifications">
        <Card className="p-3 space-y-2">
          {!pushSupported() ? (
            <p className="text-sm text-muted">
              Push is not available in this browser.{!standalone && ' On iPhone: Share → Add to Home Screen, then open Dispatch from the home screen.'}
            </p>
          ) : (
            <>
              <p className="text-sm text-muted">Get a push when Claude asks a question, needs a plan approved, finishes a turn, or opens a PR.</p>
              <Button variant={subscribed ? 'secondary' : 'primary'} className="w-full" disabled={subscribed === null || toggle.isPending || !me} onClick={() => toggle.mutate()}>
                {subscribed ? 'Turn off on this device' : 'Turn on for this device'}
              </Button>
              {subscribed && <Button className="w-full" onClick={() => test.mutate()} disabled={test.isPending}>Send test notification</Button>}
              {test.data && <p className="text-[12px] text-faint">Sent to {test.data.subscriptions} device(s).</p>}
              <ErrorText error={toggle.error ?? test.error} />
            </>
          )}
        </Card>
      </Section>
      <Section title="API token">
        <Card className="p-3 space-y-2">
          <p className="text-sm text-muted">For skills and scripts that post retros: <code className="text-[12px]">POST /api/projects/KEY/sources</code> with <code className="text-[12px]">Authorization: Bearer …</code></p>
          <code className="block text-[12px] break-all bg-bg rounded p-2 select-all">{showToken ? settings?.api_token : '••••••••••••••••'}</code>
          <Button small onClick={() => setShowToken(!showToken)}>{showToken ? 'Hide' : 'Show'}</Button>
        </Card>
      </Section>
      <Section title="Status">
        <Card className="p-3 text-sm text-muted space-y-1">
          <div>GitHub token: {settings?.github ? 'configured' : 'missing (PR sync and merge are off)'}</div>
          <div>Installed as app: {standalone ? 'yes' : 'no'}</div>
        </Card>
      </Section>
      {!me?.auth_disabled && (
        <div className="px-3 mt-6"><Button variant="danger" className="w-full" onClick={() => logout.mutate()}>Sign out</Button></div>
      )}
    </Page>
  );
}
