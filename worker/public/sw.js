// Offline support: the app shell is served network-first (so updates show up right away)
// with the cache as fallback; the last /api/status response is kept so the app still
// shows the most recent verdict when the phone is offline (e.g. on the ferry).

const CACHE = 'cg-v3';
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
