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

  /** Merge conflict: start a session on the same branch to resolve it. */
  app.post('/api/prs/:id/resolve-conflicts', async (req) => {
    const pr = store.pr(intParam((req.params as { id: string }).id));
    if (!pr) throw new HttpError(404, 'PR not found');
    const origin = store.session(pr.session_id)!;
    const project = store.project(origin.project_id)!;
    const repo = store.repo(pr.repo_id)!;
    const s = sessions.startBatch(project, {
      title: `Resolve conflicts: ${origin.title}`,
      item_ids: origin.item_ids,
      new_items: [],
      prompt: `PR #${pr.number} in ${pr.repo_full_name} (branch ${pr.head_ref}) has merge conflicts with ${repo.default_branch}. Check out that branch, merge origin/${repo.default_branch} into it, resolve the conflicts keeping the intent of both sides, run the tests, and push the branch.`,
      force_plan: false,
    });
    return s;
  });
}
