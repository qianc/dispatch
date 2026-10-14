import { useId, useState } from 'react';
import { cx, inputCls } from './ui.tsx';

/** Several free-text values (tags, modules) with suggestions from the project. Enter or comma adds. */
export function TokenInput({ label, value, onChange, suggestions, placeholder }: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  suggestions: string[];
  placeholder?: string;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const has = (t: string) => value.some((v) => v.toLowerCase() === t.toLowerCase());
  const add = (t: string) => {
    const clean = t.trim().replace(/,$/, '').trim();
    if (clean && !has(clean)) onChange([...value, clean]);
    setText('');
  };
  const q = text.trim().toLowerCase();
  const offered = suggestions.filter((s) => !has(s) && (!q || s.toLowerCase().includes(q))).slice(0, 12);
  const isNew = q && !suggestions.some((s) => s.toLowerCase() === q) && !has(q);

  return (
    <div className="mb-3" role="group" aria-labelledby={id}>
      <span id={id} className="block text-[13px] text-muted mb-1">{label}</span>
      <div className={cx(inputCls, 'flex flex-wrap items-center gap-1.5 py-1.5 min-h-10')}>
        {value.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded-md bg-raised text-fg text-[13px] h-7 pl-2 pr-1">
            {v}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== v))} className="text-muted px-1" aria-label={`Remove ${v}`}>✕</button>
          </span>
        ))}
        <input
          className="flex-1 min-w-24 bg-transparent outline-none text-fg placeholder:text-faint"
          value={text}
          placeholder={value.length ? '' : placeholder}
          aria-label={`Add ${label.toLowerCase()}`}
          onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value) : setText(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) {
              e.preventDefault();
              add(text);
            }
            if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => text.trim() && add(text)}
        />
      </div>
      {(offered.length > 0 || isNew) && (
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {isNew && (
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add(text)} className="rounded-md border border-accent/40 text-accent text-[12.5px] h-7 px-2">
              + “{text.trim()}”
            </button>
          )}
          {offered.map((s) => (
            <button key={s} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add(s)} className="rounded-md border border-line text-muted text-[12.5px] h-7 px-2 active:bg-raised">
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
