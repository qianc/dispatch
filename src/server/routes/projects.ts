import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectInput, projectPatch, repoInput } from '../../shared/types.ts';
import { HttpError, intParam, notFound, type Ctx } from './ctx.ts';

export function projectRoutes(app: FastifyInstance, { store }: Ctx) {
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
    if (muted !== undefined) store.setMuted(p.id, muted);
    return { ...store.updateProject(p.id, rest), muted: store.isMuted(p.id), repos: store.repos(p.id) };
  });

  app.post('/api/projects/:key/repos', async (req) => {
    const p = project((req.params as { key: string }).key);
    const input = repoInput.parse(req.body);
    return store.addRepo(p.id, input);
  });

  app.patch('/api/repos/:id', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    if (!store.repo(id)) throw notFound('Repo');
    return store.updateRepo(id, repoInput.partial().parse(req.body));
  });

  app.delete('/api/repos/:id', async (req) => {
    store.deleteRepo(intParam((req.params as { id: string }).id));
    return { ok: true };
  });
}
