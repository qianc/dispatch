// Images from agent tool results, kept as files under DATA_DIR/attachments/<session>/.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export class Attachments {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'attachments');
  }

  save(sessionId: number, images: { media_type: string; data: string }[]) {
    return images.flatMap((img) => {
      const ext = EXT[img.media_type];
      if (!ext) return [];
      const name = `${randomUUID()}.${ext}`;
      mkdirSync(join(this.dir, String(sessionId)), { recursive: true });
      writeFileSync(join(this.dir, String(sessionId), name), Buffer.from(img.data, 'base64'));
      return [{ url: `/api/sessions/${sessionId}/attachments/${name}`, media_type: img.media_type }];
    });
  }

  /** null for names that are not ours (no path tricks). */
  async read(sessionId: number, name: string): Promise<{ type: string; data: Buffer } | null> {
    const m = name.match(/^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/);
    if (!m) return null;
    try {
      return { type: TYPE[m[1]], data: await readFile(join(this.dir, String(sessionId), name)) };
    } catch {
      return null;
    }
  }
}
