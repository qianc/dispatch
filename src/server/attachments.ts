// Images kept as files: from agent tool results under DATA_DIR/attachments/<session>/, and images
// added to items under DATA_DIR/attachments/items/<item>/.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

  /** The image type from the file's first bytes; null if it is not PNG, JPEG, GIF or WebP. */
  static sniff(data: Buffer): string | null {
    if (data.length < 12) return null;
    if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
    if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
    if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
  }

  /** Store an item image. The type comes from the content, never from the name or header. */
  saveItemImage(itemId: number, data: Buffer): { file: string; mime: string } | null {
    const mime = Attachments.sniff(data);
    if (!mime) return null;
    const file = `${randomUUID()}.${EXT[mime]}`;
    mkdirSync(join(this.dir, 'items', String(itemId)), { recursive: true });
    writeFileSync(join(this.dir, 'items', String(itemId), file), data);
    return { file, mime };
  }

  async readItemImage(itemId: number, file: string): Promise<Buffer | null> {
    if (!/^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/.test(file)) return null;
    try {
      return await readFile(join(this.dir, 'items', String(itemId), file));
    } catch {
      return null;
    }
  }

  deleteItemImage(itemId: number, file: string) {
    if (/^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/.test(file)) rmSync(join(this.dir, 'items', String(itemId), file), { force: true });
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
