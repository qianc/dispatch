// DISP-117: a session on 'default' runs on the server's default model, a named family set in
// Settings (Opus at medium effort at first), on every worker. A worker never leaves the choice to
// Claude Code: a session that comes without a model is refused. The session shows what it ran on.
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartSpec, WorkerToServer } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS, type RunOptions } from '../src/shared/types.ts';
import { Secrets } from '../src/worker/secrets.ts';
import { ServerLink, Slots } from '../src/worker/serverLink.ts';
import { as, startMultiUser, startServer, startWorker, stopWorker, waitFor } from './helpers.ts';
import { modelName } from '../web/src/models.ts';

describe('the server default model', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let worker: ChildProcess;
  beforeAll(async () => {
    s = await startServer();
    worker = startWorker(s.port);
    await waitFor(() => s.ctx.hub.connected, 'worker connects');
    await s.call('POST', '/projects', { key: 'DM', name: 'DM' });
    await s.call('POST', '/projects/DM/repos', { github_owner: 'me', github_name: 'r' });
  });
  afterAll(async () => {
    await stopWorker(worker);
    await s.app.close();
  });

  const specOf = (id: number) => s.ctx.sessions.spec(s.ctx.store.session(id)!, '', null, null);
  const batch = async (options: Partial<RunOptions> = {}) => (await s.call('POST', '/projects/DM/batches', { prompt: 'x', options: { ...DEFAULT_RUN_OPTIONS, ...options } })).data as { id: number };

  it('starts as Opus at medium effort, and the install owner can change it', async () => {
    expect((await s.call('GET', '/settings/model')).data).toEqual({ model: 'opus', effort: 'medium' });
    expect((await s.call('PUT', '/settings/model', { model: 'claude-opus-5-5' })).status).toBe(400);
    expect((await s.call('PUT', '/settings/model', { model: 'default' })).status).toBe(400);
    expect((await s.call('PUT', '/settings/model', { effort: 'default' })).status).toBe(400);
    expect((await s.call('PUT', '/settings/model', { model: 'sonnet' })).data).toEqual({ model: 'sonnet', effort: 'medium' });
    expect((await s.call('GET', '/settings/model')).data).toEqual({ model: 'sonnet', effort: 'medium' });
    await s.call('PUT', '/settings/model', { model: 'opus', effort: 'medium' });
  });

  it("a worker gets the server's model for 'default', never the alias; a picked model stays", async () => {
    const a = await batch();
    expect(s.ctx.store.session(a.id)!.options).toMatchObject({ model: 'default', effort: 'default' });
    expect(specOf(a.id).options).toMatchObject({ model: 'opus', effort: 'medium' });
    expect(specOf((await batch({ model: 'haiku', effort: 'high' })).id).options).toMatchObject({ model: 'haiku', effort: 'high' });
    // a change of the setting applies to the next turn of a session on 'default'
    await s.call('PUT', '/settings/model', { model: 'fable', effort: 'low' });
    expect(specOf(a.id).options).toMatchObject({ model: 'fable', effort: 'low' });
    await s.call('PUT', '/settings/model', { model: 'opus', effort: 'medium' });
  });

  it('the session keeps the model the worker says it runs on', async () => {
    const b = await batch();
    const done = await waitFor(() => s.ctx.store.session(b.id)?.run_model, 'the run model');
    expect(done).toBe('fake-opus');
    expect((await s.call('GET', `/sessions/${b.id}`)).data.session.run_model).toBe('fake-opus');
  });
});

describe('the server default model: several people', () => {
  it('everyone sees it; only the install owner sets it', async () => {
    const s = await startMultiUser();
    try {
      expect((await s.call('GET', '/settings/model', undefined, as('bob'))).data).toEqual({ model: 'opus', effort: 'medium' });
      expect((await s.call('PUT', '/settings/model', { model: 'sonnet' }, as('bob'))).status).toBe(403);
      expect((await s.call('PUT', '/settings/model', { model: 'sonnet' }, as('alice'))).status).toBe(200);
    } finally {
      await s.app.close();
    }
  });
});

describe('a worker and a session without a model', () => {
  const link = () => {
    const entry = { name: 'home', url: 'ws://127.0.0.1:1/worker', token: 'dsw_x', local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: null, releases: [], repo_env_dir: '/nonexistent' };
    const l = new ServerLink(entry, {
      fake: true, opts: { assistantReadDirs: [] } as never, workspacesDir: mkdtempSync(join(tmpdir(), 'dsp-dm-')), slots: new Slots(2),
      claudeAccounts: () => [], githubAccounts: [], gitEnv: () => ({}), remoteBase: 'https://github.com', secrets: new Secrets(),
    });
    const sent: WorkerToServer[] = [];
    (l as unknown as { ws: unknown }).ws = { readyState: WebSocket.OPEN, send: (d: string) => sent.push(JSON.parse(d)) };
    return { start: (spec: StartSpec) => (l as unknown as { onMessage: (m: unknown) => Promise<void> }).onMessage({ t: 'start', spec }), sent };
  };
  const spec = (kind: StartSpec['kind'], model: StartSpec['options']['model']): StartSpec => ({
    session_id: 9, kind, project_key: 'DM', project_name: 'DM', importance_scale: [], effort_scale: [], title: 't', branch: null, repos: [], items: [], source: null,
    prompt: 'hi', force_plan: false, options: { ...DEFAULT_RUN_OPTIONS, model }, claude_account: null, github_account: null, resume: null, resume_note: null,
  });

  it('refuses to start it, with a clear message, instead of running on the alias', async () => {
    const { start, sent } = link();
    await start(spec('work', 'default'));
    expect(sent).toContainEqual({ t: 'status', session_id: 9, status: 'failed', error: expect.stringMatching(/^No model set for this session: server home sent none\. Set the default model in the server's Settings/) });
    expect(sent.some((m) => m.t === 'status' && m.status === 'running')).toBe(false);
  });

  it('starts it with a named model, and chats on their own model', async () => {
    process.env.FAKE_DELAY_MS = '1';
    const { start, sent } = link();
    await start(spec('work', 'opus'));
    await waitFor(() => sent.find((m) => m.t === 'status' && m.status === 'running'), 'it runs');
    expect(sent).toContainEqual(expect.objectContaining({ t: 'status', status: 'running', model: 'fake-opus' }));
    const chat = link();
    await chat.start({ ...spec('assistant', 'default'), session_id: 10 });
    expect(chat.sent.some((m) => m.t === 'status' && m.status === 'failed')).toBe(false);
  });
});

describe('model names in the app', () => {
  it('reads a model id as a person would', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(modelName('claude-opus-4-6[1m]')).toBe('Opus 4.6 (1M)');
    expect(modelName('opus')).toBe('Opus');
    expect(modelName('fake-opus')).toBe('fake-opus');
  });
});

describe('the default model in Settings', () => {
  it('the install owner picks a model family and effort; others see what it is', async () => {
    const { createElement } = await import('react');
    const { QueryClient } = await import('@tanstack/react-query');
    const { renderPage, stubBrowser } = await import('./web-render.ts');
    stubBrowser();
    const { ModelDefaultsSection } = await import('../web/src/components/modelDefaults.tsx');
    const qc = new QueryClient();
    qc.setQueryData(['settings', 'model'], { model: 'opus', effort: 'medium' });
    const owner = renderPage(createElement(ModelDefaultsSection, { owner: true }), { qc });
    const picked = [...owner.matchAll(/<button[^>]*aria-checked="true"[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    expect(picked).toEqual(['Opus', 'Med']);
    expect(owner).not.toContain('>Default<');
    const other = renderPage(createElement(ModelDefaultsSection, { owner: false }), { qc });
    expect(other).toContain('Opus at medium effort');
    expect(other).toContain('Only the install owner can change it.');
  });
});
