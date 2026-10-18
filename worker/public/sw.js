// Service worker: shows the Worker's push messages as 通勤哨兵 notifications (with the open
// problem count on the home-screen icon), and keeps the app usable offline — the app shell is
// served network-first with the cache as fallback, and the last /api/status response is kept
// so the most recent verdict still shows on the ferry without signal.

const CACHE = 'cg-v4';
const SHELL = [
  '/',
  '/setup',
  '/app.css',
  '/api.js',
  '/app.js',
  '/setup.js',
  '/shared/schedule.mjs',
  '/shared/time.mjs',
  '/shared/transitous.mjs',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const cacheable = !url.pathname.startsWith('/api/') || url.pathname === '/api/status';
  if (!cacheable) return;
  // `no-cache` makes the browser revalidate (cheap 304s) so a redeploy reaches the phone at once.
  const fresh = e.request.mode === 'navigate' ? fetch(e.request) : fetch(e.request, { cache: 'no-cache' });
  e.respondWith(
    fresh
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});

// Payload from worker/src/notify.js: { title, body, tag, badge, url }.
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data?.json() ?? {};
  } catch {
    d = { body: e.data?.text() ?? '' };
  }
  const jobs = [
    // A tag makes "已恢复" replace the alert it resolves instead of piling up.
    self.registration.showNotification(d.title || '通勤哨兵', {
      body: d.body || '',
      tag: d.tag || undefined,
      renotify: Boolean(d.tag),
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: d.url || '/' },
    }),
  ];
  if (typeof d.badge === 'number' && self.navigator.setAppBadge) {
    jobs.push(d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge());
  }
  e.waitUntil(
    Promise.all(jobs).then(async () => {
      for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage('refresh');
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => 'focus' in c);
      if (open) {
        open.postMessage('refresh');
        return open.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
