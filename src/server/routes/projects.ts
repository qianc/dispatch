import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectInput, projectPatch, isRepoSubdir, repoInput, repoPatch } from '../../shared/types.ts';
import { HttpError, intParam, notFound, type Ctx } from './ctx.ts';
import { addHostedRepo, addLocalRepo, mergeNote, ownerName } from '../repos.ts';

export function projectRoutes(app: FastifyInstance, { store, hub, github, workers, bus, hosted }: Ctx) {
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
          running: sessions.filter((s) => s.status === 'running').length,
          queued: sessions.filter((s) => s.status === 'queued').length,
          waiting: sessions.filter((s) => s.status === 'waiting_input' || s.status === 'idle').length,
        },
      };
    }),
  );

  app.post('/api/projects', async (req) => {
    const input = projectInput.parse(req.body);
    if (store.projectByKey(input.key)) throw new HttpError(409, `Key ${input.key} is taken`);
    const created = store.createProject(input);
    bus.emit({ t: 'project', key: created.key });
    return created;
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
    const updated = store.updateProject(p.id, rest);
    bus.emit({ t: 'project', key: p.key });
    return { ...updated, muted: store.isMuted(p.id), repos: store.repos(p.id) };
  });

  app.post('/api/projects/:key/repos', async (req) => {
    const p = project((req.params as { key: string }).key);
    const body = (req.body ?? {}) as { local_path?: string; hosted?: unknown };
    if (body.hosted) {
      const { hosted: input } = z.object({ hosted: z.object({ name: z.string().min(1), default_branch: z.string().min(1).optional(), import: z.string().optional(), upstream: z.string().optional(), check_command: z.string().nullable().optional() }) }).parse(req.body);
      const repo = await addHostedRepo(store, hosted, github, p, input);
      bus.emit({ t: 'project', key: p.key });
      return repo;
    }
    if (body.local_path) {
      const input = z.object({ local_path: z.string().min(1), default_branch: z.string().optional(), check_command: z.string().nullable().optional(), worker_id: z.number().int().nullable().optional() }).parse(req.body);
      const { repo, info } = await addLocalRepo(store, hub, p, input.local_path, input);
      bus.emit({ t: 'project', key: p.key });
      return { ...repo, note: mergeNote(info) };
    }
    const input = repoInput.parse(req.body);
    const repo = store.addRepo(p.id, input);
    bus.emit({ t: 'project', key: p.key });
    return repo;
  });

  app.patch('/api/repos/:id', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const repo = store.repo(id);
    if (!repo) throw notFound('Repo');
    const { upstream, ...patch } = repoPatch.extend({ upstream: z.string().nullable().optional() }).parse(req.body) as ReturnType<typeof repoPatch.parse> & { upstream?: string | null };
    if (upstream !== undefined) {
      if (repo.kind !== 'hosted') throw new HttpError(400, 'Only a repo hosted by Dispatch has an upstream.');
      const up = upstream ? ownerName(upstream) : null;
      Object.assign(patch, { upstream_owner: up?.owner ?? null, upstream_name: up?.name ?? null });
    }
    if (patch.read_dirs?.length) {
      if (!repo.local_path) throw new HttpError(400, 'Extra readable folders are for local repos only: a GitHub repo has no checkout of yours to read.');
      const bad = patch.read_dirs.find((d) => !isRepoSubdir(d));
      if (bad) throw new HttpError(400, `"${bad}" must be a folder inside the repo, e.g. reference-decks/library-work`);
      patch.read_dirs = [...new Set(patch.read_dirs.map((d) => d.replace(/\/+$/, '')))];
    }
    const updated = store.updateRepo(id, patch);
    bus.emit({ t: 'project', key: store.project(repo.project_id)!.key });
    return updated;
  });

  app.delete('/api/repos/:id', async (req) => {
    const repo = store.repo(intParam((req.params as { id: string }).id));
    if (!repo) throw notFound('Repo');
    store.deleteRepo(repo.id);
    if (repo.kind === 'hosted') await hosted.retire(repo); // the data stays on disk, renamed
    bus.emit({ t: 'project', key: store.project(repo.project_id)!.key });
    return { ok: true };
  });
}
