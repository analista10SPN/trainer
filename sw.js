/**
 * Service worker: makes the app open and run in a basement gym with no signal.
 *
 * The shell and the shared logic modules are cached on install, so the phone
 * never needs the PC to start a workout — only to back one up.
 */

// Bump this on any shell change. A new value purges the old cache on activate,
// which is what actually delivers a fix to a phone that already installed the app.
const CACHE = 'trainer-v80';

const SHELL = [
  './',
  'index.html',
  'app.js',
  'db.js',
  'styles.css',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',

  /*
   * The typeface, precached with the shell rather than left to `font-display:
   * swap` to fetch on demand.
   *
   * `swap` means the page renders in the fallback and reflows when the font
   * lands — which on a phone with no signal means it never lands, and the app
   * permanently wears the system stack. These six files are 96 KB in total,
   * about one icon's worth, and they are the only thing in the shell whose
   * absence changes how everything reads rather than whether anything works.
   */
  'fonts/barlow-400.woff2',
  'fonts/barlow-500.woff2',
  'fonts/barlow-600.woff2',
  'fonts/barlow-700.woff2',
  'fonts/barlow-condensed-600.woff2',
  'fonts/barlow-condensed-700.woff2',
  'lib/plates.js',
  'lib/strength.js',
  'lib/scheme.js',
  'lib/progression.js',
  'lib/plan.js',
  'lib/adapt.js',
  'lib/analysis.js',
  'lib/audit.js',
  'lib/coverage.js',
  'lib/templates.js',
  'lib/intake.js',
  'lib/experience.js',
  'lib/prescribe.js',
  'lib/testweek.js',
  'lib/norms.js',
  'lib/schedule.js',
  'lib/bootstrap.js',
  'lib/quicklog.js',
  'lib/session.js',
  'lib/calendar.js',
  'lib/exercises.js',
  'lib/cleanup.js',
  'lib/progress.js',
  'lib/checkin.js',
  'lib/chart.js',
  'lib/recovery.js',
  'lib/superset.js',
  'lib/gyms.js',
  'lib/tempo.js',
  'lib/week.js',
  'lib/profiles.js',
  'lib/clientview.js',
  'lib/level.js',
  'lib/units.js',
  'lib/analytics.js',
  'lib/liftnotes.js',
  'lib/i18n.js',
  'lib/draft.js',
  'lib/messages/en.js',
  'lib/messages/es.js',
  'lib/coachpayload.js',
  'lib/report.js',
  'lib/repository.js',
  'lib/recall.js',
  'lib/poses.js',
  'lib/roles.js',
  'lib/nutrition.js',
  'lib/aids.js',
  'lib/metrics.js',
  'lib/energy.js',
  'lib/diagnose.js',
  'lib/summary.js',
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
