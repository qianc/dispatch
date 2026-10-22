import webpush from 'web-push';
import type { Bus } from './bus.ts';
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

/** How long a device's "the app is in focus" lasts without a renewal (the app renews it every 20 s). */
const ACTIVE_FOR_MS = 45_000;

export class Notifier {
  readonly publicKey: string;
  /** Last notices, for tests and the debug endpoint. */
  readonly sent: Notice[] = [];
  private store: Store;
  private bus: Bus;
  /** Devices (push endpoints) that have the app in focus, until when. */
  private active = new Map<string, number>();

  constructor(cfg: Config, db: Db, store: Store, bus: Bus) {
    this.store = store;
    this.bus = bus;
    let keys = { publicKey: process.env.VAPID_PUBLIC_KEY ?? '', privateKey: process.env.VAPID_PRIVATE_KEY ?? '' };
    if (!keys.publicKey || !keys.privateKey) {
      const saved = db.setting('vapid');
      keys = saved ? JSON.parse(saved) : webpush.generateVAPIDKeys();
      db.setSetting('vapid', JSON.stringify(keys));
    }
    webpush.setVapidDetails(cfg.vapidSubject, keys.publicKey, keys.privateKey);
    this.publicKey = keys.publicKey;
  }

  /** A device says whether the app has focus there: while it has, it gets no system notification. */
  setActive(endpoint: string, active: boolean) {
    if (active && this.store.pushSubscriptions().some((s) => s.endpoint === endpoint)) this.active.set(endpoint, Date.now() + ACTIVE_FOR_MS);
    else this.active.delete(endpoint);
  }

  activeCount() {
    const now = Date.now();
    for (const [endpoint, until] of this.active) if (until <= now) this.active.delete(endpoint);
    return this.active.size;
  }

  /** Sends one push; tests replace it. */
  deliver = async (endpoint: string, keys: { p256dh: string; auth: string }, payload: string) => {
    await webpush.sendNotification({ endpoint, keys }, payload, { TTL: 3600 });
  };

  async send(n: Notice) {
    if (n.project_id && this.store.isMuted(n.project_id)) return;
    this.sent.push(n);
    if (this.sent.length > 50) this.sent.shift();
    const notice = { title: n.title, body: n.body, url: n.url, tag: n.tag };
    // open apps show it themselves; devices with the app in focus get no system notification
    this.bus.emit({ t: 'notice', notice });
    this.activeCount(); // drops expired focus
    const payload = JSON.stringify(notice);
    await Promise.all(
      this.store.pushSubscriptions().filter((s) => !this.active.has(s.endpoint)).map(async (s) => {
        try {
          await this.deliver(s.endpoint, { p256dh: s.p256dh, auth: s.auth }, payload);
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) {
            this.store.removePushSubscription(s.endpoint);
            this.active.delete(s.endpoint);
          }
          else console.warn('push failed', code, (e as Error).message);
        }
      }),
    );
  }
}
