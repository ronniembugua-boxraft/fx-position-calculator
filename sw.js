/**
 * sw.js - offline shell.
 *
 * Deliberately narrow. It touches same-origin GETs only: rate responses are cross-origin and would
 * come back opaque, so caching them would store an unreadable body forever and mask the app's own
 * staleness logic. Rate caching belongs in localStorage where the payload can be validated and
 * timestamped.
 *
 * TWO THINGS THAT MAKE A SHELL GO STALE FOREVER, both fixed here:
 *
 * 1. A plain `fetch(request)` inside a worker is still served by the browser's HTTP cache. On a
 *    host that sets `max-age=600` (GitHub Pages does) the revalidation hands back the very bytes
 *    already cached, so a stale-while-revalidate loop re-stores the stale copy on every visit and
 *    never converges. Revalidation must use `cache: 'no-cache'` to force a conditional request.
 *
 * 2. Serving the HTML itself cache-first pins users to an old document that references old assets.
 *    Navigations are network-first with a cache fallback, so an online visitor always gets the
 *    current page and an offline one still gets the app.
 *
 * Bump CACHE on release: a changed worker byte-stream re-runs install, and activate sweeps every
 * other cache, which is what recovers clients already holding an old shell.
 */
const CACHE = 'fxcalc-v2';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './state.js', './views.js',
  './calc.js', './instruments.js', './rates.js', './format.js',
  './manifest.webmanifest', './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // no-cache so a fresh install cannot precache whatever the HTTP cache happens to hold
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Store a response only if it is a real same-origin 200. */
function put(request, response) {
  if (response && response.status === 200 && response.type === 'basic') {
    const copy = response.clone();
    caches.open(CACHE).then((c) => c.put(request, copy));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;   // never touch the rate feed

  // Navigations: network-first, so the document is never a version behind while online.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => put(request, res))
        .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html'))),
    );
    return;
  }

  // Assets: serve the cache immediately, then genuinely revalidate for next time.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request, { cache: 'no-cache' })
        .then((res) => put(request, res))
        .catch(() => hit);
      return hit || network;
    }),
  );
});
