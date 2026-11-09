import { useState } from 'react';

/** A prompt longer than this (characters or lines) starts collapsed to a preview. */
const PREVIEW_CHARS = 280;
const PREVIEW_LINES = 6;

/** Which sessions' prompts are expanded, so moving between sessions does not reopen every prompt. This app run only. */
export const promptOpen = new Map<number, boolean>();

/** The first lines of a long prompt, cut at a word, with an ellipsis. */
function preview(text: string): string {
  const lines = text.split('\n').slice(0, PREVIEW_LINES).join('\n');
  if (lines.length <= PREVIEW_CHARS) return lines + '…';
  const cut = lines.slice(0, PREVIEW_CHARS);
  const space = cut.lastIndexOf(' ');
  return (space > PREVIEW_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

/** The prompt a session started with, in the side panel (DISP-66): as written, collapsed when long. */
export function SessionPrompt({ sessionId, text }: { sessionId: number; text: string }) {
  const [open, setOpen] = useState(() => promptOpen.get(sessionId) ?? false);
  const long = text.length > PREVIEW_CHARS || text.split('\n').length > PREVIEW_LINES;
  const toggle = () => {
    promptOpen.set(sessionId, !open);
    setOpen(!open);
  };
  return (
    <div>
      <h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted mb-1.5">Prompt</h2>
      <p className="whitespace-pre-wrap break-words">{long && !open ? preview(text) : text}</p>
      {long && (
        <button type="button" onClick={toggle} aria-expanded={open} className="mt-1 text-accent hover:underline underline-offset-2">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
