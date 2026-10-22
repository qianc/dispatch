/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
try {
  // server pages, not the app shell: /signin must reach the network so a sign-in proxy can show its
  // login; /authorize is the OAuth consent page for connected apps
  registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//, /^\/signin/, /^\/authorize/, /^\/\.well-known\//, /^\/mcp/] }));
} catch {
  // dev mode: index.html is not precached
}

self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? { title: 'Dispatch', body: '' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      data: { url: data.url ?? '/' },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    }),
  );
});

/** Asks an open window to show `url` with its own router (no reload); true when it answered. */
function askToNavigate(c: WindowClient, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(false), 1500);
    ch.port1.onmessage = () => {
      clearTimeout(t);
      resolve(true);
    };
    c.postMessage({ type: 'navigate', url }, [ch.port2]);
  });
}

// open the chat the notification is about: in the app's window if it is open (focused first), else a new one
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const all = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) as WindowClient[];
      const c = all.find((w) => w.focused) ?? all.find((w) => w.visibilityState === 'visible') ?? all[0];
      if (!c) return self.clients.openWindow(url);
      const focused = await c.focus().catch(() => c);
      if (await askToNavigate(focused, url)) return;
      // a window without the message listener (an old version): load the page
      const moved = await focused.navigate(url).catch(() => null);
      if (!moved) await self.clients.openWindow(url);
    })(),
  );
});
