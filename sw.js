/**
 * sw.js - offline shell.
 *
 * Deliberately narrow. It touches same-origin GETs only: rate responses are cross-origin and would
 * come back opaque, so caching them would store an unreadable body forever and mask the app's own
 * staleness logic. Rate caching belongs in localStorage where the payload can be validated and
 * timestamped. Versioning the cache name and sweeping every other cache on activate prevents the
 * stale-forever bug where an old shell is served indefinitely.
 */
const CACHE = 'fxcalc-v1';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './state.js', './views.js',
  './calc.js', './instruments.js', './rates.js', './format.js',
  './manifest.webmanifest', './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;   // never touch the rate feed

  event.respondWith(
    caches.match(request).then((hit) => {
      // Serve the cache immediately, then quietly refresh it for next time.
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
