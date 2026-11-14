import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Orchestration, Proposal, Session } from '../src/shared/types.ts';
import { OWNER } from './helpers.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

// The Assistant proposes an orchestration as a card; the owner starts it. It starts none itself.
describe('assistant: propose an orchestration', () => {
  let t: Setup;
  let chat: number;
  beforeEach(async () => {
    t = await setup();
    chat = t.s.ctx.sessions.assistantSend(OWNER, 'Rework auth in AA and BB').id;
  });
  afterEach(() => t.s.app.close());

  const propose = (params: Record<string, unknown>) => t.rpc(chat, 'propose_session', { type: 'orchestration', ...params });
  const cards = () => t.store.events(chat).flatMap((e) => (e.body.kind === 'proposal' ? [{ id: e.id, proposal: e.body.proposal }] : []));
  const done = () => t.store.events(chat).flatMap((e) => (e.body.kind === 'proposal_done' ? [e.body.note] : []));
  const start = (eventId: number, extra: Record<string, unknown> = {}) =>
    t.s.call<Orchestration & { error?: string }>('POST', '/orchestrations', { goal: 'Rework auth', project_keys: ['AA', 'BB'], proposal: { session_id: chat, event_id: eventId }, ...extra });

  it('shows a card with the goal and the projects, and starts nothing', async () => {
    await propose({ goal: 'Move sign-in to the new tokens.\nIn both apps.', project_keys: ['aa', 'BB'] });
    expect(cards().map((c) => c.proposal)).toEqual([{ type: 'orchestration', title: 'Move sign-in to the new tokens.', goal: 'Move sign-in to the new tokens.\nIn both apps.', project_keys: ['AA', 'BB'] }]);
    expect(t.store.orchestrations()).toEqual([]);
    await expect(propose({ goal: '', project_keys: ['AA'] })).rejects.toThrow('Give the goal.');
    await expect(propose({ goal: 'x', project_keys: [] })).rejects.toThrow('Give project_keys: the projects it may work in.');
    await expect(propose({ goal: 'x', project_keys: ['NOPE'] })).rejects.toThrow(/NOPE/);
    await t.s.call('POST', '/projects/BB/disable');
    await expect(propose({ goal: 'x', project_keys: ['AA', 'BB'] })).rejects.toThrow(/Project BB is disabled/);
    expect(cards()).toHaveLength(1);
  });

  it('the card starts one orchestration, once', async () => {
    await propose({ goal: 'Rework auth', project_keys: ['AA', 'BB'], title: 'Auth rework' });
    const [card] = cards();
    const first = await start(card.id);
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ phase: 'plan', project_keys: ['AA', 'BB'] });
    expect(done()).toEqual([`Started orchestration #${first.data.session_id}`]);
    const again = await start(card.id);
    expect(again.status).toBe(409);
    expect(again.data.error).toBe('This proposal was already used.');
    expect(t.store.orchestrations()).toHaveLength(1);
  });

  it('a project disabled since the card was made: refused, and the card stays', async () => {
    await propose({ goal: 'Rework auth', project_keys: ['AA', 'BB'] });
    await t.s.call('POST', '/projects/BB/disable');
    const res = await start(cards()[0].id);
    expect(res.data.error).toMatch(/Project BB is disabled/);
    expect(done()).toEqual([]);
    expect(t.store.orchestrations()).toEqual([]);
  });
});

describe('the orchestration card in the Assistant chat', () => {
  let Card: typeof import('../web/src/components/transcript.tsx').OrchestrationProposalCard;
  beforeEach(async () => {
    vi.resetModules();
    stubBrowser();
    ({ OrchestrationProposalCard: Card } = await import('../web/src/components/transcript.tsx'));
  });
  afterEach(() => vi.unstubAllGlobals());

  const proposal: Extract<Proposal, { type: 'orchestration' }> = { type: 'orchestration', title: 'Auth rework', goal: 'Move sign-in to the new tokens.', project_keys: ['AA', 'BB'] };
  const render = (props: { done: string | null; readOnly: boolean }) =>
    textOf(renderPage(createElement(Card, { eventId: 3, proposal, session: { id: 9 } as Session, ...props }), { qc: new QueryClient() }));

  it('shows the goal and projects with Start; a used card says what happened', () => {
    const open = render({ done: null, readOnly: false });
    expect(open).toContain('Orchestration');
    expect(open).toContain('Move sign-in to the new tokens.');
    expect(open).toMatch(/AA.*BB/);
    expect(open).toContain('Start orchestration');
    const used = render({ done: 'Started orchestration #12', readOnly: false });
    expect(used).toContain('Started orchestration #12');
    expect(used).not.toContain('Start orchestration');
    expect(render({ done: null, readOnly: true })).not.toContain('Start orchestration');
  });
});
