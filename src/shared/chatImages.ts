// Images the owner pastes into a chat (DISP-34). The message to the agent names each one with a
// marker; the worker swaps the marker for the image itself (fetched from the server), and keeps
// the marker text so the agent can name the image to attach it to an item.

/** The largest image the owner may paste or a session may attach from its checkout (DISP-74). */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** The image type from the file's first bytes; null if it is not PNG, JPEG, GIF or WebP. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  const starts = (at: number, bytes: number[] | string) => [...(typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes))].every((c, i) => b[at + i] === c.charCodeAt(0));
  if (starts(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts(0, 'GIF8')) return 'image/gif';
  if (starts(0, 'RIFF') && starts(8, 'WEBP')) return 'image/webp';
  return null;
}

export const CHAT_IMAGE_FILE = /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;
const MARKER = /\[pasted image ([0-9a-f-]{36}\.(?:png|jpg|gif|webp))\]/g;
const TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export function chatImageMarker(file: string) {
  return `[pasted image ${file}]`;
}

/** The message text for the agent: the owner's text, then one marker per image. */
export function withImageMarkers(text: string, files: string[]) {
  return files.length ? `${text}${text ? '\n\n' : ''}${files.map(chatImageMarker).join('\n')}` : text;
}

/** The image files a message names. */
export function imageMarkers(text: string): string[] {
  return [...text.matchAll(MARKER)].map((m) => m[1]);
}

export function chatImageType(file: string) {
  return TYPE[file.split('.').pop() ?? ''] ?? 'application/octet-stream';
}
