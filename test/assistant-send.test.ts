import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionEvent } from '../src/shared/types.ts';
import { startServer } from './helpers.ts';

// No worker: the Assistant chat waits in the queue, as it does while its worker is away.
describe('sending to the Assistant (DISP-83, DISP-82)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    s = await startServer({ DATA_DIR: mkdtempSync(`${tmpdir()}/dsp-asend-`) });
    await s.call('POST', '/projects', { key: 'HC', name: 'Home cache' });
    await s.call('POST', '/projects', { key: 'DECK', name: 'Decks' });
  });
  afterAll(() => s.app.close());

  const userEvents = (id: number) => s.ctx.store.events(id).filter((e: SessionEvent) => e.body.kind === 'user').map((e) => e.body);
  const send = (body: Record<string, unknown>) => s.call('POST', '/assistant/messages', body);

  it('stores a message once when it is retried with the same client id', async () => {
    const first = await send({ text: 'Hello', client_id: 'c-1' });
    expect(first.status).toBe(200);
    // the answer was lost on the way: the web app sends it again, with the same id
    const again = await send({ text: 'Hello', client_id: 'c-1' });
    expect(again.status).toBe(200);
    expect(again.data.id).toBe(first.data.id);
    expect(userEvents(first.data.id)).toEqual([{ kind: 'user', text: 'Hello', client_id: 'c-1' }]);
  });

  it('keeps a second message sent before the chat has started', async () => {
    const id = (await s.call('GET', '/assistant')).data.session_id;
    expect(s.ctx.store.session(id)!.status).toBe('queued');
    expect((await send({ text: 'And this', client_id: 'c-2' })).status).toBe(200);
    expect((await send({ text: 'And this', client_id: 'c-2' })).status).toBe(200);
    expect(userEvents(id).map((b) => b.kind === 'user' && b.text)).toEqual(['Hello', 'And this']);
    // the chat's first turn has both messages
    expect(s.ctx.store.session(id)!.pending_prompt).toBe('Hello\n\nAnd this');
  });

  it('tells the Assistant which projects were tagged, and keeps the text as written', async () => {
    await s.call('POST', '/assistant/new');
    const r = await send({ text: 'Add a bug to @HC and @DECK', client_id: 'c-3', project_keys: ['HC', 'DECK', 'NOPE'] });
    expect(r.status).toBe(200);
    expect(userEvents(r.data.id)).toEqual([{ kind: 'user', text: 'Add a bug to @HC and @DECK', client_id: 'c-3', project_keys: ['HC', 'DECK'] }]);
    expect(s.ctx.store.session(r.data.id)!.initial_prompt).toBe('Add a bug to @HC and @DECK\n\nTagged projects: HC (Home cache), DECK (Decks)');
    // later messages in the chat too
    await send({ text: 'Also @HC', client_id: 'c-4', project_keys: ['HC'] });
    expect(s.ctx.store.session(r.data.id)!.pending_prompt).toMatch(/Also @HC\n\nTagged projects: HC \(Home cache\)$/);
  });

  it('a message with no tags has no tag line', async () => {
    await s.call('POST', '/assistant/new');
    const r = await send({ text: 'mail me@HC', project_keys: [] });
    expect(s.ctx.store.session(r.data.id)!.initial_prompt).toBe('mail me@HC');
    expect(userEvents(r.data.id)).toEqual([{ kind: 'user', text: 'mail me@HC' }]);
  });
});
