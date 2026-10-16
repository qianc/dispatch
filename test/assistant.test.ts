import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRepo, suggestKey } from '../src/server/assistant.ts';
import { insideDirs } from '../src/worker/runner.ts';
import { startServer, startWorker, stopWorker, waitFor } from './helpers.ts';

describe('assistant helpers', () => {
  it('parses GitHub repo references', () => {
    for (const s of ['me/decks', 'https://github.com/me/decks', 'https://github.com/me/decks.git', 'git@github.com:me/decks.git', 'github.com/me/decks/']) {
      expect(parseRepo(s), s).toEqual({ owner: 'me', name: 'decks' });
    }
    expect(() => parseRepo('not a repo')).toThrow();
  });

  it('suggests free project keys', () => {
    expect(suggestKey('Decks', () => false)).toBe('DECKS');
    expect(suggestKey('Deck builder', () => false)).toBe('DB');
    expect(suggestKey('Decks', (k) => k === 'DECKS')).toBe('DECKS2');
    expect(suggestKey('3d printer', () => false)).toMatch(/^P/);
  });

  it('keeps reads inside the allowed folders, symlinks included', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsp-read-'));
    const allowed = join(root, 'allowed');
    mkdirSync(allowed);
    writeFileSync(join(allowed, 'retro.md'), 'x');
    writeFileSync(join(root, 'secret.txt'), 'x');
    symlinkSync(join(root, 'secret.txt'), join(allowed, 'link.txt'));
    expect(insideDirs(join(allowed, 'retro.md'), [allowed], '/')).toBe(true);
    expect(insideDirs(allowed, [allowed], '/')).toBe(true);
    expect(insideDirs(join(root, 'secret.txt'), [allowed], '/')).toBe(false);
    expect(insideDirs(join(allowed, '../secret.txt'), [allowed], '/')).toBe(false);
    expect(insideDirs(join(allowed, 'link.txt'), [allowed], '/')).toBe(false);
    expect(insideDirs(join(allowed, 'retro.md'), [], '/')).toBe(false);
  });
});

describe('assistant tools (server side)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let worker: ChildProcess;
  let chatId: number;
  const rpc = (method: string, params: unknown) => s.ctx.sessions.rpc(chatId, method, params);

  beforeAll(async () => {
    s = await startServer();
    worker = startWorker(s.port);
    await waitFor(() => s.ctx.hub.connected, 'worker');
    chatId = (await s.call('POST', '/assistant/messages', { text: 'hello' })).data.id;
  });
  afterAll(async () => {
    await stopWorker(worker);
    await s.app.close();
  });

  it('keeps one open thread and does not list it as agent work', async () => {
    await waitFor(async () => (await s.call('GET', `/sessions/${chatId}`)).data.session.status === 'idle', 'fake reply');
    expect((await s.call('GET', '/assistant')).data.session_id).toBe(chatId);
    expect((await s.call('POST', '/assistant/messages', { text: 'again' })).data.id).toBe(chatId);
    const listed = (await s.call('GET', '/sessions')).data as { id: number }[];
    expect(listed.map((x) => x.id)).not.toContain(chatId);
    expect(s.ctx.store.countActive()).toBe(0);
  });

  it('creates a project with a repo, then items with labels and a linked source', async () => {
    const p = (await rpc('create_project', { name: 'Decks', repos: ['https://github.com/me/decks'], effort_scale: ['1', '2', '3', '5', '8'] })) as { key: string; repos: string[]; added_repos: { verified_on_github: boolean }[] };
    expect(p.key).toBe('DECKS');
    expect(p.repos).toEqual(['me/decks (main)']); // no GitHub token in tests: unverified, main
    expect(p.added_repos[0].verified_on_github).toBe(false);
    const src = (await rpc('create_source', { project_key: 'DECKS', title: 'Retro', body_md: 'full text', reporter: 'alex', version_tag: 'v1' })) as { id: number };
    const items = (await rpc('create_items', {
      project_key: 'decks', source_id: src.id,
      items: [{ type: 'bug', title: 'Fonts', importance: 'High', effort: '5' }, { title: 'Export', importance: 4 }],
    })) as { key: string }[];
    expect(items.map((i) => i.key)).toEqual(['DECKS-1', 'DECKS-2']);
    const fonts = (await s.call('GET', '/items/by-key/DECKS-1')).data;
    expect(fonts).toMatchObject({ type: 'bug', importance: 3, effort: 3, source_id: src.id, status: 'triage' });
    await expect(rpc('create_items', { project_key: 'DECKS', items: [{ title: 'x', effort: 'XL' }] })).rejects.toThrow(/not one of 1, 2, 3, 5, 8/);
    await rpc('update_item', { key: 'DECKS-2', status: 'todo', effort: '8' });
    expect((await s.call('GET', '/items/by-key/DECKS-2')).data).toMatchObject({ status: 'todo', effort: 4 });
    expect(await rpc('add_repo', { project_key: 'DECKS', repo: 'me/decks' })).toMatch(/already/);
  });

  it('proposes sessions instead of starting them, and the card can be used once', async () => {
    await rpc('propose_session', { type: 'batch', project_key: 'DECKS', item_keys: ['DECKS-1'], prompt: 'go' });
    await rpc('propose_session', { type: 'planner', project_key: 'DECKS' });
    expect((await s.call('GET', '/sessions')).data).toHaveLength(0);
    const d = (await s.call('GET', `/sessions/${chatId}`)).data;
    const [batch, planner] = d.events.filter((e: { body: { kind: string } }) => e.body.kind === 'proposal');
    expect(batch.body.proposal).toMatchObject({ type: 'batch', project_key: 'DECKS' });
    expect(planner.body.proposal).toMatchObject({ type: 'planner', project_key: 'DECKS' });
    const ref = { session_id: chatId, event_id: planner.id };
    expect((await s.call('POST', '/projects/DECKS/planner', { proposal: ref })).status).toBe(200);
    expect((await s.call('POST', '/projects/DECKS/planner', { proposal: ref })).status).toBe(409);
  });

  it('starts a fresh thread on New chat', async () => {
    await s.call('POST', '/assistant/new');
    expect((await s.call('GET', '/assistant')).data.session_id).toBeNull();
    const next = (await s.call('POST', '/assistant/messages', { text: 'create project Notes me/notes' })).data;
    expect(next.id).not.toBe(chatId);
    await waitFor(async () => (await s.call('GET', '/projects/NOTES')).status === 200, 'fake assistant created NOTES');
  });
});

describe('import_sections', () => {
  it('creates items with full text, detected scales and a linked source', async () => {
    const s = await startServer();
    await s.call('POST', '/projects', { key: 'SLD', name: 'slides', importance_scale: ['S1 a', 'S2 b', 'S3 c', 'New capability'], effort_scale: ['XS', 'S', 'M', 'L'] });
    const chat = s.ctx.store.createSession({ project_id: null, kind: 'assistant', title: 'A', status: 'idle', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [] });
    const res = (await s.ctx.sessions.rpc(chat.id, 'import_sections', {
      project_key: 'SLD',
      source: { title: 'backlog.md', body_md: 'whole file' },
      sections: [
        { title: 'X1 — One', body: '**S2** · **L**\n\nLong description.', ancestors: ['Open work'] },
        { title: 'X2 — Two', body: 'no labels', ancestors: ['Open work'] },
      ],
    })) as { created: number; source: { id: number }; importance_not_found_defaulted_to?: string };
    expect(res.created).toBe(2);
    expect(res.importance_not_found_defaulted_to).toMatch(/1 items/);
    const x1 = (await s.call('GET', '/items/by-key/SLD-1')).data;
    expect(x1).toMatchObject({ title: 'X1 — One', importance: 2, effort: 3, source_id: res.source.id });
    expect(x1.body_md).toContain('Long description.');
    expect((await s.call('GET', `/sources/${res.source.id}`)).data.body_md).toBe('whole file');
    const again = (await s.ctx.sessions.rpc(chat.id, 'import_sections', {
      project_key: 'SLD', source: { title: 'backlog.md', body_md: 'whole file' }, sections: [{ title: 'X3', body: '', ancestors: [] }],
    })) as { source: { id: number } };
    expect(again.source.id).toBe(res.source.id);
    await s.app.close();
  });
});

describe('Discuss: a path the owner gives relative to an extra folder', () => {
  it('finds the file under the extra folder when the checkout does not have it, and never outside it', async () => {
    const { rescuePath } = await import('../src/worker/runner.ts');
    const { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'dsp-rescue-'));
    const checkout = join(root, 'session', 'tpl');
    const repo = join(root, 'tpl');
    const extra = join(repo, 'reference-decks', 'library-work');
    mkdirSync(checkout, { recursive: true });
    mkdirSync(join(extra, 'cvdd', 'renders'), { recursive: true });
    writeFileSync(join(extra, 'cvdd', 'renders', 'entry-20.png'), 'png');
    writeFileSync(join(checkout, 'in-git.md'), 'x');
    writeFileSync(join(repo, 'secret.txt'), 'outside the extra folder');
    const want = join(extra, 'cvdd', 'renders', 'entry-20.png');

    // relative to the extra folder, as the owner says it; or as the model makes it absolute in its checkout
    expect(rescuePath('cvdd/renders/entry-20.png', checkout, [extra])).toBe(want);
    expect(rescuePath(join(checkout, 'cvdd/renders/entry-20.png'), checkout, [extra])).toBe(want);
    // relative to the repo root
    expect(rescuePath('reference-decks/library-work/cvdd/renders/entry-20.png', checkout, [extra])).toBe(want);
    // a file that is in the checkout is left alone; nothing found → null
    expect(rescuePath('in-git.md', checkout, [extra])).toBeNull();
    expect(rescuePath('cvdd/renders/entry-99.png', checkout, [extra])).toBeNull();
    // never a file outside the extra folder, even one level up in the same repo
    expect(rescuePath('secret.txt', checkout, [extra])).toBeNull();
    expect(rescuePath('../secret.txt', checkout, [extra])).toBeNull();
    symlinkSync(join(repo, 'secret.txt'), join(extra, 'link.txt'));
    expect(rescuePath('link.txt', checkout, [extra])).toBeNull();
    expect(rescuePath('cvdd/renders/entry-20.png', checkout, [])).toBeNull();
  });
});
