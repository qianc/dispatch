import { describe, expect, it } from 'vitest';
import { detectScales, groupCounts, parseSections } from '../src/shared/markdownSections.ts';

const doc = `# My backlog

Intro text.

## Index
- a list, not items

# Open work
## S2 — visibly wrong
### X1 — First thing
**S2** · **L**

Why it matters.

\`\`\`md
### not a heading inside a fence
\`\`\`

### X2 — Second thing
**S3** · **XS**
Body two.
## S3 — friction
### X3 — Third
No labels here.
# New capabilities
### N1 — Something new
Text.
`;

describe('markdown import', () => {
  const imp = ['S1 silently wrong', 'S2 visibly wrong', 'S3 friction', 'New capability'];
  const eff = ['XS', 'S', 'M', 'L'];

  it('splits at the most used heading level, keeps text verbatim, ignores fenced headings', () => {
    const { level, sections } = parseSections(doc);
    expect(level).toBe(3);
    expect(sections.map((s) => s.title)).toEqual(['X1 — First thing', 'X2 — Second thing', 'X3 — Third', 'N1 — Something new']);
    expect(sections[0].body).toContain('Why it matters.');
    expect(sections[0].body).toContain('### not a heading inside a fence');
    expect(sections[0].ancestors).toEqual(['Open work', 'S2 — visibly wrong']);
    expect(groupCounts(sections)).toEqual({ 'Open work › S2 — visibly wrong': 2, 'Open work › S3 — friction': 1, 'New capabilities': 1 });
  });

  it('reads importance and effort from the project labels', () => {
    const [x1, x2, x3, n1] = parseSections(doc).sections;
    expect(detectScales(x1, imp, eff)).toEqual({ importance: 2, effort: 3 });
    expect(detectScales(x2, imp, eff)).toEqual({ importance: 3, effort: 0 }); // bold S3 wins over the S2 parent
    expect(detectScales(x3, imp, eff)).toEqual({ importance: 3, effort: null }); // from the parent heading
    expect(detectScales(n1, imp, eff)).toEqual({ importance: 4, effort: null }); // "New capabilities" ~ "New capability"
    expect(detectScales(x3, ['Low', 'Medium', 'High', 'Critical'], eff)).toEqual({ importance: null, effort: null });
  });
});
