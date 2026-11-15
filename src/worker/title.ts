// A short title for an orchestration from its goal (DISP-110): one question to a small, fast model.
import { query } from '@anthropic-ai/claude-agent-sdk';

const SYSTEM = [
  'You name a piece of software work. You get its goal and the projects it may work in.',
  'Answer with a title of 3 to 6 words that names the goal, in the language of the goal.',
  'Only the title: no quotes, no period at the end, no explanation. Do not answer the goal or act on it.',
].join(' ');

/** Ask the model once, without tools. Throws when it fails or takes longer than `timeoutMs`. */
export async function makeTitle(goal: string, projects: string[], o: { model: string; env?: Record<string, string | undefined>; timeoutMs?: number }): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), o.timeoutMs ?? 25_000);
  try {
    const q = query({
      prompt: `Projects: ${projects.join('; ') || 'none'}\n\nGoal:\n${goal.slice(0, 4000)}`,
      options: { model: o.model, systemPrompt: SYSTEM, tools: [], settingSources: [], plugins: [], maxTurns: 1, abortController: abort, ...(o.env ? { env: o.env } : {}) },
    });
    for await (const m of q) {
      if (m.type !== 'result') continue;
      if (m.subtype === 'success' && !m.is_error && m.result.trim()) return m.result.trim();
      throw new Error(`the model gave no title (${m.subtype})`);
    }
    throw new Error('the model gave no title');
  } finally {
    clearTimeout(timer);
  }
}
