import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectInput, projectPatch, isRepoSubdir, repoInput, repoPatch } from '../../shared/types.ts';
import { HttpError, intParam, notFound, type Ctx } from './ctx.ts';
import { addLocalRepo, mergeNote } from '../repos.ts';

export function projectRoutes(app: FastifyInstance, { store, hub, github, workers }: Ctx) {
  const project = (key: unknown) => {
    const p = store.projectByKey(String(key));
    if (!p) throw notFound('Project');
    return p;
  };

  app.get('/api/projects', async () =>
    store.projects().map((p) => {
      const sessions = store.sessions({ project_id: p.id, statuses: ['queued', 'running', 'waiting_input', 'idle'] });
      const open = store.items(p.id, { status: ['triage', 'backlog', 'todo', 'in_progress', 'in_review'] });
      return {
        ...p,
        muted: store.isMuted(p.id),
        repos: store.repos(p.id),
        counts: {
          backlog: open.filter((i) => i.type === 'backlog').length,
          bugs: open.filter((i) => i.type === 'bug').length,
          active_sessions: sessions.length,
          waiting: sessions.filter((s) => s.status === 'waiting_input' || s.status === 'idle').length,
        },
      };
    }),
  );

  app.post('/api/projects', async (req) => {
    const input = projectInput.parse(req.body);
    if (store.projectByKey(input.key)) throw new HttpError(409, `Key ${input.key} is taken`);
    return store.createProject(input);
  });

  app.get('/api/projects/:key', async (req) => {
    const p = project((req.params as { key: string }).key);
    return { ...p, muted: store.isMuted(p.id), repos: store.repos(p.id) };
  });

  app.patch('/api/projects/:key', async (req) => {
    const p = project((req.params as { key: string }).key);
    const patch = projectPatch.extend({ muted: z.boolean().optional() }).parse(req.body);
    const { muted, ...rest } = patch;
    if (rest.github_account && !github.accounts.some((a) => a.name === rest.github_account)) {
      throw new HttpError(400, `Unknown GitHub account "${rest.github_account}" (configured: ${github.accounts.map((a) => a.name).join(', ') || 'none'})`);
    }
    const known = hub.claudeAccounts().map((a) => a.name);
    for (const n of [rest.claude_account, ...(rest.claude_allowed ?? [])]) {
      if (n && known.length && !known.includes(n)) throw new HttpError(400, `Unknown Claude account "${n}" (the worker has: ${known.join(', ')})`);
    }
    const allowed = rest.claude_allowed === undefined ? p.claude_allowed : rest.claude_allowed;
    const def = rest.claude_account === undefined ? p.claude_account : rest.claude_account;
    if (def && allowed?.length && !allowed.includes(def)) throw new HttpError(400, `The default Claude account "${def}" must be one of the allowed accounts`);
    if (rest.worker_id != null && (!workers.get(rest.worker_id) || workers.get(rest.worker_id)!.revoked_at)) throw new HttpError(400, `Unknown worker ${rest.worker_id}`);
    if (muted !== undefined) store.setMuted(p.id, muted);
    return { ...store.updateProject(p.id, rest), muted: store.isMuted(p.id), repos: store.repos(p.id) };
  });

  app.post('/api/projects/:key/repos', async (req) => {
    const p = project((req.params as { key: string }).key);
    const body = (req.body ?? {}) as { local_path?: string };
    if (body.local_path) {
      const input = z.object({ local_path: z.string().min(1), default_branch: z.string().optional(), check_command: z.string().nullable().optional(), worker_id: z.number().int().nullable().optional() }).parse(req.body);
      const { repo, info } = await addLocalRepo(store, hub, p, input.local_path, input);
      return { ...repo, note: mergeNote(info) };
    }
    const input = repoInput.parse(req.body);
    return store.addRepo(p.id, input);
  });

  app.patch('/api/repos/:id', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const repo = store.repo(id);
    if (!repo) throw notFound('Repo');
    const patch = repoPatch.parse(req.body);
    if (patch.read_dirs?.length) {
      if (!repo.local_path) throw new HttpError(400, 'Extra readable folders are for local repos only: a GitHub repo has no checkout of yours to read.');
      const bad = patch.read_dirs.find((d) => !isRepoSubdir(d));
      if (bad) throw new HttpError(400, `"${bad}" must be a folder inside the repo, e.g. reference-decks/library-work`);
      patch.read_dirs = [...new Set(patch.read_dirs.map((d) => d.replace(/\/+$/, '')))];
    }
    return store.updateRepo(id, patch);
  });

  app.delete('/api/repos/:id', async (req) => {
    store.deleteRepo(intParam((req.params as { id: string }).id));
    return { ok: true };
  });
}
