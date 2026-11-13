import { DEFAULT_RUN_OPTIONS, type PullRequest } from '../src/shared/types.ts';
import { OWNER, startServer } from './helpers.ts';

export type Server = Awaited<ReturnType<typeof startServer>>;

/** Projects AA, BB (in scope in most tests) and CC, each with one GitHub repo. */
export async function projects(s: Server, headers: Record<string, string> = {}) {
  for (const key of ['AA', 'BB', 'CC']) {
    await s.call('POST', '/projects', { key, name: `Project ${key}` }, headers);
    await s.call('POST', `/projects/${key}/repos`, { github_owner: 'me', github_name: key.toLowerCase() }, headers);
  }
}

/** A server with projects AA, BB, CC, and helpers for an orchestration over AA and BB. */
export async function setup(env: Record<string, string> = {}) {
  const s = await startServer(env);
  await projects(s);
  const pushes: { title: string; body: string; url: string }[] = [];
  s.ctx.notifier.send = async (n) => void pushes.push({ title: n.title, body: n.body, url: n.url });
  const store = s.ctx.store;
  const item = async (project: string, title: string, status = 'backlog') =>
    (await s.call('POST', `/projects/${project}/items`, { title, status })).data as { id: number; key: string };
  const start = (extra: Record<string, unknown> = {}) =>
    s.ctx.orchestrator.start({ goal: 'Rework auth', project_keys: ['AA', 'BB'], max_children: 2, answer_children: true, options: DEFAULT_RUN_OPTIONS, ...extra }, OWNER);
  const rpc = (id: number, method: string, params: unknown = {}) => s.ctx.sessions.rpc(id, method, params);
  /** the worker's status report for a session */
  const status = (id: number, st: 'idle' | 'failed' | 'running') =>
    s.ctx.sessions.onWorkerMessage(store.session(id)!.worker_id!, { t: 'status', session_id: id, status: st });
  /** the chat of a session as "kind: text" lines */
  const events = (id: number) => store.events(id).map((e) => ('text' in e.body ? `${e.body.kind}: ${e.body.text}` : e.body.kind));
  /** a PR of a child session in a state, told on the bus as the GitHub sync does */
  const pr = (sessionId: number, state: PullRequest['state'], extra: Partial<Pick<PullRequest, 'blocked' | 'mergeable'>> = {}) => {
    const session = store.session(sessionId)!;
    const repo = store.repos(session.project_id!)[0];
    const row = store.upsertPr({ session_id: sessionId, repo_id: repo.id, number: 100 + sessionId, url: '', title: session.title, state, mergeable: extra.mergeable ?? true, mergeable_state: null, head_ref: 'b', head_sha: 'abc' });
    if (extra.blocked) store.setPrBlocked(row.id, extra.blocked);
    const saved = store.pr(row.id)!;
    s.ctx.bus.emit({ t: 'pr', pr: saved });
    return saved;
  };
  /**
   * An approved plan: AA "Token store" (item a), then BB "Use the tokens" (item b) after it, and an
   * independent AA "Docs" (item d). The orchestrator's first turn has ended (it is idle).
   */
  const approved = async (extra: Record<string, unknown> = {}) => {
    const a = await item('AA', 'Store tokens');
    const b = await item('BB', 'Use tokens');
    const d = await item('AA', 'Write docs');
    const id = start(extra).session_id;
    await rpc(id, 'set_plan', {
      plan_md: 'First the store, then its use.',
      steps: [
        { title: 'Token store', project_key: 'AA', prompt: 'Build the store.', item_keys: [a.key] },
        { title: 'Use the tokens', project_key: 'BB', prompt: 'Use it.', item_keys: [b.key], after: [1] },
        { title: 'Docs', project_key: 'AA', prompt: '', item_keys: [d.key] },
      ],
    });
    status(id, 'running');
    status(id, 'idle');
    s.ctx.orchestrator.approve(id);
    const [first, second, third] = s.ctx.orchestrator.view(id).steps;
    return { id, a, b, d, first, second, third };
  };
  /** start a step; the id of its child session */
  const startStep = async (id: number, stepId: number) => {
    await rpc(id, 'start_step', { step_id: stepId });
    return store.step(stepId)!.child_session_id!;
  };
  return { s, store, pushes, item, start, rpc, status, events, pr, approved, startStep };
}
export type Setup = Awaited<ReturnType<typeof setup>>;
