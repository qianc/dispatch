import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Orchestration } from '../src/shared/types.ts';
import { as, startMultiUser } from './helpers.ts';
import { projects, setup, type Setup } from './orchestrator-helpers.ts';
import { renderPage, stubBrowser } from './web-render.ts';

// The model and effort of the orchestrator itself (not of its batches): picked at the start, with a
// default per person that new orchestrations begin with.
describe('orchestrator: its own model and effort', () => {
  let t: Setup;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => t.s.app.close());

  const post = (body: Record<string, unknown>) => t.s.call<Orchestration & { error?: string }>('POST', '/orchestrations', { goal: 'Rework auth', project_keys: ['AA'], ...body });
  const own = (id: number) => { const o = t.store.session(id)!.options; return { model: o.model, effort: o.effort }; };

  it('runs on the model and effort picked for it; its batches keep their own run options', async () => {
    const a = await t.item('AA', 'One');
    const made = (await post({ model: 'opus', effort: 'high', options: { model: 'sonnet' } })).data;
    expect(made).toMatchObject({ model: 'opus', effort: 'high', options: { model: 'sonnet', effort: 'default' } });
    expect(own(made.session_id)).toEqual({ model: 'opus', effort: 'high' });
    const spec = t.s.ctx.sessions.spec(t.store.session(made.session_id)!, '', null, null);
    expect(spec.options).toMatchObject({ model: 'opus', effort: 'high' });
    await t.rpc(made.session_id, 'set_plan', { plan_md: '', steps: [{ title: 'In AA', project_key: 'AA', item_keys: [a.key] }] });
    t.s.ctx.orchestrator.approve(made.session_id);
    const [step] = t.s.ctx.orchestrator.view(made.session_id).steps;
    const child = t.store.session(await t.startStep(made.session_id, step.id))!;
    expect(child.options).toMatchObject({ model: 'sonnet', effort: 'default' });
    expect((await post({ model: 'gpt' })).status).toBe(400);
  });

  it('with nothing picked it uses your default, which starts as the worker\'s own', async () => {
    expect((await t.s.call('GET', '/settings/orchestrator')).data).toEqual({ model: 'default', effort: 'default' });
    expect(own((await post({})).data.session_id)).toEqual({ model: 'default', effort: 'default' });
    const saved = await t.s.call('PUT', '/settings/orchestrator', { model: 'sonnet', effort: 'medium' });
    expect(saved.status).toBe(200);
    expect(saved.data).toEqual({ model: 'sonnet', effort: 'medium' });
    expect((await t.s.call('GET', '/settings/orchestrator')).data).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(own((await post({})).data.session_id)).toEqual({ model: 'sonnet', effort: 'medium' });
    // what is picked at the start goes before the default, each on its own
    expect(own((await post({ model: 'haiku' })).data.session_id)).toEqual({ model: 'haiku', effort: 'medium' });
    expect((await t.s.call('PUT', '/settings/orchestrator', { model: 'gpt', effort: 'medium' })).status).toBe(400);
    // one value alone keeps the other
    expect((await t.s.call('PUT', '/settings/orchestrator', { effort: 'low' })).data).toEqual({ model: 'sonnet', effort: 'low' });
  });
});

describe('orchestrator defaults: several people', () => {
  it('each person has their own default', async () => {
    const s = await startMultiUser();
    try {
      await projects(s, as('alice'));
      await s.call('PUT', '/settings/orchestrator', { model: 'haiku', effort: 'low' }, as('bob'));
      expect((await s.call('GET', '/settings/orchestrator', undefined, as('alice'))).data).toEqual({ model: 'default', effort: 'default' });
      expect((await s.call('GET', '/settings/orchestrator', undefined, as('bob'))).data).toEqual({ model: 'haiku', effort: 'low' });
      const made = (await s.call<Orchestration>('POST', '/orchestrations', { goal: 'x', project_keys: ['AA'] }, as('alice'))).data;
      expect(made).toMatchObject({ model: 'default', effort: 'default' });
    } finally {
      await s.app.close();
    }
  });
});

describe('orchestrator model: the app', () => {
  let ui: typeof import('../web/src/components/orchestration.tsx');
  beforeEach(async () => {
    vi.resetModules();
    stubBrowser();
    ui = await import('../web/src/components/orchestration.tsx');
  });
  afterEach(() => vi.unstubAllGlobals());

  /** the labels of the options that are picked, in the order they are on the page */
  const picked = (html: string) => [...html.matchAll(/<button[^>]*aria-checked="true"[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());

  it('the start sheet has a picker for the orchestrator itself, filled with your default', () => {
    const qc = new QueryClient();
    qc.setQueryData(['projects'], []);
    qc.setQueryData(['settings', 'orchestrator'], { model: 'sonnet', effort: 'high' });
    const html = renderPage(createElement(ui.NewOrchestrationForm, { onDone: () => {} }), { qc });
    expect(html).toContain('The orchestrator itself');
    expect(picked(html).slice(0, 2)).toEqual(['Sonnet', 'High']);
    // before the default has loaded: the worker's own
    const empty = new QueryClient();
    empty.setQueryData(['projects'], []);
    expect(picked(renderPage(createElement(ui.NewOrchestrationForm, { onDone: () => {} }), { qc: empty })).slice(0, 2)).toEqual(['Default', 'Default']);
  });

  it('Settings shows the default for new orchestrations', () => {
    const qc = new QueryClient();
    qc.setQueryData(['settings', 'orchestrator'], { model: 'opus', effort: 'default' });
    const html = renderPage(createElement(ui.OrchestratorDefaults), { qc });
    expect(html).toContain('New orchestrations start with this');
    expect(picked(html)).toEqual(['Opus', 'Default']);
  });
});
