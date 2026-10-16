import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './helpers.ts';

describe('Discuss suggests item changes; the owner applies them', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'DU', name: 'Discuss updates', effort_scale: ['XS', 'S', 'M'] });
  });
  afterAll(() => s.app.close());

  const setup = async () => {
    const it = (await s.call('POST', '/projects/DU/items', { title: 'Voice rules', importance: 2, labels: ['voice'] })).data;
    const chat = s.ctx.store.createSession({ project_id: it.project_id, kind: 'discuss', title: 'd', status: 'running', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [it.id] });
    const card = async () => {
      const ev = (await s.call('GET', `/sessions/${chat.id}`)).data.events as { id: number; body: { kind: string; proposal?: unknown; event_id?: number; note?: string } }[];
      return { proposal: ev.filter((e) => e.body.kind === 'proposal').at(-1)!, done: ev.filter((e) => e.body.kind === 'proposal_done') };
    };
    return { it, chat, card };
  };

  it('shows the change with the old values, and changes nothing until applied', async () => {
    const { it, chat, card } = await setup();
    await s.ctx.sessions.rpc(chat.id, 'propose', { type: 'item_update', key: it.key, importance: 'High', effort: 'M', tags: ['voice', 'design'], title: 'Voice rules', comment: 'Design note', reason: 'what we found' });
    const { proposal } = await card();
    expect(proposal.body.proposal).toMatchObject({
      type: 'item_update', item_key: it.key,
      changes: { importance: 3, effort: 2, labels: ['voice', 'design'] }, // the unchanged title is left out
      before: { importance: 2, effort: null, labels: ['voice'] },
      comment: 'Design note', reason: 'what we found',
    });
    expect((await s.call('GET', `/items/${it.id}`)).data).toMatchObject({ importance: 2, labels: ['voice'], comments: [] });
    expect(s.ctx.notifier.sent.filter((n) => n.title.includes('proposal'))).toHaveLength(0); // the owner is in the chat

    const applied = await s.call('POST', `/sessions/${chat.id}/apply-update`, { event_id: proposal.id });
    expect(applied.data).toMatchObject({ importance: 3, effort: 2, labels: ['voice', 'design'] });
    const item = (await s.call('GET', `/items/${it.id}`)).data;
    expect(item.comments).toEqual([expect.objectContaining({ author: 'claude', body_md: 'Design note' })]);
    expect((await card()).done.at(-1)!.body.note).toBe(`Applied to ${it.key}: 3 changes and a comment`);
    expect((await s.call('POST', `/sessions/${chat.id}/apply-update`, { event_id: proposal.id })).status).toBe(409); // once

    // agents see the comment: counted in list_items, and in the start data of a session on the item
    const listed = (await s.ctx.sessions.rpc(chat.id, 'list_items', {})) as { key: string; comments: number }[];
    expect(listed.find((x) => x.key === it.key)!.comments).toBe(1);
    const spec = s.ctx.sessions.spec(s.ctx.store.session(chat.id)!, 'x', null, null);
    expect(spec.items[0].comments).toEqual([expect.objectContaining({ author: 'claude', body_md: 'Design note' })]);
  });

  it('can be dismissed, and refuses what it cannot do', async () => {
    const { it, chat, card } = await setup();
    await s.ctx.sessions.rpc(chat.id, 'propose', { type: 'item_update', key: it.key, comment: 'Maybe' });
    const { proposal } = await card();
    await s.call('POST', `/sessions/${chat.id}/dismiss-proposal`, { event_id: proposal.id });
    expect((await s.call('GET', `/items/${it.id}`)).data.comments).toEqual([]);
    expect((await card()).done.at(-1)!.body.note).toBe('Dismissed');
    expect((await s.call('POST', `/sessions/${chat.id}/dismiss-proposal`, { event_id: 99999 })).status).toBe(404);

    await expect(s.ctx.sessions.rpc(chat.id, 'propose', { type: 'item_update', key: it.key, importance: 2 })).rejects.toThrow(/Nothing to change/);
    await expect(s.ctx.sessions.rpc(chat.id, 'propose', { type: 'item_update', key: it.key, effort: 'XXL' })).rejects.toThrow(/not on the project's scale/);
    await expect(s.ctx.sessions.rpc(chat.id, 'propose', { type: 'batch', title: 'x', item_ids: [it.id] })).rejects.toThrow(/only suggest item changes/);
    await expect(s.ctx.sessions.rpc(chat.id, 'add_comment', { key: it.key, body: 'direct' })).rejects.toThrow(/read-only/);
  });
});
