import type { FastifyInstance } from 'fastify';
import { mergeInput } from '../../shared/types.ts';
import { HttpError, intParam, type Ctx } from './ctx.ts';

export function prRoutes(app: FastifyInstance, { github, sessions, store }: Ctx) {
  app.get('/api/prs/:id', async (req) => github.detail(intParam((req.params as { id: string }).id)));

  app.post('/api/prs/:id/merge', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const { how, method } = mergeInput.parse(req.body);
    return github.merge(id, how, method);
  });

  /** Merge conflict: send the session that owns the branch back to work to resolve it. */
  app.post('/api/prs/:id/resolve-conflicts', async (req) => {
    const pr = store.pr(intParam((req.params as { id: string }).id));
    if (!pr) throw new HttpError(404, 'PR not found');
    const repo = store.repo(pr.repo_id)!;
    sessions.send(pr.session_id, `PR #${pr.number} in ${pr.repo_full_name} has merge conflicts with ${repo.default_branch}. In this branch (${pr.head_ref}), fetch and merge origin/${repo.default_branch}, resolve the conflicts keeping the intent of both sides, run the tests, commit and push the branch.`);
    return store.session(pr.session_id);
  });
}
