// Images the owner pastes into a chat (DISP-34). The message to the agent names each one with a
// marker; the worker swaps the marker for the image itself (fetched from the server), and keeps
// the marker text so the agent can name the image to attach it to an item.

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
