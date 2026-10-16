import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Me } from '../api.ts';
import { useAccounts } from '../accounts.ts';
import { Page } from '../components/Layout.tsx';
import { Button, Card, Chip, ErrorText, Field, Section, Segmented } from '../components/ui.tsx';
import { getTheme, setTheme, type Theme } from '../theme.ts';
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
    onSuccess: () => {
      void currentSubscription().then((s) => setSubscribed(!!s));
      void qc.invalidateQueries({ queryKey: ['push-devices'] });
    },
  });
  const test = useMutation({ mutationFn: () => api.post<{ subscriptions: number }>('/push/test') });
  const { data: devices, refetch: refetchDevices } = useQuery({ queryKey: ['push-devices'], queryFn: () => api.get<{ count: number }>('/push/devices') });
  const keepOnly = useMutation({
    mutationFn: async () => {
      const sub = await currentSubscription();
      if (!sub) throw new Error('Notifications are not on for this device.');
      return api.post<{ removed: number }>('/push/keep-only', { endpoint: sub.endpoint });
    },
    onSuccess: () => refetchDevices(),
  });
  const logout = useMutation({ mutationFn: () => api.post('/logout'), onSuccess: () => qc.invalidateQueries() });
  const standalone = window.matchMedia('(display-mode: standalone)').matches;

  return (
    <Page title="Settings">
      <AppearanceSection />
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
              {subscribed && devices && devices.count > 1 && (
                <div className="rounded-lg border border-line p-2.5 text-[13px] text-muted space-y-2">
                  <p>{devices.count} devices get notifications. If you removed and added the app again, the old installs still count, and you can get the same notice more than once.</p>
                  <Button small className="w-full" disabled={keepOnly.isPending} onClick={() => keepOnly.mutate()}>Turn off other devices</Button>
                </div>
              )}
              {keepOnly.data && <p className="text-[12px] text-faint">Turned off {keepOnly.data.removed} other device(s).</p>}
              <ErrorText error={toggle.error ?? test.error ?? keepOnly.error} />
            </>
          )}
        </Card>
      </Section>
      <AccountsSection />
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
          <div>Build: {__BUILD__} UTC</div>
        </Card>
      </Section>
      {!me?.auth_disabled && (
        <div className="px-3 mt-6"><Button variant="danger" className="w-full" onClick={() => logout.mutate()}>Sign out</Button></div>
      )}
    </Page>
  );
}

function AppearanceSection() {
  const [theme, set] = useState<Theme>(getTheme);
  return (
    <Section title="Appearance">
      <div className="mx-3">
        <Segmented<Theme>
          value={theme}
          onChange={(t) => { setTheme(t); set(t); }}
          options={[{ value: 'auto', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
        />
        <p className="text-[12px] text-faint mt-1">Auto follows the device setting. Saved on this device.</p>
      </div>
    </Section>
  );
}

function AccountsSection() {
  const qc = useQueryClient();
  const { data } = useAccounts();
  const setAssistant = useMutation({
    mutationFn: (name: string | null) => api.patch('/settings', { assistant_claude_account: name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  });
  if (!data) return null;
  return (
    <>
      <Section title="Claude accounts">
        <Card>
          {data.claude.map((a) => (
            <div key={a.name} className="px-3 py-2.5 border-b border-line last:border-b-0">
              <div className="flex items-center gap-2">
                <span className="flex-1 font-medium">{a.label}</span>
                <Chip tone={a.logged_in === false ? 'bad' : a.logged_in ? 'ok' : 'neutral'}>{a.logged_in === false ? 'needs login' : a.logged_in ? 'logged in' : a.kind}</Chip>
              </div>
              <div className="text-[12px] text-muted break-all">
                {a.name} · {a.kind === 'config_dir' ? `login in ${a.config_dir}` : a.kind === 'oauth_token' ? 'setup-token' : a.kind === 'api_key' ? 'API key' : `this machine (${a.config_dir ?? '~/.claude'})`}
              </div>
              {a.logged_in === false && a.config_dir && (
                <div className="text-[12px] text-wait mt-1">On the worker machine: <code>CLAUDE_CONFIG_DIR={a.config_dir} claude</code>, then /login</div>
              )}
            </div>
          ))}
          {!data.claude.length && <p className="p-3 text-[13px] text-muted">The worker has not connected yet.</p>}
        </Card>
        {data.claude.length > 1 && (
          <div className="mx-3 mt-3">
            <Field label="Assistant runs on" group hint="The Assistant only manages the tracker; it does not read project code.">
              <Segmented
                value={data.assistant_claude_account ?? ''}
                onChange={(v) => setAssistant.mutate(v || null)}
                options={[{ value: '', label: `Default · ${data.claude[0]?.label}` }, ...data.claude.slice(1).map((a) => ({ value: a.name, label: a.label }))]}
              />
            </Field>
          </div>
        )}
      </Section>
      <Section title="GitHub accounts">
        <Card>
          {data.github.map((a) => (
            <div key={a.name} className="px-3 py-2.5 border-b border-line last:border-b-0">
              <div className="flex items-center gap-2">
                <span className="flex-1 font-medium">{a.name}</span>
                <Chip tone={a.login ? 'ok' : 'bad'}>{a.login ? `@${a.login}` : 'token not working'}</Chip>
              </div>
              <div className="text-[12px] text-muted">{[a.git_name, a.git_email].filter(Boolean).join(' · ') || 'commits use the worker default identity'}</div>
            </div>
          ))}
          {!data.github.length && <p className="p-3 text-[13px] text-muted">No GitHub account configured (GITHUB_ACCOUNTS or GITHUB_TOKEN).</p>}
        </Card>
      </Section>
    </>
  );
}
