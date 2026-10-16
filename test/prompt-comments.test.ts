import { describe, expect, it } from 'vitest';
import { discussPrompt, plannerPrompt, workPrompt } from '../src/worker/prompts.ts';
import { DEFAULT_RUN_OPTIONS, type Item } from '../src/shared/types.ts';

const item = (comments: Item['comments']): Item => ({
  id: 1, project_id: 1, number: 55, key: 'SLD-55', type: 'backlog', title: 'DP25 — writing standard', body_md: 'The description.',
  status: 'backlog', importance: 2, effort: null, source_id: null, labels: [], modules: [], marked: false, sort_order: 0,
  created_at: '', updated_at: '', comments,
});
const spec = (items: Item[]) => ({
  session_id: 1, kind: 'work' as const, project_key: 'SLD', project_name: 'slides', importance_scale: ['L', 'M', 'H', 'C'], effort_scale: ['S'],
  title: 't', branch: 'b', repos: [], items, source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS,
  claude_account: null, github_account: null, resume: null, resume_note: null,
});

describe('item comments in agent prompts', () => {
  it('a work session and Discuss get the comments under the description', () => {
    const it1 = item([
      { author: 'you', body_md: 'Keep the two layers apart.', created_at: '2026-10-16T10:00:00Z' },
      { author: 'claude', body_md: '**Design note:** put the standard in deck.writing.', created_at: '2026-10-17T09:00:00Z' },
    ]);
    for (const text of [workPrompt(spec([it1])), discussPrompt({ ...spec([it1]), kind: 'discuss' }, [])]) {
      expect(text).toContain('The description.\n\nComments on SLD-55 (oldest first;');
      expect(text).toContain('- you, 2026-10-16: Keep the two layers apart.\n- claude, 2026-10-17: **Design note:** put the standard in deck.writing.');
    }
    expect(workPrompt(spec([item([])]))).not.toContain('Comments on');
  });

  it('keeps the newest comments that fit, and says the rest are in get_item', () => {
    const many = Array.from({ length: 14 }, (_, n) => ({ author: 'you', body_md: `note ${n}`, created_at: '2026-10-17T00:00:00Z' }));
    const text = workPrompt(spec([item(many)]));
    expect(text).toContain('(4 earlier comments not shown here; get_item has them all)');
    expect(text).toContain('note 13');
    expect(text).not.toContain('note 3\n');
    const long = workPrompt(spec([item([{ author: 'you', body_md: 'x'.repeat(5000), created_at: '2026-10-17T00:00:00Z' }])]));
    expect(long).toContain('… (cut; get_item has the full text)');
    expect(long.length).toBeLessThan(9000);
    const big = Array.from({ length: 8 }, () => ({ author: 'you', body_md: 'y'.repeat(1100), created_at: '2026-10-17T00:00:00Z' }));
    expect(workPrompt(spec([item(big)]))).toContain('earlier comments not shown here');
  });

  it('the planner is told to read candidates in full, comments included', () => {
    expect(plannerPrompt({ ...spec([]), kind: 'planner', branch: null })).toContain('read each candidate in full with `get_item`');
  });
});
