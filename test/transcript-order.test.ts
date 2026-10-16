import { describe, expect, it } from 'vitest';
import { groupWork } from '../web/src/components/transcript.tsx';

let seq = 0;
const ev = (body: object) => ({ id: ++seq, seq, session_id: 1, created_at: '', body }) as never;

describe('proposal cards in a turn', () => {
  const tool = ev({ kind: 'tool_use', tool_use_id: 't', name: 'mcp__dispatch__propose_batch', summary: '', input: {} });
  const proposal = ev({ kind: 'proposal', proposal: { type: 'batch' } });
  const text = ev({ kind: 'assistant', text: 'Why these six: ...' });
  const result = ev({ kind: 'result', subtype: 'success' });
  const kinds = (units: ReturnType<typeof groupWork>) => units.map((u) => (u.t === 'event' ? (u.e as { body: { kind: string } }).body.kind : u.t));

  it('waits while the turn runs, even before the explanation arrives', () => {
    expect(kinds(groupWork([tool, proposal], true))).toEqual(['work', 'pending_proposal']);
    expect(kinds(groupWork([tool, proposal, text], true))).toEqual(['work', 'pending_proposal']);
  });

  it('comes after the explanation once the turn ends', () => {
    expect(kinds(groupWork([tool, proposal, text, result], false))).toEqual(['work', 'assistant', 'proposal', 'result']);
  });
});
