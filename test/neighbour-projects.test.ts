import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionKind } from '../src/shared/types.ts';
import { dispatchMcp } from '../src/worker/mcp.ts';
import { plannerPrompt, workPrompt } from '../src/worker/prompts.ts';
import { startServer, OWNER } from './helpers.ts';

// DISP-126: work sessions and scheduled runs file items into the neighbour projects the owner linked.
describe('Filing items into neighbour projects', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let workerId: number;
  const rules = new Map<string, string>();
  beforeAll(async () => {
    s = await startServer();
    for (const [key, name] of [['NA', 'Slides'], ['NB', 'Techdoc'], ['NC', 'Other'], ['ND', 'Old']]) await s.call('POST', '/projects', { key, name });
    workerId = s.ctx.workers.legacy().id;
    s.ctx.hub.send = () => true;
    s.ctx.sessions.rules = async (p) => rules.get(p.key) ?? '';
  });
  afterAll(() => s.app.close());

  const project = (key: string) => s.ctx.store.projectByKey(key)!;
  const session = (key: string, kind: SessionKind = 'work', schedule_id: number | null = null) =>
    s.ctx.store.createSession({ started_by: OWNER, project_id: project(key).id, kind, title: 'SL115 deck flow', status: 'running', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [], worker_id: workerId, schedule_id });
  const item = { type: 'backlog', title: 'Techdoc misses the recommend step', body_md: 'The SL115 batch added it.', importance: 2, effort: null };
  const spec = (id: number) => s.ctx.sessions.spec(s.ctx.store.session(id)!, '', null, null);

  it('lets the owner set neighbours by key, one way, and refuses unknown keys and the project itself', async () => {
    expect((await s.call('PATCH', '/projects/NA', { neighbours: ['nb', 'ND'] })).data.neighbours).toEqual(['NB', 'ND']);
    expect((await s.call('GET', '/projects/NB')).data.neighbours).toEqual([]);
    expect((await s.call('PATCH', '/projects/NA', { neighbours: ['ZZ'] })).status).toBe(400);
    expect((await s.call('PATCH', '/projects/NA', { neighbours: ['NA'] })).status).toBe(400);
    expect(project('NA').neighbours).toEqual(['NB', 'ND']);
  });

  it('files into a linked neighbour, in its triage, linked to the session', async () => {
    const w = session('NA');
    const res = (await s.ctx.sessions.rpc(w.id, 'create_item', { ...item, type: 'bug', project_key: 'nb' })) as { key: string; project: string; status: string };
    expect(res).toMatchObject({ key: 'NB-1', project: 'NB', status: 'triage' });
    const made = s.ctx.store.itemByNumber(project('NB').id, 1)!;
    expect(made).toMatchObject({ title: item.title, status: 'triage', type: 'bug' });
    const source = s.ctx.store.source(made.source_id!)!;
    expect(source).toMatchObject({ kind: 'agent_session', session_id: w.id, project_id: project('NB').id });
    expect(source.title).toBe(`Found during session #${w.id} (NA): SL115 deck flow`);
    expect(s.ctx.store.events(w.id).at(-1)?.body).toMatchObject({ kind: 'system', text: 'Filed NB-1 in project NB' });
    // a backlog item lands in triage too; without a project_key, or with its own key, it stays here as before
    expect(await s.ctx.sessions.rpc(w.id, 'create_item', { ...item, project_key: 'NB' })).toMatchObject({ key: 'NB-2', status: 'triage' });
    expect(await s.ctx.sessions.rpc(w.id, 'create_item', item)).toMatchObject({ key: 'NA-1' });
    expect(await s.ctx.sessions.rpc(w.id, 'create_item', { ...item, project_key: 'NA' })).toMatchObject({ key: 'NA-2' });
    expect(s.ctx.store.itemByNumber(project('NA').id, 1)!.status).toBe('backlog');
  });

  it('refuses a project that is not a neighbour, the way back, and a disabled neighbour', async () => {
    await expect(s.ctx.sessions.rpc(session('NA').id, 'create_item', { ...item, project_key: 'NC' })).rejects.toThrow(/NC is not a neighbour of NA: you may file into NB, ND/);
    await expect(s.ctx.sessions.rpc(session('NB').id, 'create_item', { ...item, project_key: 'NA' })).rejects.toThrow(/not a neighbour of NB: it has none/);
    await s.call('POST', '/projects/ND/disable');
    await expect(s.ctx.sessions.rpc(session('NA').id, 'create_item', { ...item, project_key: 'ND' })).rejects.toThrow(/disabled|read-only/i);
    expect(s.ctx.store.items(project('ND').id)).toHaveLength(0);
    expect(s.ctx.store.items(project('NC').id)).toHaveLength(0);
  });

  it('shows the neighbour its rules first, once per session', async () => {
    rules.set('NB', '### CLAUDE.md of x/techdoc\n\nTitles start with the page id.');
    const w = session('NA');
    await expect(s.ctx.sessions.rpc(w.id, 'create_item', { ...item, project_key: 'NB' })).rejects.toThrow(/Nothing created yet[\s\S]*Titles start with the page id/);
    const before = s.ctx.store.items(project('NB').id).length;
    expect(await s.ctx.sessions.rpc(w.id, 'create_item', { ...item, title: 'P7 misses the step', project_key: 'NB' })).toMatchObject({ project: 'NB' });
    expect(s.ctx.store.items(project('NB').id)).toHaveLength(before + 1);
    rules.delete('NB');
  });

  it("tries again when the neighbour's rules could not be read (DISP-239 #27)", async () => {
    const w = session('NA');
    const real = s.ctx.sessions.rules;
    s.ctx.sessions.rules = async () => {
      throw new Error("Nothing created yet: NB's instructions for agents (CLAUDE.md of techdoc) could not be read (Worker is not connected). Try again later.");
    };
    await expect(s.ctx.sessions.rpc(w.id, 'create_item', { ...item, project_key: 'NB' })).rejects.toThrow(/could not be read/);
    s.ctx.sessions.rules = real;
    rules.set('NB', 'Titles start with the page id.');
    // not marked as shown: the rules come on the next try
    await expect(s.ctx.sessions.rpc(w.id, 'create_item', { ...item, project_key: 'NB' })).rejects.toThrow(/Titles start with the page id/);
    rules.delete('NB');
  });

  it('is for work sessions and scheduled runs only', async () => {
    await expect(s.ctx.sessions.rpc(session('NA', 'planner').id, 'create_item', { ...item, project_key: 'NB' })).rejects.toThrow(/Only work sessions and scheduled runs/);
    const sched = (await s.call('POST', '/projects/NA/schedules', { name: 'Nightly', at_time: '02:00' })).data as { id: number };
    const run = session('NA', 'planner', sched.id);
    expect(await s.ctx.sessions.rpc(run.id, 'create_item', { ...item, project_key: 'NB' })).toMatchObject({ project: 'NB', status: 'triage' });
    // a discussion still files nothing
    await expect(s.ctx.sessions.rpc(session('NA', 'discuss').id, 'create_item', { ...item, project_key: 'NB' })).rejects.toThrow(/read-only/);
  });

  it('tells the session about its neighbours: spec, prompt and tool; disabled ones are left out', async () => {
    const w = session('NA');
    expect(spec(w.id).neighbours).toEqual([{ key: 'NB', name: 'Techdoc', importance_scale: project('NB').importance_scale, effort_scale: project('NB').effort_scale }]);
    expect(workPrompt(spec(w.id))).toContain('Work that belongs to a neighbour project (NB (Techdoc)) goes there');
    const sched = (await s.call('POST', '/projects/NA/schedules', { name: 'Weekly', at_time: '03:00' })).data as { id: number };
    expect(plannerPrompt(spec(session('NA', 'planner', sched.id).id))).toContain('neighbour project (NB (Techdoc))');
    // none for an unscheduled planner, nor for a project without neighbours
    expect(spec(session('NA', 'planner').id).neighbours).toBeUndefined();
    const lone = session('NC');
    expect(spec(lone.id).neighbours).toBeUndefined();
    expect(workPrompt(spec(lone.id))).not.toContain('neighbour project');

    const fields = (neighbours: Parameters<typeof dispatchMcp>[8]) => {
      const server = dispatchMcp('work', async () => null, undefined, undefined, false, undefined, undefined, false, neighbours) as unknown as { instance: { _registeredTools: Record<string, { description: string; inputSchema: { shape: Record<string, unknown> } }> } };
      return server.instance._registeredTools.create_item;
    };
    expect(Object.keys(fields([]).inputSchema.shape)).not.toContain('project_key');
    const withNb = fields(spec(w.id).neighbours);
    expect(Object.keys(withNb.inputSchema.shape)).toContain('project_key');
    expect(withNb.description).toContain('Neighbours: NB (Techdoc;');
  });

  it('drops the links of a deleted project', async () => {
    await s.call('POST', '/projects', { key: 'NE', name: 'Gone' });
    const nc = project('NE');
    s.ctx.store.setNeighbours(project('NA').id, [project('NB').id, nc.id]);
    s.ctx.store.db.run('DELETE FROM projects WHERE id = ?', nc.id);
    expect(project('NA').neighbours).toEqual(['NB']);
  });
});
