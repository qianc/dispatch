// How a session's events are laid out: work folded into one line per stretch, and proposal cards
// held until the end of their turn. Plain TypeScript (no JSX), so tests can import it.
import type { SessionEvent } from '../api.ts';

export const HIDDEN_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

export type Unit = { t: 'event'; e: SessionEvent } | { t: 'work'; key: number; events: SessionEvent[]; live: boolean } | { t: 'pending_proposal'; key: number };

const isWork = (e: SessionEvent) => e.body.kind === 'tool_use' || e.body.kind === 'tool_result' || e.body.kind === 'assistant';

/**
 * Fold each stretch of work (tool calls and in-between notes) into one "Worked · N steps" line, so
 * Claude's answer stands out: the last message before a turn ends, a question, or your next message
 * stays outside the fold. The stretch still running stays open, so you can follow along.
 * Proposal cards move to the end of their turn, after the answer that explains them.
 */
export function groupWork(events: SessionEvent[], running: boolean): Unit[] {
  const out: Unit[] = [];
  let buf: SessionEvent[] = [];
  const flush = (live: boolean) => {
    if (!buf.length) return;
    let lastText = -1;
    for (let i = buf.length - 1; i >= 0; i--) if (buf[i].body.kind === 'assistant') { lastText = i; break; }
    // live: fold nothing yet; finished: fold what came before the answer, if it holds any tool call
    const cut = live ? buf.length : lastText < 0 ? buf.length : lastText;
    const work = buf.slice(0, cut);
    const steps = work.filter((e) => e.body.kind === 'tool_use' && !HIDDEN_TOOLS.has(e.body.name)).length;
    if (steps > 0) out.push({ t: 'work', key: work[0].seq, events: work, live });
    else for (const e of work) out.push({ t: 'event', e });
    for (const e of buf.slice(cut)) out.push({ t: 'event', e });
    buf = [];
  };
  // a proposal card waits until the end of its turn, so Claude's reasoning comes before the Start button
  let proposals: SessionEvent[] = [];
  const release = () => {
    for (const e of proposals) out.push({ t: 'event', e });
    proposals = [];
  };
  for (const e of events) {
    if (isWork(e)) buf.push(e);
    else if (e.body.kind === 'proposal_done') continue;
    else if (e.body.kind === 'proposal') proposals.push(e);
    else {
      flush(false);
      release();
      out.push({ t: 'event', e });
    }
  }
  flush(running);
  // the turn is still running: the card waits for Claude's explanation and the end of the turn
  if (running && proposals.length) out.push({ t: 'pending_proposal', key: proposals[0].seq });
  else release();
  return out;
}

