import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCOPES } from '../src/server/access.ts';
import { trackerTools } from '../src/server/mcp.ts';
import { PROJECT_WRITES } from '../src/server/projectLock.ts';
import type { WorkerLink } from '../src/server/workerHub.ts';
import { startServer, OWNER } from './helpers.ts';

const LOCKED = 'Project LK is disabled (read-only). The owner can enable it in Dispatch.';

// DISP-59: a disabled project is read-only, its schedules are paused, and its queued sessions wait.
describe('disabling a project', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'LK', name: 'Locked' });
    await s.call('POST', '/projects/LK/repos', { github_owner: 'me', github_name: 'lk' });
  });
  afterEach(() => s.app.close());

  const disable = () => s.call('POST', '/projects/LK/disable');
  const enable = () => s.call('POST', '/projects/LK/enable');
  const refused = (r: { status: number; data: { error?: string } }) => {
    expect(r.status).toBe(423);
    expect(r.data.error).toBe(LOCKED);
  };
  /** the tracker MCP (/mcp) as a client with read and tracker scopes */
  const mcp = async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = trackerTools(s.ctx.store, s.ctx.bus, null, { kind: 'oauth', name: 'test', scopes: new Set(SCOPES), local: true, user: OWNER });
    await server.connect(a);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    return async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { error: !!r.isError, text: r.content[0].text };
    };
  };

  it('every write route says how it finds its project', () => {
    const writes = s.routes.filter((r) => / \/api\//.test(r) && !/^(GET|HEAD|OPTIONS) /.test(r));
    expect(writes.length).toBeGreaterThan(40);
    expect(writes.filter((r) => !(r in PROJECT_WRITES))).toEqual([]);
  });

  it('records who disabled it and when, and shows it on the project', async () => {
    const off = (await disable()).data;
    expect(off).toMatchObject({ key: 'LK', disabled: true });
    expect(off.disabled_by).toBeTruthy();
    expect(Date.parse(off.disabled_at)).toBeGreaterThan(Date.now() - 60_000);
    expect((await s.call('GET', '/projects/LK')).data).toMatchObject({ disabled: true, disabled_by: off.disabled_by });
    expect((await s.call('GET', '/projects')).data[0]).toMatchObject({ key: 'LK', disabled: true });
    expect((await enable()).data).toMatchObject({ disabled: false, disabled_at: null, disabled_by: null });
  });

  it('refuses every write over HTTP, with the reason; reads still work', async () => {
    const item = (await s.call('POST', '/projects/LK/items', { title: 'Before' })).data;
    const source = (await s.call('POST', '/projects/LK/sources', { kind: 'manual', title: 'Retro', body_md: 'x' })).data;
    const sched = (await s.call('POST', '/projects/LK/schedules', { name: 'Nightly', at_time: '02:00' })).data;
    const planner = (await s.call('POST', '/projects/LK/planner', { prompt: 'plan', source_id: null })).data;
    const repo = (await s.call('GET', '/projects/LK')).data.repos[0];
    await disable();

    // items
    refused(await s.call('POST', '/projects/LK/items', { title: 'New' }));
    refused(await s.call('PATCH', `/items/${item.id}`, { title: 'Changed' }));
    refused(await s.call('POST', `/items/${item.id}/comments`, { body_md: 'hi' }));
    refused(await s.call('DELETE', `/items/${item.id}`));
    // sources
    refused(await s.call('POST', '/projects/LK/sources', { kind: 'manual', title: 'Another', body_md: '' }));
    refused(await s.call('PATCH', `/sources/${source.id}`, { title: 'Changed' }));
    refused(await s.call('POST', `/sources/${source.id}/items`, { items: [{ type: 'bug', title: 'x', body_md: '', importance: 2, effort: null }] }));
    // sessions
    refused(await s.call('POST', '/projects/LK/batches', { item_ids: [item.id], new_items: [], prompt: '' }));
    refused(await s.call('POST', '/projects/LK/planner', { prompt: 'plan', source_id: null }));
    refused(await s.call('POST', `/items/${item.id}/discuss`, { text: 'why?' }));
    refused(await s.call('POST', `/sessions/${planner.id}/pause`));
    refused(await s.call('POST', `/sessions/${planner.id}/accept-items`, { items: [{ type: 'bug', title: 'x', body_md: '', importance: 2, effort: null }] }));
    // schedules
    refused(await s.call('POST', '/projects/LK/schedules', { name: 'Another', at_time: '03:00' }));
    refused(await s.call('PATCH', `/schedules/${sched.id}`, { enabled: true }));
    refused(await s.call('POST', `/schedules/${sched.id}/run`));
    refused(await s.call('DELETE', `/schedules/${sched.id}`));
    // repos and project settings
    refused(await s.call('POST', '/projects/LK/repos', { github_owner: 'me', github_name: 'other' }));
    refused(await s.call('PATCH', `/repos/${repo.id}`, { check_command: 'npm test' }));
    refused(await s.call('DELETE', `/repos/${repo.id}`));
    refused(await s.call('PATCH', '/projects/LK', { name: 'Renamed' }));

    // nothing changed
    expect(s.ctx.store.items(s.ctx.store.projectByKey('LK')!.id)).toHaveLength(1);
    expect(s.ctx.store.item(item.id)!.title).toBe('Before');
    expect(s.ctx.store.source(source.id)!.title).toBe('Retro');
    expect(s.ctx.store.repos(s.ctx.store.projectByKey('LK')!.id)).toHaveLength(1);
    expect(s.ctx.store.schedules()).toHaveLength(1);

    // reads still work
    expect((await s.call('GET', '/projects/LK/items')).data).toHaveLength(1);
    expect((await s.call('GET', `/items/${item.id}`)).data).toMatchObject({ title: 'Before' });
    expect((await s.call('GET', '/projects/LK/sources')).data).toHaveLength(1);
    expect((await s.call('GET', `/sources/${source.id}`)).status).toBe(200);
    expect((await s.call('GET', '/projects/LK/schedules')).data).toHaveLength(1);
    expect((await s.call('GET', `/sessions/${planner.id}`)).status).toBe(200);
    expect((await s.call('GET', '/sessions?project=LK')).data).toHaveLength(1);
    // muting is not a change to the project, and the owner can still stop a session
    expect((await s.call('PATCH', '/projects/LK', { muted: true })).data).toMatchObject({ muted: true });
    expect((await s.call('POST', `/sessions/${planner.id}/finish`, { status: 'stopped' })).data).toMatchObject({ status: 'stopped' });

    // enabled: writes go through again
    await enable();
    expect((await s.call('POST', '/projects/LK/items', { title: 'New' })).status).toBe(200);
    expect((await s.call('PATCH', `/items/${item.id}`, { title: 'Changed' })).data).toMatchObject({ title: 'Changed' });
    expect((await s.call('PATCH', `/sources/${source.id}`, { title: 'Changed' })).status).toBe(200);
    expect((await s.call('PATCH', `/repos/${repo.id}`, { check_command: 'npm test' })).status).toBe(200);
    expect((await s.call('DELETE', `/schedules/${sched.id}`)).status).toBe(200);
  });

  it('refuses writes through the tracker MCP tools and the agents\' tools; reads still work', async () => {
    const item = (await s.call('POST', '/projects/LK/items', { title: 'Before' })).data;
    const planner = (await s.call('POST', '/projects/LK/planner', { prompt: 'plan', source_id: null })).data;
    const tool = await mcp();
    await disable();

    for (const [name, args] of [
      ['add_item', { project: 'LK', title: 'New' }],
      ['update_item', { key: item.key, title: 'Changed' }],
      ['add_comment', { key: item.key, text: 'hi' }],
      ['add_source', { project: 'LK', title: 'Retro' }],
      ['release_items', { project: 'LK', version: '1.0.0', keys: [item.key] }],
    ] as const) {
      expect(await tool(name, args), name).toEqual({ error: true, text: `Error: ${LOCKED}` });
    }
    expect((await tool('list_items', { project: 'LK' })).error).toBe(false);
    expect(JSON.parse((await tool('get_item', { key: item.key })).text)).toMatchObject({ title: 'Before' });

    // the dispatch MCP tools of an agent on the project (src/worker/mcp.ts → rpc)
    const rpc = (method: string, params: object) => s.ctx.sessions.rpc(planner.id, method, params);
    await expect(rpc('create_item', { type: 'bug', title: 'x', body_md: '', importance: 2, effort: null })).rejects.toThrow(LOCKED);
    await expect(rpc('add_comment', { key: item.key, body: 'hi' })).rejects.toThrow(LOCKED);
    await expect(rpc('propose', { type: 'items', items: [{ type: 'bug', title: 'x', body_md: '', importance: 2, effort: null }] })).rejects.toThrow(LOCKED);
    expect(await rpc('list_items', {})).toHaveLength(1);
    expect(await rpc('get_item', { key: item.key })).toMatchObject({ title: 'Before' });

    // the assistant's tools, for this project
    const assistant = s.ctx.store.createSession({ started_by: OWNER, worker_id: s.ctx.store.defaultWorkerId(), project_id: null, kind: 'assistant', title: 'Assistant', status: 'idle', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [] });
    const ask = (method: string, params: object) => s.ctx.sessions.rpc(assistant.id, method, params);
    await expect(ask('create_items', { project_key: 'LK', items: [{ title: 'x' }] })).rejects.toThrow(LOCKED);
    await expect(ask('update_item', { key: item.key, title: 'Changed' })).rejects.toThrow(LOCKED);
    await expect(ask('update_project', { key: 'LK', name: 'Renamed' })).rejects.toThrow(LOCKED);
    await expect(ask('add_comment', { key: item.key, body: 'hi' })).rejects.toThrow(LOCKED);
    expect(await ask('list_items', { project_key: 'LK' })).toHaveLength(1);
    expect(s.ctx.store.comments(item.id)).toHaveLength(0);

    await enable();
    expect(await tool('add_comment', { key: item.key, text: 'hi' })).toEqual({ error: false, text: `Commented on ${item.key}` });
    expect(await rpc('create_item', { type: 'bug', title: 'x', body_md: '', importance: 2, effort: null })).toMatchObject({ key: 'LK-2' });
  });

  it('pauses every schedule and restores each one\'s state on enable', async () => {
    const on = (await s.call('POST', '/projects/LK/schedules', { name: 'On', at_time: '02:00', max_batches: 2, scope_md: 'bugs only' })).data;
    const off = (await s.call('POST', '/projects/LK/schedules', { name: 'Off', at_time: '03:00', enabled: false })).data;
    await disable();
    const paused = (await s.call('GET', '/projects/LK/schedules')).data as { id: number; enabled: boolean; next_run: string | null }[];
    expect(paused.map((x) => [x.id, x.enabled, x.next_run])).toEqual([[on.id, false, null], [off.id, false, null]]);
    // a slot that comes while disabled does not run
    s.ctx.scheduler.tick(new Date(Date.now() + 24 * 3600_000));
    expect(s.ctx.store.sessions({ project_id: s.ctx.store.projectByKey('LK')!.id })).toHaveLength(0);

    await enable();
    const back = (await s.call('GET', '/projects/LK/schedules')).data as { id: number; enabled: boolean; max_batches: number; scope_md: string; next_run: string | null }[];
    expect(back.find((x) => x.id === on.id)).toMatchObject({ enabled: true, max_batches: 2, scope_md: 'bugs only' });
    expect(back.find((x) => x.id === on.id)!.next_run).toBeTruthy();
    expect(back.find((x) => x.id === off.id)).toMatchObject({ enabled: false, next_run: null });
    // and its next slot runs again
    s.ctx.scheduler.tick(new Date(Date.parse(back.find((x) => x.id === on.id)!.next_run!) + 60_000));
    expect(s.ctx.store.sessions({ project_id: s.ctx.store.projectByKey('LK')!.id }).map((x) => x.title)).toEqual(['Scheduled: On']);
  });

  it('a queued session does not start while disabled, and starts on enable; a running one goes on', async () => {
    const running = (await s.call('POST', '/projects/LK/planner', { prompt: 'first', source_id: null })).data;
    const queued = (await s.call('POST', '/projects/LK/planner', { prompt: 'second', source_id: null })).data;
    s.ctx.store.updateSession(running.id, { status: 'running' });
    await disable();
    // a worker is there now
    const started: number[] = [];
    s.ctx.hub.link = () => ({ facts: null }) as unknown as WorkerLink;
    s.ctx.hub.send = (_w, m) => (m.t === 'start' && started.push(m.spec.session_id), true);
    s.ctx.sessions.dispatch();
    expect(started).toEqual([]);
    expect(s.ctx.store.session(queued.id)).toMatchObject({ status: 'queued', waiting_reason: LOCKED });
    expect(s.ctx.store.session(running.id)!.status).toBe('running');

    await enable();
    expect(started).toEqual([queued.id]);
    expect(s.ctx.store.session(queued.id)!.status).toBe('running');
  });
});
