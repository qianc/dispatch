import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chipBefore, deleteChip, filterProjects, insertMention, mentionAt, moveActive, segments, taggedKeys, type MentionProject } from '../web/src/mentions.ts';
import { stubBrowser, textOf } from './web-render.ts';

const PROJECTS: MentionProject[] = [
  { key: 'HC', name: 'Home cache', color: null, icon: null },
  { key: 'DECK', name: 'Decks', color: null, icon: null },
  { key: 'DISP', name: 'Dispatch', color: null, icon: null },
];
const KEYS = new Set(PROJECTS.map((p) => p.key));

describe('@ tags a project in the Assistant chat (DISP-82)', () => {
  it('opens on an @ at the start or after a space, with what was typed after it', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('Add a bug to @h', 15)).toEqual({ start: 13, query: 'h' });
    // not in a mail address, and closed after a space
    expect(mentionAt('mail me@h', 9)).toBeNull();
    expect(mentionAt('to @HC now', 10)).toBeNull();
  });

  it('narrows the list as letters are typed: by key, then by name', () => {
    expect(filterProjects(PROJECTS, '').map((p) => p.key)).toEqual(['DECK', 'DISP', 'HC']);
    expect(filterProjects(PROJECTS, 'd').map((p) => p.key)).toEqual(['DECK', 'DISP']);
    expect(filterProjects(PROJECTS, 'dis').map((p) => p.key)).toEqual(['DISP']);
    expect(filterProjects(PROJECTS, 'cache').map((p) => p.key)).toEqual(['HC']);
    expect(filterProjects(PROJECTS, 'zz')).toEqual([]);
  });

  it('arrow keys move round the list, and choosing puts @KEY and a space in place of what was typed', () => {
    expect(moveActive(0, 1, 3)).toBe(1);
    expect(moveActive(2, 1, 3)).toBe(0);
    expect(moveActive(0, -1, 3)).toBe(2);
    const typed = 'Add a bug to @ho';
    expect(insertMention(typed, typed.length, 13, 'HC')).toEqual({ text: 'Add a bug to @HC ', caret: 17 });
    // in the middle of the text: no double space, the caret after the space
    expect(insertMention('to @h please', 5, 3, 'HC')).toEqual({ text: 'to @HC please', caret: 7 });
  });

  it('Backspace at the end of a tag deletes all of it', () => {
    expect(chipBefore('to @HC', 6, KEYS)).toEqual({ start: 3, end: 6 });
    expect(deleteChip('to @HC', 6, KEYS)).toEqual({ text: 'to ', caret: 3 });
    expect(deleteChip('@DECK and @HC now', 5, KEYS)).toEqual({ text: ' and @HC now', caret: 0 });
    // not at its end, or not a project: a normal Backspace
    expect(deleteChip('to @HC ', 7, KEYS)).toBeNull();
    expect(deleteChip('to @HC', 5, KEYS)).toBeNull();
    expect(deleteChip('to @NOPE', 8, KEYS)).toBeNull();
  });

  it('an @ with no matching project stays plain text, with no chip and no key', () => {
    const text = 'Ask @HC and @NOPE, mail me@DECK, @HC again and @DECK';
    expect(taggedKeys(text, KEYS)).toEqual(['HC', 'DECK']);
    expect(segments(text, KEYS)).toEqual([
      { text: 'Ask ' }, { text: '@HC', key: 'HC' }, { text: ' and @NOPE, mail me@DECK, ' }, { text: '@HC', key: 'HC' },
      { text: ' again and ' }, { text: '@DECK', key: 'DECK' },
    ]);
    expect(segments(text, KEYS).map((s) => s.text).join('')).toBe(text);
  });

  describe('on screen', () => {
    beforeEach(stubBrowser);
    afterEach(() => vi.unstubAllGlobals());

    it('lists each project with its badge, key and name, the active one selected', async () => {
      const { MentionList } = await import('../web/src/components/ChatInput.tsx');
      const html = renderToStaticMarkup(createElement(MentionList, { options: PROJECTS.slice(0, 2), active: 1, onChoose: () => {} }));
      expect(textOf(html)).toBe('H HC Home cache D DECK Decks');
      expect(html.match(/aria-selected="(true|false)"/g)).toEqual(['aria-selected="false"', 'aria-selected="true"']);
      expect(html).toContain('min-h-11'); // large enough to tap
    });

    it('shows a tag in the box as a chip', async () => {
      const { ChatInput } = await import('../web/src/components/ChatInput.tsx');
      const html = renderToStaticMarkup(createElement(ChatInput, { value: 'Bug in @HC and @NOPE', onChange() {}, onSubmit() {}, projects: PROJECTS }));
      expect(html.match(/data-chip="[A-Z]+"/g)).toEqual(['data-chip="HC"']);
      expect(html).toContain('role="combobox"');
      // without projects (every other chat): a plain box
      const plain = renderToStaticMarkup(createElement(ChatInput, { value: 'Bug in @HC', onChange() {}, onSubmit() {} }));
      expect(plain).not.toContain('data-chip');
      expect(plain).not.toContain('combobox');
    });
  });
});
