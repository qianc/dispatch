import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Me } from '../api.ts';
import { useAccounts } from '../accounts.ts';
import { Page } from '../components/Layout.tsx';
import { Button, Card, Chip, ErrorText, Field, Section, Segmented, cx, inputCls } from '../components/ui.tsx';
import { useWorkers, type WorkerRow } from '../workers.ts';
import { getTheme, setTheme, type Theme } from '../theme.ts';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../push.ts';

export function Settings() {
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/me') });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ github: boolean; legacy_token: boolean; auth_mode: string }>('/settings') });
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
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
    <Page title="Settings" wide>
      {/* desktop: sections flow into two columns */}
      <div className="lg:columns-2 lg:gap-0">
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
      <ServerGithubSection />
      <WorkersSection />
      <AccessSection />
      <Section title="Status">
        <Card className="p-3 text-sm text-muted space-y-1">
          <div>Sign-in: {settings?.auth_mode === 'proxy' ? `through the proxy${me?.user ? `, as ${me.user}` : ''}` : settings?.auth_mode === 'off' ? 'off (testing)' : 'password'}</div>
          <div>GitHub token: {settings?.github ? 'configured' : 'missing (PR sync and merge are off)'}</div>
          <div>Installed as app: {standalone ? 'yes' : 'no'}</div>
          <div>Build: {__BUILD__} UTC</div>
        </Card>
      </Section>
      {!me?.auth_disabled && (
        <div className="px-3 mt-6"><Button variant="danger" className="w-full" onClick={() => logout.mutate()}>Sign out</Button></div>
      )}
      </div>
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

/** The server's own GitHub access: it follows PRs and merges. Workers clone and push with theirs. */
function ServerGithubSection() {
  const { data } = useAccounts();
  if (!data) return null;
  return (
    <Section title="GitHub (server)">
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
      <p className="mx-4 mt-1.5 text-[12px] text-muted">The server uses this to follow PRs and merge them. Each worker clones and pushes with its own GitHub access, listed under Workers.</p>
    </Section>
  );
}

interface ApiTokenRow { id: number; name: string; prefix: string; scopes: string[]; created_at: string; expires_at: string | null; last_used_at: string | null; revoked_at: string | null }
interface GrantRow { id: number; client_name: string; scopes: string[]; created_at: string; last_used_at: string | null; refresh_expires_at: string }

const SCOPE_INFO: Record<string, string> = {
  tracker: 'Items, comments, sources, images',
  read: 'Read only',
  sessions: 'Start and steer agents, merge',
  admin: 'Projects, repos, settings',
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : 'never');

/** A worker's own logins: its Claude accounts (with how to log in when one needs it) and GitHub accounts. */
function WorkerAccounts({ w }: { w: WorkerRow }) {
  const claude = w.facts?.claude_accounts ?? [];
  const github = w.facts?.github_accounts ?? [];
  if (!claude.length && !github.length) return null;
  return (
    <div className="mt-2 rounded-lg bg-bg border border-line divide-y divide-line">
      {claude.map((a) => (
        <div key={a.name} className="px-2.5 py-1.5">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-muted shrink-0">Claude</span>
            <span className="flex-1 min-w-0 truncate">{a.label}</span>
            <Chip tone={a.logged_in === false ? 'bad' : a.logged_in ? 'ok' : 'neutral'}>{a.logged_in === false ? 'needs login' : a.logged_in ? 'logged in' : a.kind}</Chip>
          </div>
          <div className="text-[12px] text-muted break-all">
            {a.name} · {a.kind === 'config_dir' ? `login in ${a.config_dir}` : a.kind === 'oauth_token' ? 'setup-token' : a.kind === 'api_key' ? 'API key' : `login in ${a.config_dir ?? '~/.claude'}`}
          </div>
          {a.logged_in === false && a.config_dir && (
            <div className="text-[12px] text-wait mt-0.5">On {w.name}: <code>CLAUDE_CONFIG_DIR={a.config_dir} claude</code>, then /login</div>
          )}
        </div>
      ))}
      {github.length > 0 && (
        <div className="px-2.5 py-1.5 flex items-center gap-2 text-[13px]">
          <span className="text-muted shrink-0">GitHub</span>
          <span className="flex-1 min-w-0 truncate">{github.join(', ')}</span>
        </div>
      )}
    </div>
  );
}

/** The machines that run agents: each has its own token and a description the planner reads. */
function WorkersSection() {
  const qc = useQueryClient();
  const { data } = useWorkers();
  const [form, setForm] = useState({ name: '', description: '' });
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [editing, setEditing] = useState<{ id: number; description: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['workers'] });
  const create = useMutation({
    mutationFn: () => api.post<{ worker: WorkerRow; secret: string }>('/workers', form),
    onSuccess: (r) => { setSecret({ name: r.worker.name, secret: r.secret }); setForm({ name: '', description: '' }); refresh(); },
  });
  const save = useMutation({ mutationFn: (e: { id: number; description: string }) => api.patch(`/workers/${e.id}`, { description: e.description }), onSuccess: () => { setEditing(null); refresh(); } });
  const revoke = useMutation({ mutationFn: (id: number) => api.del(`/workers/${id}`), onSuccess: refresh });
  const setDefault = useMutation({ mutationFn: (id: number) => api.put('/settings/default-worker', { worker_id: id }), onSuccess: refresh });
  const workers = data?.workers ?? [];
  const { data: accounts } = useAccounts();
  const setAssistant = useMutation({
    mutationFn: (name: string | null) => api.patch('/settings', { assistant_claude_account: name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  });
  // the Assistant runs on the default worker, with one of its Claude logins
  const assistantChoices = workers.find((w) => w.id === data?.default_worker_id)?.facts?.claude_accounts ?? [];
  return (
    <Section title="Workers">
      <Card>
        {workers.map((w) => (
          <div key={w.id} className="px-3 py-2.5 border-b border-line last:border-b-0">
            <div className="flex items-center gap-2">
              <span className={cx('size-2 rounded-full shrink-0', w.connected ? 'bg-ok' : 'bg-faint')} aria-label={w.connected ? 'online' : 'offline'} />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{w.name}{w.id === data?.default_worker_id && <Chip className="ml-2">used by default</Chip>}</div>
                <div className="text-[12px] text-muted">
                  {w.connected ? 'online' : `last seen ${when(w.last_seen_at)}`}
                  {w.facts?.os ? ` · ${w.facts.os}` : ''}
                  {w.facts?.slots ? ` · ${w.facts.free_slots}/${w.facts.slots} slots free` : ''}
                  {w.legacy ? ' · connects with WORKER_TOKEN' : ''}
                </div>
              </div>
              {w.id !== data?.default_worker_id && <Button small variant="ghost" onClick={() => setDefault.mutate(w.id)}>Make default</Button>}
              {!w.legacy && <Button small variant="ghost" onClick={() => confirm(`Revoke worker "${w.name}"? It is cut off at once.`) && revoke.mutate(w.id)}>Revoke</Button>}
            </div>
            {editing?.id === w.id ? (
              <form className="mt-2" onSubmit={(e) => { e.preventDefault(); save.mutate(editing); }}>
                <textarea className={cx(inputCls, 'min-h-16')} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} aria-label={`Description of ${w.name}`} />
                <div className="flex gap-2 mt-1.5"><Button small variant="primary">Save</Button><Button small type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
              </form>
            ) : (
              <button type="button" className="mt-1 text-left text-[13px] text-muted w-full" onClick={() => setEditing({ id: w.id, description: w.description })}>
                {w.description || 'Add a description: what this machine has, and when to use it. The planner reads it.'}
              </button>
            )}
            <WorkerAccounts w={w} />
          </div>
        ))}
      </Card>
      {assistantChoices.length > 1 && (
        <div className="mx-3 mt-3">
          <Field label="Assistant runs on" group hint="The Assistant runs on the default worker. It only manages the tracker; it does not read project code.">
            <Segmented
              value={accounts?.assistant_claude_account ?? ''}
              onChange={(v) => setAssistant.mutate(v || null)}
              options={[{ value: '', label: `Default · ${assistantChoices[0]?.label}` }, ...assistantChoices.slice(1).map((a) => ({ value: a.name, label: a.label }))]}
            />
          </Field>
        </div>
      )}
      <form className="mx-3 mt-3 rounded-xl border border-line bg-panel p-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Field label="New worker" hint="Lowercase letters, digits and dashes."><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. desktop" /></Field>
        <Field label="Description"><textarea className={cx(inputCls, 'min-h-16')} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. Windows desktop in WSL. Has PowerPoint. Often asleep." /></Field>
        <ErrorText error={create.error ?? save.error ?? revoke.error ?? setDefault.error} />
        <Button variant="primary" className="w-full" disabled={!form.name.trim() || create.isPending}>Create worker</Button>
        {secret && (
          <div className="mt-3 rounded-lg border border-wait/40 bg-wait/10 p-2.5">
            <p className="text-[13px] mb-1.5">The token for {secret.name}. Copy it now: it is not shown again. Put it in the worker's config (WORKER_TOKEN, or token_file in WORKER_CONFIG).</p>
            <code className="block text-[12px] break-all bg-bg rounded p-2 select-all">{secret.secret}</code>
            <div className="flex gap-2 mt-2">
              <Button small type="button" onClick={() => void navigator.clipboard?.writeText(secret.secret)}>Copy</Button>
              <Button small type="button" variant="ghost" onClick={() => setSecret(null)}>Done</Button>
            </div>
          </div>
        )}
      </form>
    </Section>
  );
}

/** Personal tokens for scripts and skills, and apps connected through OAuth (Claude's MCP connector). */
function AccessSection() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ legacy_token: boolean }>('/settings') });
  const { data: tokens = [] } = useQuery({ queryKey: ['tokens'], queryFn: () => api.get<ApiTokenRow[]>('/tokens') });
  const { data: grants = [] } = useQuery({ queryKey: ['grants'], queryFn: () => api.get<GrantRow[]>('/oauth/grants') });
  const [form, setForm] = useState({ name: '', scopes: ['tracker'] as string[], days: '' });
  const [secret, setSecret] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tokens'] });
    void qc.invalidateQueries({ queryKey: ['grants'] });
    void qc.invalidateQueries({ queryKey: ['settings'] });
  };
  const create = useMutation({
    mutationFn: () => api.post<{ secret: string }>('/tokens', { name: form.name, scopes: form.scopes, expires_days: form.days ? Number(form.days) : null }),
    onSuccess: (r) => { setSecret(r.secret); setForm({ name: '', scopes: ['tracker'], days: '' }); refresh(); },
  });
  const revoke = useMutation({ mutationFn: (id: number | 'legacy') => api.del(`/tokens/${id}`), onSuccess: refresh });
  const disconnect = useMutation({ mutationFn: (id: number) => api.del(`/oauth/grants/${id}`), onSuccess: refresh });
  const live = tokens.filter((t) => !t.revoked_at && (!t.expires_at || t.expires_at > new Date().toISOString()));
  return (
    <>
      <Section title="Tokens">
        <Card>
          {live.map((t) => (
            <div key={t.id} className="flex items-center gap-2 px-3 py-2.5 border-b border-line last:border-b-0">
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{t.name}</div>
                <div className="text-[12px] text-muted">{t.prefix}… · {t.scopes.join(', ')} · used {when(t.last_used_at)}{t.expires_at ? ` · expires ${when(t.expires_at)}` : ''}</div>
              </div>
              <Button small variant="ghost" onClick={() => confirm(`Revoke "${t.name}"? Scripts using it stop working.`) && revoke.mutate(t.id)}>Revoke</Button>
            </div>
          ))}
          {settings?.legacy_token && (
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-line last:border-b-0">
              <div className="flex-1 min-w-0">
                <div className="font-medium">Old all-access token</div>
                <div className="text-[12px] text-wait">From before named tokens. Every scope from this machine; read and tracker from elsewhere.</div>
              </div>
              <Button small variant="ghost" onClick={() => confirm('Retire the old token? Scripts still using it stop working.') && revoke.mutate('legacy')}>Retire</Button>
            </div>
          )}
          {!live.length && !settings?.legacy_token && <p className="px-3 py-2.5 text-[13px] text-muted">No tokens. Scripts and skills need one to reach Dispatch.</p>}
        </Card>
        <form className="mx-3 mt-3 rounded-xl border border-line bg-panel p-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="New token for"><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. laptop skills" /></Field>
          <Field label="It may" group hint="From another machine a token only gets read and tracker, whatever it was made with.">
            <div className="space-y-1.5">
              {Object.entries(SCOPE_INFO).map(([scope, info]) => (
                <label key={scope} className="flex items-center gap-2 text-[14px]">
                  <input type="checkbox" className="size-4 accent-[var(--color-accent-strong)]" checked={form.scopes.includes(scope)}
                    onChange={(e) => setForm({ ...form, scopes: e.target.checked ? [...form.scopes, scope] : form.scopes.filter((x) => x !== scope) })} />
                  <span className="font-medium">{scope}</span><span className="text-muted">{info}</span>
                </label>
              ))}
            </div>
          </Field>
          <Field label="Expires">
            <select className={inputCls} value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })}>
              <option value="">Never</option><option value="30">In 30 days</option><option value="90">In 90 days</option><option value="365">In a year</option>
            </select>
          </Field>
          <ErrorText error={create.error ?? revoke.error} />
          <Button variant="primary" className="w-full" disabled={!form.name.trim() || !form.scopes.length || create.isPending}>Create token</Button>
          {secret && (
            <div className="mt-3 rounded-lg border border-wait/40 bg-wait/10 p-2.5">
              <p className="text-[13px] mb-1.5">Copy it now: it is not shown again.</p>
              <code className="block text-[12px] break-all bg-bg rounded p-2 select-all">{secret}</code>
              <div className="flex gap-2 mt-2">
                <Button small type="button" onClick={() => void navigator.clipboard?.writeText(secret)}>Copy</Button>
                <Button small type="button" variant="ghost" onClick={() => setSecret(null)}>Done</Button>
              </div>
            </div>
          )}
        </form>
      </Section>
      <Section title="Connected apps">
        <Card>
          {grants.map((g) => (
            <div key={g.id} className="flex items-center gap-2 px-3 py-2.5 border-b border-line last:border-b-0">
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{g.client_name}</div>
                <div className="text-[12px] text-muted">{g.scopes.join(', ')} · since {when(g.created_at)} · used {when(g.last_used_at)}</div>
              </div>
              <Button small variant="ghost" onClick={() => confirm(`Disconnect ${g.client_name}?`) && disconnect.mutate(g.id)}>Disconnect</Button>
            </div>
          ))}
          {!grants.length && <p className="px-3 py-2.5 text-[13px] text-muted">None. Add Dispatch as a connector in Claude with the address <code>{location.origin}/mcp</code>.</p>}
        </Card>
      </Section>
    </>
  );
}
