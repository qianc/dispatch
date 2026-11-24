import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartSpec, WorkerToServer } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import { dispatchMcp } from '../src/worker/mcp.ts';
import { ClaudeRunner } from '../src/worker/runner.ts';
import { startServer, OWNER } from './helpers.ts';

// DISP-257: the assistant reads a session's transcript only with the owner's approval of that session.
describe('assistant reads a session transcript', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let workerId: number;
  beforeAll(async () => {
    s = await startServer();
    workerId = s.ctx.workers.legacy().id;
    s.ctx.hub.send = () => true; // the answer goes to a worker that is not there
  });
  afterAll(() => s.app.close());

  const session = (kind: 'assistant' | 'orchestrator', title: string) => s.ctx.store.createSession({
    started_by: OWNER, project_id: null, kind, title, status: 'running', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [], worker_id: workerId,
  });
  let n = 0;
  /** what the worker does: ask the owner, who answers through the API */
  const ask = async (chatId: number, sessionId: number, approve: boolean) => {
    const local_id = `t${++n}`;
    s.ctx.sessions.onWorkerMessage(workerId, { t: 'input_request', session_id: chatId, local_id, payload: { kind: 'cross_project', action: 'transcript', project_key: '', session_id: sessionId } });
    const input = s.ctx.store.inputs(chatId).find((i) => i.local_id === local_id)!;
    expect((await s.call('POST', `/inputs/${input.id}/answer`, { kind: 'cross_project', approve })).status).toBeLessThan(300);
    return local_id;
  };

  it('reads an approved session once, and refuses one the owner did not approve', async () => {
    const chat = session('assistant', 'Assistant');
    const target = session('orchestrator', 'Complete EDD tickets');
    const other = session('orchestrator', 'Other');
    s.ctx.store.addEvent(target.id, { kind: 'user', text: 'Restart the steps' });
    s.ctx.store.addEvent(target.id, { kind: 'assistant', text: "I can't do either of those from here." });
    const read = (session_id: number, approval?: string) => s.ctx.sessions.rpc(chat.id, 'read_session', { session_id, approval });

    await expect(read(target.id)).rejects.toThrow(/ask the owner first/);
    const no = await ask(chat.id, target.id, false);
    await expect(read(target.id, no)).rejects.toThrow(/did not approve/);
    const yes = await ask(chat.id, target.id, true);
    await expect(read(other.id, yes)).rejects.toThrow(/not the session the owner approved/);
    const got = (await read(target.id, yes)) as { session: { id: number; title: string }; transcript: string };
    expect(got.session).toMatchObject({ id: target.id, title: 'Complete EDD tickets' });
    expect(got.transcript).toContain('**Owner:** Restart the steps');
    expect(got.transcript).toContain("**Claude:** I can't do either of those from here.");
    await expect(read(target.id, yes)).rejects.toThrow(/already used/);
  });

  it('the assistant has a read_session tool', () => {
    const server = dispatchMcp('assistant', async () => null, undefined, undefined, false, { ownKey: '', ask: async () => null }) as unknown as { instance: { _registeredTools: Record<string, unknown> } };
    expect(Object.keys(server.instance._registeredTools)).toContain('read_session');
  });

  it('the transcript stays out of the chat log; a denial is kept', () => {
    const spec = { session_id: 4, kind: 'assistant', project_key: '', project_name: '', importance_scale: [], effort_scale: [], title: 'A', branch: null, repos: [], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: null, resume: null, resume_note: null } as StartSpec;
    const sent: WorkerToServer[] = [];
    const runner = new ClaudeRunner(spec, { emit: (m) => sent.push(m), rpc: async () => undefined, cwd: '/tmp', onClosed: () => undefined }, { pluginDirs: [], settingSources: [], idleCloseMs: 60_000, assistantModel: 'haiku', discussModel: 'haiku', assistantReadDirs: [] });
    const handle = (m: unknown) => (runner as unknown as { handle: (m: unknown) => void }).handle(m);
    const call = (id: string, result: string) => {
      handle({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude', content: [{ type: 'tool_use', id, name: 'mcp__dispatch__read_session', input: { session_id: 503 } }] } });
      handle({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
    };
    call('r1', JSON.stringify({ session: { id: 503 }, transcript: '**Owner:** secret plans' }));
    call('r2', 'The owner denied reading session #503.');
    const results = sent.flatMap((m) => (m.t === 'event' && m.body.kind === 'tool_result' ? [m.body.text] : []));
    expect(results).toEqual(['Read (the transcript is not kept in this chat).', 'The owner denied reading session #503.']);
  });
});
