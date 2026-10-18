// Files linked from item text: read from the project's repos (default branch) or the folder an
// imported source file came from. The worker does the reading; this route picks where to look.
import { dirname, extname, isAbsolute, normalize } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, notFound, type Ctx } from './ctx.ts';

const MIME: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf',
};
const mime = (p: string) => MIME[extname(p).toLowerCase()] ?? 'text/plain; charset=utf-8';

/** A repo-relative path: no absolute paths, no climbing out with "..". */
export function safeRelPath(p: string): string {
  const clean = normalize(p.replace(/^\.\//, '')).replace(/\\/g, '/');
  if (!clean || isAbsolute(clean) || clean === '..' || clean.startsWith('../')) throw new HttpError(400, 'Bad path');
  return clean;
}

export function fileRoutes(app: FastifyInstance, { store, hub }: Ctx) {
  app.get('/api/projects/:key/file', async (req, reply) => {
    const project = store.projectByKey((req.params as { key: string }).key);
    if (!project) throw notFound('Project');
    const q = z.object({ path: z.string().min(1), source: z.coerce.number().int().optional() }).parse(req.query);
    const path = safeRelPath(q.path.split('#')[0]);
    const tries: { repo?: (typeof repos)[number]; base_dir?: string }[] = [];
    const repos = store.repos(project.id);
    for (const repo of repos) tries.push({ repo });
    const source = q.source ? store.source(q.source) : undefined;
    if (source && source.project_id === project.id && isAbsolute(source.title)) tries.push({ base_dir: dirname(source.title) });
    if (!tries.length) throw new HttpError(404, 'This project has no repo or source folder to read files from');
    for (const t of tries) {
      try {
        // a local repo is on its worker; GitHub repos and source folders on the project's
        const worker = t.repo?.worker_id ?? project.worker_id ?? store.defaultWorkerId();
        const res = await hub.cmd<{ base64: string }>(worker, { c: 'read_file', ...t, path }, 60_000);
        reply.header('cache-control', 'private, max-age=300');
        return reply.type(mime(path)).send(Buffer.from(res.base64, 'base64'));
      } catch {
        // not in this place; try the next
      }
    }
    throw new HttpError(404, `${path} was not found in the project's repos or source folder`);
  });
}
