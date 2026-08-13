/**
 * Service worker: makes the app open and run in a basement gym with no signal.
 *
 * The shell and the shared logic modules are cached on install, so the phone
 * never needs the PC to start a workout — only to back one up.
 */

// Bump this on any shell change. A new value purges the old cache on activate,
// which is what actually delivers a fix to a phone that already installed the app.
const CACHE = 'trainer-v12';

const SHELL = [
  './',
  'index.html',
  'app.js',
  'db.js',
  'styles.css',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'lib/plates.js',
  'lib/strength.js',
  'lib/scheme.js',
  'lib/progression.js',
  'lib/plan.js',
  'lib/analysis.js',
  'lib/templates.js',
  'lib/bootstrap.js',
  'lib/quicklog.js',
  'lib/session.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The API is a sync channel, never a cache. Let it fail; the app expects that.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations fall back to the cached shell so the app always opens.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('index.html').then((r) => r ?? caches.match('./'))),
    );
    return;
  }

  // Network first, cache as the safety net.
  //
  // Cache first was faster but meant an updated app could sit undelivered on a
  // phone indefinitely: the old code kept being served from cache, so a fix
  // never arrived. Offline still works — the fetch fails instantly with no
  // connection and the cached copy answers.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request)),
  );
});
