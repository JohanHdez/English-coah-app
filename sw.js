// App-shell cache only. Model files (vendor/, Hugging Face) are cached by
// transformers.js itself (large, content-addressed, fetched on demand) and Groq
// responses must never be cached (they carry the meeting's audio transcript), so the
// fetch handler below writes to the cache only for the exact URLs in SHELL_FILES —
// every other same-origin GET is left for the browser to fetch normally, uncached.
const CACHE_NAME = 'ec-shell-v2';
const SHELL_FILES = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'store.js',
  'translate.js',
  'bubbles.js',
  'enroll-audio.js',
  'capture.js',
  'session.js',
  'speaker.js',
  'embed.js',
  'embed-worker.js',
  'enroll-text.js',
  'transcribe.js',
  'recorder-worklet.js',
  'ui/consent.js',
  'ui/settings.js',
  'ui/enroll.js',
  'ui/meeting.js',
  'lib/live.js',
  'lib/segmenter.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
];
// Resolved the same way `cache.addAll` resolves them, so a request's exact URL can
// be checked against this set without re-deriving the relative path from a URL.
const SHELL_URLS = new Set(SHELL_FILES.map((path) => new URL(path, self.location.href).href));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((name) => name.startsWith('ec-shell-') && name !== CACHE_NAME).map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (!SHELL_URLS.has(request.url)) return; // not part of the shell: normal network fetch, never cached

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request))
  );
});
