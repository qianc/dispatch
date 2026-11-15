// The title of an orchestration (DISP-110): a model writes a short one from the goal when it is
// created. Until then, and when that fails, it is the first words of the goal.

export const TITLE_MAX = 60;

/** The title an orchestration has before a model named it: the start of its goal. */
export function firstWordsTitle(goal: string): string {
  return goal.split('\n')[0].slice(0, TITLE_MAX);
}

const TRAILING = /[\s.,;:!?…·–—-]+$/;

/**
 * A model's answer as a title: its first line, without quotes, markdown marks, a "Title:" label and
 * end punctuation, and at most TITLE_MAX characters (cut at a word). Null: nothing usable.
 */
export function cleanTitle(raw: string): string | null {
  let t = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  t = t.replace(/^[#>*\-\s]+/, '').replace(/^title\s*:\s*/i, '');
  t = t.replace(/[*_`"“”„«»]/g, '').replace(/\s+/g, ' ').trim();
  // quotes around it and punctuation after it, in any order ('Title.' and 'Title'.)
  for (let before = ''; before !== t;) {
    before = t;
    t = t.replace(TRAILING, '').replace(/^['‘’]+|['‘’]+$/g, '').trim();
  }
  if (t.length > TITLE_MAX) {
    const cut = t.slice(0, TITLE_MAX + 1);
    const space = cut.lastIndexOf(' ');
    t = (space > TITLE_MAX / 2 ? cut.slice(0, space) : t.slice(0, TITLE_MAX)).replace(TRAILING, '');
  }
  return t || null;
}
