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
      <ZoomImage src={src} alt={caption ?? ''} />
    </div>,
    document.body,
  );
}

const MAX_ZOOM = 6;

/**
 * The image at full size with its own zoom: pinch (two fingers), drag to move when zoomed,
 * double-tap to zoom in or out, and the mouse wheel on a computer. The page itself cannot zoom
 * (the app shell locks it), so this does it inside the viewer.
 */
function ZoomImage({ src, alt }: { src: string; alt: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 });
  const tRef = useRef(t);
  tRef.current = t;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; scale: number; mid: { x: number; y: number }; x: number; y: number } | null>(null);
  const lastTap = useRef(0);

  // keep the image inside the view: no panning past its edges
  const clamp = (n: { scale: number; x: number; y: number }) => {
    const scale = Math.min(MAX_ZOOM, Math.max(1, n.scale));
    const el = box.current;
    if (!el || scale === 1) return { scale: 1, x: 0, y: 0 };
    const maxX = (el.clientWidth * (scale - 1)) / 2;
    const maxY = (el.clientHeight * (scale - 1)) / 2;
    return { scale, x: Math.min(maxX, Math.max(-maxX, n.x)), y: Math.min(maxY, Math.max(-maxY, n.y)) };
  };
  /** zoom to `scale` keeping the point (cx, cy) (client coordinates) where it is */
  const zoomAt = (scale: number, cx: number, cy: number, from = tRef.current) => {
    const el = box.current!;
    const r = el.getBoundingClientRect();
    const px = cx - (r.left + r.width / 2);
    const py = cy - (r.top + r.height / 2);
    const k = scale / from.scale;
    return clamp({ scale, x: px - (px - from.x) * k, y: py - (py - from.y) * k });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const ps = [...pointers.current.values()];
    if (ps.length === 2) {
      const mid = { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 };
      gesture.current = { dist: Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y), scale: tRef.current.scale, mid, x: tRef.current.x, y: tRef.current.y };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const ps = [...pointers.current.values()];
    if (ps.length === 2 && gesture.current) {
      const g = gesture.current;
      const dist = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
      const mid = { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 };
      const zoomed = zoomAt(g.scale * (dist / g.dist), g.mid.x, g.mid.y, { scale: g.scale, x: g.x, y: g.y });
      setT(clamp({ ...zoomed, x: zoomed.x + mid.x - g.mid.x, y: zoomed.y + mid.y - g.mid.y }));
    } else if (ps.length === 1 && tRef.current.scale > 1) {
      setT(clamp({ ...tRef.current, x: tRef.current.x + e.clientX - prev.x, y: tRef.current.y + e.clientY - prev.y }));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
  };
  const onDoubleTap = (cx: number, cy: number) => setT(tRef.current.scale > 1 ? { scale: 1, x: 0, y: 0 } : zoomAt(2.5, cx, cy));

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setT(zoomAt(tRef.current.scale * Math.exp(-e.deltaY / 300), e.clientX, e.clientY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      ref={box}
      className="flex-1 min-h-0 overflow-hidden flex items-center justify-center p-2 select-none"
      style={{ touchAction: 'none' }}
      onClick={(e) => {
        // a tap on the picture or while zoomed must not close the viewer; a quick second tap zooms
        if (t.scale > 1 || e.target !== e.currentTarget) e.stopPropagation();
        const now = Date.now();
        if (now - lastTap.current < 300) onDoubleTap(e.clientX, e.clientY);
        lastTap.current = now;
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        data-zoom={t.scale.toFixed(2)}
        className="max-w-full max-h-full object-contain will-change-transform"
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`, transition: gesture.current || pointers.current.size ? 'none' : 'transform 0.15s ease-out' }}
      />
    </div>
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
