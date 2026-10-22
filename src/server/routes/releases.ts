import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { compareVersions, normalizeVersion, unreleased, VERSION_RE } from '../../shared/release.ts';
import { releaseOptions, releaseProposal } from '../releases.ts';
import { HttpError, notFound, type Ctx } from './ctx.ts';

const pick = z.object({ worker_id: z.coerce.number().int(), repo_id: z.coerce.number().int() });
const create = pick.extend({ version: z.string().trim().min(1).max(60) });

export function releaseRoutes(app: FastifyInstance, ctx: Ctx) {
  const { store, sessions } = ctx;
  const project = (key: unknown) => {
    const p = store.projectByKey(String(key));
    if (!p) throw notFound('Project');
    return p;
  };
  const option = (p: ReturnType<typeof project>, q: z.infer<typeof pick>) => {
    const o = releaseOptions(ctx, p).find((x) => x.worker_id === q.worker_id && x.repo_id === q.repo_id);
    if (!o) {
      const worker = ctx.workers.get(q.worker_id)?.name ?? q.worker_id;
      const repo = store.repo(q.repo_id)?.github_name ?? q.repo_id;
      throw new HttpError(400, `Worker ${worker} does not offer releases of ${repo} now (is it connected?)`);
    }
    return o;
  };

  /** Which connected worker can release which of the project's repos. */
  app.get('/api/projects/:key/releases', async (req) => releaseOptions(ctx, project((req.params as { key: string }).key)));

  app.get('/api/projects/:key/releases/proposal', async (req) => {
    const p = project((req.params as { key: string }).key);
    return releaseProposal(ctx, p, option(p, pick.parse(req.query)));
  });

  app.post('/api/projects/:key/releases', async (req) => {
    const p = project((req.params as { key: string }).key);
    const input = create.parse(req.body);
    const opt = option(p, input);
    const proposal = await releaseProposal(ctx, p, opt);
    // typed without a v: follow the last release's style (for a first release, the proposal's)
    const version = normalizeVersion(input.version, proposal.last?.version ?? proposal.proposed);
    if (!VERSION_RE.test(version)) throw new HttpError(400, `"${input.version}" is not a version like v1.2.3`);
    const label = `${opt.label_prefix}${version}`;
    const all = store.items(p.id);
    if (all.some((i) => i.labels.includes(label))) throw new HttpError(409, `${label} is already used`);
    if (proposal.last && compareVersions(version, proposal.last.version) <= 0) throw new HttpError(409, `${version} is not above the last release ${proposal.last.version}`);
    const items = unreleased(all, opt.label_prefix);
    if (!items.length) throw new HttpError(400, 'No done items since the last release');
    return sessions.startRelease(p, {
      workerId: opt.worker_id, repo: store.repo(opt.repo_id)!, items,
      release: { repo_id: opt.repo_id, cap_repo: opt.cap_repo, version, label_prefix: opt.label_prefix, command: opt.command, notes: opt.notes, last_version: proposal.last?.version ?? null },
    });
  });
}
