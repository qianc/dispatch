import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CrossProjectRequest } from '../src/shared/types.ts';
import { crossProjectTools } from '../src/worker/mcp.ts';
import { startServer, OWNER } from './helpers.ts';

// DISP-55: planner and discussion chats reach other projects, each request approved by the owner.
describe('Cross-project access from planner and discussion chats', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let workerId: number;
  beforeAll(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'PA', name: 'Project A' });
    await s.call('POST', '/projects', { key: 'PB', name: 'Project B' });
    await s.call('POST', '/projects/PB/items', { title: 'Login token expires early', body_md: 'The refresh token is dropped after a restart.', labels: ['auth'] });
    await s.call('POST', '/projects/PB/items', { title: 'Dark mode colours' });
    workerId = s.ctx.workers.legacy().id;
    s.ctx.hub.send = () => true; // the answer goes to a worker that is not there
  });
  afterAll(() => s.app.close());

  let n = 0;
  const chat = (kind: 'planner' | 'discuss' = 'planner', schedule_id: number | null = null) => {
    const pa = s.ctx.store.projectByKey('PA')!;
    return s.ctx.store.createSession({ started_by: OWNER, project_id: pa.id, kind, title: 'c', status: 'running', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [], worker_id: workerId, schedule_id });
  };
  /** what the worker does: ask the owner, who answers through the API */
  const ask = async (sessionId: number, req: CrossProjectRequest, approve: boolean | null) => {
    const local_id = `l${++n}`;
    s.ctx.sessions.onWorkerMessage(workerId, { t: 'input_request', session_id: sessionId, local_id, payload: { kind: 'cross_project', ...req, reason: 'to link them' } });
    const input = s.ctx.store.inputs(sessionId).find((i) => i.local_id === local_id)!;
    if (approve !== null) expect((await s.call('POST', `/inputs/${input.id}/answer`, { kind: 'cross_project', approve })).status).toBeLessThan(300);
    return { input, approval: local_id };
  };

  it('asks the owner with the exact request, and runs a search only once approved', async () => {
    const c = chat();
    const req: CrossProjectRequest = { action: 'search', project_key: 'PB', query: 'token' };
    const { approval, input } = await ask(c.id, req, null);
    expect(s.ctx.store.session(c.id)!.status).toBe('waiting_input');
    expect(s.ctx.notifier.sent.at(-1)).toMatchObject({ title: 'PA: approve access to PB?', body: 'Search PB for "token"' });
    await expect(s.ctx.sessions.rpc(c.id, 'cross_project', { ...req, approval })).rejects.toThrow(/did not approve/);

    await s.call('POST', `/inputs/${input.id}/answer`, { kind: 'cross_project', approve: true });
    const res = (await s.ctx.sessions.rpc(c.id, 'cross_project', { ...req, approval })) as { total: number; items: { key: string; excerpt: string }[] };
    expect(res.total).toBe(1);
    expect(res.items[0]).toMatchObject({ key: 'PB-1', title: 'Login token expires early', tags: ['auth'] });
    expect(res.items[0].excerpt).toContain('refresh token');
    // one approval, one run
    await expect(s.ctx.sessions.rpc(c.id, 'cross_project', { ...req, approval })).rejects.toThrow(/already used/);
  });

  it('does not run anything the owner denied, or anything other than what was approved', async () => {
    const c = chat('discuss');
    const denied = await ask(c.id, { action: 'read', project_key: 'PB', key: 'PB-1' }, false);
    await expect(s.ctx.sessions.rpc(c.id, 'cross_project', { action: 'read', project_key: 'PB', key: 'PB-1', approval: denied.approval })).rejects.toThrow(/did not approve/);

    const ok = await ask(c.id, { action: 'read', project_key: 'PB', key: 'PB-1' }, true);
    await expect(s.ctx.sessions.rpc(c.id, 'cross_project', { action: 'read', project_key: 'PB', key: 'PB-2', approval: ok.approval })).rejects.toThrow(/not the one the owner approved/);
    await expect(s.ctx.sessions.rpc(c.id, 'cross_project', { action: 'read', project_key: 'PB', key: 'PB-1' })).rejects.toThrow(/No approval/);
    const item = (await s.ctx.sessions.rpc(c.id, 'cross_project', { action: 'read', project_key: 'PB', key: 'PB-1', approval: ok.approval })) as { key: string; body_md: string };
    expect(item).toMatchObject({ key: 'PB-1', body_md: 'The refresh token is dropped after a restart.' });
  });

  it('writes a linking comment only after its own approval, with the approved text', async () => {
    const c = chat();
    const body = 'Related: PA-7 needs this fixed first.';
    const req: CrossProjectRequest = { action: 'comment', project_key: 'PB', key: 'PB-2', body };
    const pb2 = s.ctx.store.itemByNumber(s.ctx.store.projectByKey('PB')!.id, 2)!;
    // an approved read does not cover a write
    const read = await ask(c.id, { action: 'read', project_key: 'PB', key: 'PB-2' }, true);
    await expect(s.ctx.sessions.rpc(c.id, 'cross_project', { ...req, approval: read.approval })).rejects.toThrow(/not the one the owner approved/);
    const no = await ask(c.id, req, false);
    await expect(s.ctx.sessions.rpc(c.id, 'cross_project', { ...req, approval: no.approval })).rejects.toThrow(/did not approve/);
    expect(s.ctx.store.comments(pb2.id)).toEqual([]);

    const yes = await ask(c.id, req, true);
    await expect(s.ctx.sessions.rpc(c.id, 'cross_project', { ...req, body: 'something else', approval: yes.approval })).rejects.toThrow(/not the one/);
    await s.ctx.sessions.rpc(c.id, 'cross_project', { ...req, approval: yes.approval });
    expect(s.ctx.store.comments(pb2.id)).toEqual([expect.objectContaining({ author: 'claude', body_md: body, session_id: c.id })]);
  });

  it('is only for watched planner and discussion chats, and only for other projects', async () => {
    const own = chat();
    const r = await ask(own.id, { action: 'search', project_key: 'PA', query: 'x' }, true);
    await expect(s.ctx.sessions.rpc(own.id, 'cross_project', { action: 'search', project_key: 'PA', query: 'x', approval: r.approval })).rejects.toThrow(/own project/);

    const pa = s.ctx.store.projectByKey('PA')!;
    const work = s.ctx.store.createSession({ started_by: OWNER, project_id: pa.id, kind: 'work', title: 'w', status: 'running', force_plan: false, branch: 'b', initial_prompt: '', source_id: null, item_ids: [], worker_id: workerId });
    await expect(s.ctx.sessions.rpc(work.id, 'cross_project', { action: 'search', project_key: 'PB', query: 'x', approval: 'l1' })).rejects.toThrow(/Only planner and discussion/);
  });
});

describe('Cross-project tools in the worker', () => {
  const setup = (answer: { approved: boolean; local_id: string } | null) => {
    const calls: unknown[] = [];
    const asked: unknown[] = [];
    const tools = crossProjectTools(async (method, params) => { calls.push({ method, params }); return { ok: true }; }, 'PA', async (req) => { asked.push(req); return answer; });
    const run = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.handler(args, undefined) as Promise<{ content: { text: string }[]; isError?: boolean }>;
    return { calls, asked, run };
  };

  it('asks first, and on a denial tells the agent and calls nothing', async () => {
    const { calls, asked, run } = setup({ approved: false, local_id: 'x' });
    const res = await run('comment_on_other_item', { key: 'pb-3', body: 'Related: PA-1', reason: 'link' });
    expect(asked).toEqual([{ action: 'comment', project_key: 'PB', key: 'PB-3', body: 'Related: PA-1', reason: 'link' }]);
    expect(res.content[0].text).toMatch(/denied.*Nothing from project PB was read or written/);
    expect(calls).toEqual([]);
  });

  it('runs the approved request with its approval', async () => {
    const { calls, run } = setup({ approved: true, local_id: 'abc' });
    await run('search_other_project', { project_key: 'pb', query: ' token ', reason: 'r' });
    expect(calls).toEqual([{ method: 'cross_project', params: { action: 'search', project_key: 'PB', query: 'token', approval: 'abc' } }]);
  });

  it('does not ask for the chat\'s own project', async () => {
    const { asked, run } = setup({ approved: true, local_id: 'abc' });
    const res = await run('read_other_item', { key: 'PA-2', reason: 'r' });
    expect(res.isError).toBe(true);
    expect(asked).toEqual([]);
  });
});

describe('Own-project item tools', () => {
  it('refuse a key from another project instead of reading the same number here', async () => {
    const s = await startServer();
    await s.call('POST', '/projects', { key: 'QA', name: 'A' });
    await s.call('POST', '/projects', { key: 'QB', name: 'B' });
    const a1 = (await s.call('POST', '/projects/QA/items', { title: 'Here' })).data;
    await s.call('POST', '/projects/QB/items', { title: 'There' });
    const c = s.ctx.store.createSession({ started_by: OWNER, worker_id: s.ctx.store.defaultWorkerId(), project_id: a1.project_id, kind: 'planner', title: 'c', status: 'running', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [] });
    await expect(s.ctx.sessions.rpc(c.id, 'get_item', { key: 'QB-1' })).rejects.toThrow(/not in project QA.*read_other_item/);
    expect(await s.ctx.sessions.rpc(c.id, 'get_item', { key: 'QA-1' })).toMatchObject({ title: 'Here' });
    expect(await s.ctx.sessions.rpc(c.id, 'get_item', { key: '1' })).toMatchObject({ title: 'Here' });
    await s.app.close();
  });

  // DISP-133: a foreign key never changes the item with the same number here
  it('refuse a key from another project in update_item, add_to_batch, release_items and item_update proposals', async () => {
    const s = await startServer();
    await s.call('POST', '/projects', { key: 'QA', name: 'A' });
    await s.call('POST', '/projects', { key: 'QB', name: 'B' });
    const a1 = (await s.call('POST', '/projects/QA/items', { title: 'Here' })).data;
    s.ctx.store.updateProject(a1.project_id, { agents_edit_items: true });
    const b1 = (await s.call('POST', '/projects/QB/items', { title: 'There' })).data;
    s.ctx.store.updateItem(a1.id, { status: 'done' });
    s.ctx.store.updateItem(b1.id, { status: 'done' });
    const base = { started_by: OWNER, worker_id: s.ctx.store.defaultWorkerId(), project_id: a1.project_id, title: 'c', status: 'running' as const, force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [] };
    const work = s.ctx.store.createSession({ ...base, kind: 'work' });
    const release = s.ctx.store.createSession({ ...base, kind: 'release', release: { repo_id: 1, cap_repo: 'me/app', version: 'v1.0.0', label_prefix: 'rel:', command: '', notes: '', last_version: null } });
    const discuss = s.ctx.store.createSession({ ...base, kind: 'discuss' });
    const before = [s.ctx.store.item(a1.id), s.ctx.store.item(b1.id)];

    await expect(s.ctx.sessions.rpc(work.id, 'update_item', { key: 'QB-1', title: 'Rewritten' })).rejects.toThrow(/QB-1 is not in project QA/);
    await expect(s.ctx.sessions.rpc(work.id, 'add_to_batch', { keys: ['QB-1'] })).rejects.toThrow(/QB-1 is not in project QA/);
    await expect(s.ctx.sessions.rpc(release.id, 'release_items', { keys: ['QB-1'] })).rejects.toThrow(/QB-1 is not in project QA/);
    await expect(s.ctx.sessions.rpc(discuss.id, 'propose', { type: 'item_update', key: 'QB-1', title: 'Rewritten' })).rejects.toThrow(/QB-1 is not in project QA/);

    expect([s.ctx.store.item(a1.id), s.ctx.store.item(b1.id)]).toEqual(before);
    expect(s.ctx.store.session(work.id)!.item_ids).toEqual([]);
    expect(s.ctx.store.events(discuss.id).some((e) => e.body.kind === 'proposal')).toBe(false);
    await s.app.close();
  });
});
