// DISP-236: a batch form sends a worker the caller owns, or none so the server's workerFor chooses.
import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Me, Repo } from '../web/src/api.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

beforeAll(stubBrowser);
const { chosenWorker, localWorkers, ownWorkers, pickWorker, useChosenWorker, WorkerField } = await import('../web/src/components/batch.tsx');

const w = (id: number, name: string, owner: string, connected = true) => ({ id, name, owner, connected });
// the owner's two workers and Bob's one; /api/workers lists all three for the owner
const OWNERS = [w(1, 'nas', 'owner'), w(2, 'laptop', 'owner', false), w(3, 'bobpc', 'bob')];
const me = (user: string | null, install_owner: string | null = 'owner') => ({ user, install_owner }) as Pick<Me, 'user' | 'install_owner'>;
const local = (placements: { worker_id: number; status: string }[]) => ({ kind: 'local', placements }) as unknown as Repo;
const remote = { kind: 'github' } as unknown as Repo;

describe('ownWorkers', () => {
  it('keeps only the caller’s workers', () => {
    expect(ownWorkers(OWNERS, me('owner')).map((x) => x.id)).toEqual([1, 2]);
    expect(ownWorkers(OWNERS, me('bob')).map((x) => x.id)).toEqual([3]);
  });
  it('without a signed-in user, the install owner’s; with neither known, all', () => {
    expect(ownWorkers(OWNERS, me(null)).map((x) => x.id)).toEqual([1, 2]);
    expect(ownWorkers(OWNERS, me(null, null))).toHaveLength(3);
  });
});

describe('localWorkers', () => {
  it('is null without local repos: any worker can run the project', () => {
    expect(localWorkers(undefined)).toBeNull();
    expect(localWorkers([remote])).toBeNull();
  });
  it('lists the workers with an ok copy of every local repo', () => {
    const a = local([{ worker_id: 1, status: 'ok' }, { worker_id: 2, status: 'ok' }, { worker_id: 3, status: 'ok' }]);
    const b = local([{ worker_id: 1, status: 'ok' }, { worker_id: 2, status: 'missing' }, { worker_id: 3, status: 'ok' }]);
    expect(localWorkers([a, b, remote])).toEqual([1, 3]);
    expect(localWorkers([b, local([])])).toEqual([]);
  });
});

describe('pickWorker', () => {
  const mine = OWNERS.filter((x) => x.owner === 'bob');
  it('skips a preferred worker that is not the caller’s', () => {
    expect(pickWorker(null, [1, 3], mine)).toBe(3);
    expect(pickWorker([1, 3], [1], mine)).toBe(3);
  });
  it('takes the first preferred one that can run the project, offline too', () => {
    const own = OWNERS.slice(0, 2);
    expect(pickWorker(null, [2, 1], own)).toBe(2);
    expect(pickWorker([1, 2], [undefined, null, 2], own)).toBe(2);
  });
  it('else a connected one that can, else any that can, else none', () => {
    const own = OWNERS.slice(0, 2);
    expect(pickWorker([1, 2], [], own)).toBe(1);
    expect(pickWorker([2], [], own)).toBe(2);
    expect(pickWorker([3], [3], own)).toBeNull();
  });
});

describe('chosenWorker', () => {
  const bobs = ownWorkers(OWNERS, me('bob'));
  const owners = ownWorkers(OWNERS, me('owner'));
  it('without local repos and nothing picked, sends none, even when the project default is someone else’s', () => {
    expect(chosenWorker({ worker_id: 1, repos: [remote] }, bobs, 3, null)).toBeNull();
    expect(chosenWorker({ worker_id: 1 }, owners, 1, null)).toBeNull();
  });
  it('sends the worker picked', () => {
    expect(chosenWorker({ worker_id: 1 }, owners, 1, 2)).toBe(2);
  });
  it('sends the planner’s worker, offline too, if it is the caller’s', () => {
    expect(chosenWorker({ worker_id: 1 }, owners, 1, null, 'laptop')).toBe(2);
    expect(chosenWorker({ worker_id: null }, bobs, 3, null, 'nas')).toBeNull();
  });
  it('with local repos, the caller’s worker that has them, never someone else’s', () => {
    const repos = [local([{ worker_id: 1, status: 'ok' }, { worker_id: 3, status: 'ok' }])];
    expect(chosenWorker({ worker_id: 1, repos }, bobs, 3, null)).toBe(3);
    expect(chosenWorker({ worker_id: 1, repos }, owners, 1, null)).toBe(1);
    expect(chosenWorker({ worker_id: 3, repos: [local([{ worker_id: 3, status: 'ok' }])] }, owners, 1, null)).toBeNull();
  });
});

/** Renders a form's worker hook and field with this /api/workers and /api/me. */
function render(user: string, project: { worker_id: number | null; repos?: Repo[] }, proposed?: { name?: string }) {
  const qc = new QueryClient();
  qc.setQueryData(['workers'], { workers: OWNERS, default_worker_id: user === 'bob' ? 3 : 1 });
  qc.setQueryData(['me'], { authed: true, user, install_owner: 'owner' });
  function Form() {
    const [id] = useChosenWorker(project, proposed?.name);
    return createElement('div', null, createElement('output', null, `sends ${id ?? 'none'}`), createElement(WorkerField, { value: null, onChange: () => {}, project, proposed }));
  }
  return renderPage(createElement(Form), { qc });
}

describe('useChosenWorker and WorkerField', () => {
  it('Bob, with one worker, on a project whose default is the owner’s: sends none and shows no field', () => {
    const html = render('bob', { worker_id: 1 });
    expect(textOf(html)).toBe('sends none');
  });
  it('the owner’s field lists only their own workers, and shows the one the server picks', () => {
    const html = render('owner', { worker_id: 2 });
    expect(textOf(html)).toContain('sends none');
    expect(html).toContain('>nas</option>');
    expect(html).toContain('>laptop (offline)</option>');
    expect(html).not.toContain('bobpc');
    expect(html).toContain('<option value="2" selected="">');
  });
  it('an offline worker the planner proposed is sent and shown as waiting', () => {
    const html = render('owner', { worker_id: 1 }, { name: 'laptop' });
    expect(textOf(html)).toContain('sends 2');
    expect(textOf(html)).toContain('laptop is offline');
  });
  it('a project with local repos sends the caller’s worker that has them', () => {
    const repos = [local([{ worker_id: 2, status: 'ok' }, { worker_id: 3, status: 'ok' }])];
    expect(textOf(render('owner', { worker_id: 3, repos }))).toContain('sends 2');
    expect(textOf(render('bob', { worker_id: 2, repos }))).toBe('sends 3');
  });
});
