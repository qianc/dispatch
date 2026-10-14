import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinPath, slug } from '../src/shared/paths.ts';
import { safeRelPath } from '../src/server/routes/files.ts';
import { Workspaces } from '../src/worker/workspace.ts';
import { startServer, startWorker, stopWorker, waitFor } from './helpers.ts';

describe('link helpers', () => {
  it('makes GitHub-style anchors from item titles', () => {
    expect(slug('B9 — The plan builds the deck')).toBe('b9--the-plan-builds-the-deck');
    expect(slug('N4 — `olefile` and `pyxlsb` have no route')).toBe('n4--olefile-and-pyxlsb-have-no-route');
  });
  it('joins relative links and never climbs above the root', () => {
    expect(joinPath('', 'docs/a.md')).toBe('docs/a.md');
    expect(joinPath('docs', '../skills/x/SKILL.md')).toBe('skills/x/SKILL.md');
    expect(joinPath('docs', '../../../etc/passwd')).toBe('etc/passwd');
    expect(joinPath('docs/sub', './img.png')).toBe('docs/sub/img.png');
  });
  it('rejects absolute and escaping paths on the server', () => {
    expect(safeRelPath('docs/a.md')).toBe('docs/a.md');
    expect(() => safeRelPath('/etc/passwd')).toThrow();
    expect(() => safeRelPath('../secret')).toThrow();
    expect(() => safeRelPath('docs/../../x')).toThrow();
  });
});

describe('reading a repo file from the default branch', () => {
  it('returns text and binary files byte for byte', async () => {
    const remoteRoot = mkdtempSync(join(tmpdir(), 'dsp-remote-'));
    const bare = join(remoteRoot, 'me', 'hc.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    const seed = mkdtempSync(join(tmpdir(), 'dsp-seed-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: seed, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init', '-b', 'main');
    mkdirSync(join(seed, 'docs'));
    writeFileSync(join(seed, 'docs', 'a.md'), '# Hello\n');
    writeFileSync(join(seed, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
    git('add', '.');
    git('commit', '-m', 'init');
    git('push', bare, 'main');
    const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')), `file://${remoteRoot}`);
    const repo = { id: 1, project_id: 1, github_owner: 'me', github_name: 'hc', default_branch: 'main', check_command: null };
    expect((await ws.readRepoFile(repo, 'docs/a.md')).toString()).toBe('# Hello\n');
    expect([...(await ws.readRepoFile(repo, 'pic.png'))]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    await expect(ws.readRepoFile(repo, 'missing.md')).rejects.toThrow();
  });
});

describe('discuss chats and files from a source folder', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let worker: ChildProcess;
  let srcDir: string;

  beforeAll(async () => {
    const allowed = mkdtempSync(join(tmpdir(), 'dsp-allowed-'));
    srcDir = join(allowed, 'slides');
    mkdirSync(join(srcDir, 'docs'), { recursive: true });
    writeFileSync(join(srcDir, 'docs', 'triage.md'), '# Triage\n\nDetails.');
    writeFileSync(join(allowed, 'outside.md'), 'no');
    s = await startServer();
    worker = startWorker(s.port, { ASSISTANT_READ_DIRS: srcDir });
    await waitFor(() => s.ctx.hub.connected, 'worker');
    await s.call('POST', '/projects', { key: 'SLD', name: 'slides' });
  });
  afterAll(async () => {
    await stopWorker(worker);
    await s.app.close();
  });

  it('serves linked files from the folder of an imported source, and nothing outside it', async () => {
    const src = (await s.call('POST', '/projects/SLD/sources', { kind: 'manual', title: join(srcDir, 'backlog.md'), body_md: 'x' })).data;
    const ok = await fetch(`${s.base}/api/projects/SLD/file?path=docs/triage.md&source=${src.id}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/text\/markdown/);
    expect(await ok.text()).toContain('# Triage');
    expect((await fetch(`${s.base}/api/projects/SLD/file?path=../outside.md&source=${src.id}`)).status).toBe(400);
    expect((await fetch(`${s.base}/api/projects/SLD/file?path=nope.md&source=${src.id}`)).status).toBe(404);
    expect((await fetch(`${s.base}/api/projects/SLD/file?path=docs/triage.md`)).status).toBe(404); // no repo, no source
  });

  it('runs a read-only discuss chat per item, outside the agent lists and slots', async () => {
    const item = (await s.call('POST', '/projects/SLD/items', { title: 'Charts overlap' })).data;
    const chat = (await s.call('POST', `/items/${item.id}/discuss`, { text: 'what is this?' })).data;
    expect(chat).toMatchObject({ kind: 'discuss', item_ids: [item.id] });
    await waitFor(async () => (await s.call('GET', `/sessions/${chat.id}`)).data.session.status === 'idle', 'reply');
    const d = (await s.call('GET', `/sessions/${chat.id}`)).data;
    expect(d.events.some((e: { body: { text?: string } }) => e.body.text?.includes('About SLD-1'))).toBe(true);
    expect((await s.call('GET', `/items/${item.id}/discuss`)).data.session_id).toBe(chat.id);
    expect((await s.call('POST', `/items/${item.id}/discuss`, { text: 'more' })).data.id).toBe(chat.id);
    expect((await s.call('GET', '/sessions')).data).toHaveLength(0);
    expect((await s.call('GET', `/items/${item.id}`)).data.sessions).toHaveLength(0);
    expect(s.ctx.store.countActive()).toBe(0);
    await expect(s.ctx.sessions.rpc(chat.id, 'add_comment', { key: 'SLD-1', body: 'x' })).rejects.toThrow(/read-only/);
    await expect(s.ctx.sessions.rpc(chat.id, 'get_item', { key: 'SLD-1' })).resolves.toMatchObject({ title: 'Charts overlap' });
    await s.call('POST', `/items/${item.id}/discuss/new`);
    expect((await s.call('GET', `/items/${item.id}/discuss`)).data.session_id).toBeNull();
  });
});
