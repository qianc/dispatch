import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.ts';

interface Pasted { id: number; preview: string; file: string | null; error: string | null }

const MAX_EDGE = 2000; // Claude scales larger images down anyway
const MAX_BYTES = 3_500_000; // stays under Claude's per-image limit once base64-encoded

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

/** A phone screenshot can be large: scale it to what Claude can take. GIFs stay as they are. */
async function shrink(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= MAX_BYTES) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  let blob = file.type === 'image/png' ? await toBlob(canvas, 'image/png') : null;
  if (!blob || blob.size > MAX_BYTES) blob = await toBlob(canvas, 'image/jpeg', 0.88);
  return blob ?? file;
}

async function upload(sessionId: number, blob: Blob): Promise<string> {
  const res = await fetch(`/api/sessions/${sessionId}/images`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': blob.type.startsWith('image/') ? blob.type : 'application/octet-stream' },
    body: blob,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return (data as { file: string }).file;
}

/**
 * Images pasted into a chat (DISP-34), uploaded at once so sending stays quick. `files`: the
 * uploaded ones, to name in the message; `clear` after it is sent.
 */
export function useChatImages(sessionId: number) {
  const [list, setList] = useState<Pasted[]>([]);
  const next = useRef(1);
  const live = useRef(list);
  live.current = list;
  useEffect(() => () => live.current.forEach((p) => URL.revokeObjectURL(p.preview)), []);

  const add = (files: File[]) => {
    for (const f of files.slice(0, 10)) {
      const id = next.current++;
      const preview = URL.createObjectURL(f);
      setList((l) => [...l, { id, preview, file: null, error: null }]);
      shrink(f)
        .then((b) => upload(sessionId, b))
        .then((file) => setList((l) => l.map((p) => (p.id === id ? { ...p, file } : p))))
        .catch((e) => setList((l) => l.map((p) => (p.id === id ? { ...p, error: (e as Error).message } : p))));
    }
  };
  const remove = (id: number) => setList((l) => {
    const gone = l.find((p) => p.id === id);
    if (gone) URL.revokeObjectURL(gone.preview);
    return l.filter((p) => p.id !== id);
  });
  const clear = () => setList((l) => {
    l.forEach((p) => URL.revokeObjectURL(p.preview));
    return [];
  });
  const uploading = list.some((p) => !p.file && !p.error);
  const files = list.flatMap((p) => (p.file ? [p.file] : []));

  const view = list.length ? (
    <div className="flex gap-2 overflow-x-auto pb-2" aria-label="Images to send">
      {list.map((p) => (
        <div key={p.id} className="relative shrink-0">
          <img src={p.preview} alt="Pasted image" className={`h-16 w-16 rounded-lg object-cover border ${p.error ? 'border-bad opacity-50' : 'border-line'} ${!p.file && !p.error ? 'animate-pulse' : ''}`} title={p.error ?? undefined} />
          <button type="button" onClick={() => remove(p.id)} aria-label="Remove image" className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-raised border border-line text-[11px] leading-none flex items-center justify-center">✕</button>
          {p.error && <span className="absolute bottom-0.5 left-0.5 right-0.5 text-[10px] text-bad bg-bg/80 rounded px-0.5 truncate">failed</span>}
        </div>
      ))}
    </div>
  ) : null;

  return { add, clear, files, uploading, view, error: list.find((p) => p.error)?.error ?? null };
}
