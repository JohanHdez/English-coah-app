// App-shell cache, plus vendor/ in a cache of its own. Hugging Face's model
// weights are cached by transformers.js itself (env.useBrowserCache). vendor/
// (transformers.js, the 12.9 MB ONNX Runtime WASM and pdf.js with its worker) is not precached — it is
// needed only once enrollment, a meeting or a PDF runs — but the first time any of it
// is fetched it is kept, cache-first, under VENDOR_CACHE: otherwise every new
// embed worker depends on the browser's HTTP cache, which a static host's short
// max-age makes revalidate, and an evicted WASM downloads again on mobile data.
// The files never change under one name; replacing vendor/ means bumping
// VENDOR_CACHE. Provider responses must never be cached (they carry the meeting's
// transcript): the fetch handler writes only the exact SHELL_FILES URLs and
// same-origin GETs under vendor/; every other request is left to the network.
const CACHE_NAME = 'ec-shell-v9';
const VENDOR_CACHE = 'ec-vendor-v1';
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
  'live-lane.js',
  'live-translate.js',
  'preview-worker.js',
  'enroll-text.js',
  'transcribe.js',
  'providers.js',
  'coachdata.js',
  'docs-extract.js',
  'docs-record.js',
  'recorder-worklet.js',
  'ui/consent.js',
  'ui/settings.js',
  'ui/enroll.js',
  'ui/meeting.js',
  'ui/coach.js',
  'ui/documents.js',
  'ui/report.js',
  'lib/coach.js',
  'lib/markdown.js',
  'lib/phrasebook.js',
  'lib/passages.js',
  'lib/live.js',
  'lib/segmenter.js',
  'lib/stitch.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
];
// Resolved the same way `cache.addAll` resolves them, so a request's exact URL can
// be checked against this set without re-deriving the relative path from a URL.
const SHELL_URLS = new Set(SHELL_FILES.map((path) => new URL(path, self.location.href).href));
const VENDOR_PREFIX = new URL('vendor/', self.location.href).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => (name.startsWith('ec-shell-') && name !== CACHE_NAME) || (name.startsWith('ec-vendor-') && name !== VENDOR_CACHE))
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (request.url.startsWith(VENDOR_PREFIX) && !request.headers.has('range')) {
    event.respondWith(vendorFirst(event));
    return;
  }
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

async function vendorFirst(event) {
  const { request } = event;
  const cache = await caches.open(VENDOR_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.status === 200 && response.type === 'basic') {
    event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
  }
  return response;
}
