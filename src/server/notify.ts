import webpush from 'web-push';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Store } from './store.ts';

export interface Notice {
  title: string;
  body: string;
  url: string;
  tag?: string;
  project_id?: number;
}

export class Notifier {
  readonly publicKey: string;
  /** Last notices, for tests and the debug endpoint. */
  readonly sent: Notice[] = [];
  private store: Store;

  constructor(cfg: Config, db: Db, store: Store) {
    this.store = store;
    let keys = { publicKey: process.env.VAPID_PUBLIC_KEY ?? '', privateKey: process.env.VAPID_PRIVATE_KEY ?? '' };
    if (!keys.publicKey || !keys.privateKey) {
      const saved = db.setting('vapid');
      keys = saved ? JSON.parse(saved) : webpush.generateVAPIDKeys();
      db.setSetting('vapid', JSON.stringify(keys));
    }
    webpush.setVapidDetails(cfg.vapidSubject, keys.publicKey, keys.privateKey);
    this.publicKey = keys.publicKey;
  }

  async send(n: Notice) {
    if (n.project_id && this.store.isMuted(n.project_id)) return;
    this.sent.push(n);
    if (this.sent.length > 50) this.sent.shift();
    const payload = JSON.stringify({ title: n.title, body: n.body, url: n.url, tag: n.tag });
    await Promise.all(
      this.store.pushSubscriptions().map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) this.store.removePushSubscription(s.endpoint);
          else console.warn('push failed', code, (e as Error).message);
        }
      }),
    );
  }
}
