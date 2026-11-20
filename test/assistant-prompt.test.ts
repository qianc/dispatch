import { describe, expect, it } from 'vitest';
import { assistantPrompt } from '../src/worker/prompts.ts';

describe('the Assistant prompt', () => {
  const p = assistantPrompt([]);

  it('checks its tools before it says it cannot, and attaches pasted images (DISP-127)', () => {
    expect(p).toContain('check the tools you have before you say you cannot do it');
    expect(p).toMatch(/asks to attach one to an item[^\n]*call `attach_image`/);
  });

  it('files a pasted error as a bug instead of hunting for a fix (DISP-125)', () => {
    const rule = p.split('\n').find((l) => l.startsWith('- An error the owner pastes'));
    expect(rule).toMatch(/text or a screenshot/);
    expect(rule).toMatch(/`list_items`.*`create_items` a bug.*exact error text/);
    expect(rule).toContain('Do not look in the code for the cause or suggest fixes unless the owner asks.');
    // one rule for it, not two that overlap
    expect(p.match(/check `list_items` for the same bug/g)).toHaveLength(1);
  });
});
