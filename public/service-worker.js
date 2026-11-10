// Offline cache for the English Hub landing page.
//
//   install    precache the shell plus the six card screenshots
//   activate   drop caches from earlier versions and take over open tabs
//   fetch      pages: network first, cached page when offline
//              assets: cache first, refreshed in the background
//
// Analytics (/api/*) and the admin dashboard (/admin) are never intercepted,
// so they always talk to the network and never serve a stale response.

const VERSION = 'v4';
const CACHE = `english-hub-${VERSION}`;

const CORE_ASSETS = [
  '/',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/favicon.png',
  '/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/images/english-martin-logo.webp',
  '/images/english-martin-mark.webp',
  '/images/speak-britain.webp',
  '/images/wordy-world.webp',
  '/images/word-wizards.webp',
  '/images/wordlab-ks3.webp',
  '/images/conversation-club.webp',
  '/images/band-nine.webp',
  '/images/qr-android.png',
  '/images/qr-ios.png',
];

const OFFLINE_URL = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Cache each file on its own so one bad response cannot fail the install.
      await Promise.all(
        CORE_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {}),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    const fallback = await cache.match(OFFLINE_URL);
    if (fallback) return fallback;
    return new Response('Offline', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) {
    // Refresh quietly for the next visit; the current one stays instant.
    fetch(request)
      .then((response) => {
        if (response && response.ok) cache.put(request, response.clone());
      })
      .catch(() => {});
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    return cached || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // fonts, Statcounter: network only
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return;

  event.respondWith(
    request.mode === 'navigate' ? networkFirst(request) : cacheFirst(request),
  );
});
