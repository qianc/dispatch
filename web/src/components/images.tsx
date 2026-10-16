import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ItemImage } from '../api.ts';
import { cx } from './ui.tsx';

/** Full-screen image, tap anywhere to close. With `onDelete`, a Delete button. */
export function Lightbox({ src, onClose, caption, onDelete }: { src: string; onClose: () => void; caption?: string; onDelete?: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col pt-safe pb-safe" role="dialog" aria-label="Image" onClick={onClose}>
      <div className="flex justify-between items-center gap-3 px-3 h-12 shrink-0 text-white">
        <a href={src} target="_blank" rel="noreferrer" className="text-[13px] text-accent shrink-0" onClick={(e) => e.stopPropagation()}>Open original ↗</a>
        {caption && <span className="text-[13px] text-white/70 truncate">{caption}</span>}
        <span className="flex items-center gap-1 shrink-0">
          {onDelete && (
            <button className="text-[13px] text-bad px-2 h-8" onClick={(e) => { e.stopPropagation(); if (confirm('Delete this image?')) onDelete(); }}>Delete</button>
          )}
          <button className="text-xl px-2" aria-label="Close">✕</button>
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-2" style={{ touchAction: 'pinch-zoom' }}>
        <img src={src} alt={caption ?? ''} className="max-w-full max-h-full object-contain" onClick={(e) => e.stopPropagation()} />
      </div>
    </div>,
    document.body,
  );
}

/** Thumbnails of an item's images; tap one for full size (and Delete, when allowed). */
export function ImageStrip({ images, onDelete, className }: { images: ItemImage[]; onDelete?: (img: ItemImage) => void; className?: string }) {
  const [open, setOpen] = useState<ItemImage | null>(null);
  if (!images.length) return null;
  return (
    <div className={cx('flex flex-wrap gap-2', className)}>
      {images.map((img) => (
        <button key={img.id} onClick={() => setOpen(img)} className="rounded-lg overflow-hidden border border-line bg-raised" aria-label={`Show image ${img.name}`}>
          <img src={img.url} alt={img.name} loading="lazy" className="h-24 max-w-[60vw] sm:max-w-64 object-cover" />
        </button>
      ))}
      {open && (
        <Lightbox
          src={open.url}
          caption={`${open.name} · ${open.author}`}
          onClose={() => setOpen(null)}
          onDelete={onDelete && (() => { onDelete(open); setOpen(null); })}
        />
      )}
    </div>
  );
}

/** "Add image" button: the photo library or camera on a phone, a file picker on a computer. */
export function AddImageButton({ onFiles, busy, label = 'Add image' }: { onFiles: (files: File[]) => void; busy?: boolean; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[13px] font-medium bg-raised border border-line active:bg-line disabled:opacity-50"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
          <path d="M3 6.5h4l1.5-2h7l1.5 2h4v12H3z" /><circle cx="12" cy="12.5" r="3.5" />
        </svg>
        {busy ? 'Uploading…' : label}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** Images pasted anywhere on the page (a screenshot on the clipboard), unless typing in a field. */
export function usePastedImages(onFiles: (files: File[]) => void, enabled = true) {
  const cb = useRef(onFiles);
  cb.current = onFiles;
  useEffect(() => {
    if (!enabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      cb.current(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i}.${f.type.split('/')[1] || 'png'}`, { type: f.type }))));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [enabled]);
}
