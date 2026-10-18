// Hält die Web-App auf Tablets auch ohne Internet startbereit.
// Erst das Netz (damit immer die neueste Fassung kommt), ohne Netz die zuletzt geladene.
const CACHE = 'nexray-prompter-v2';
const FILES = [
  './', 'index.html', 'display.html', 'style.css', 'manifest.webmanifest',
  'app.js', 'align.js', 'camera.js', 'dialogs.js', 'display.js', 'i18n.js', 'import.js',
  'library.js', 'plan.js', 'schedule.js', 'speakers.js', 'speech.js', 'storage.js', 'tags.js',
  'translations.js', 'coach.js', 'license-config.js',
  'build/icon-64.png', 'build/icon-192.png', 'build/icon-512.png', 'build/icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Nur eigene Dateien; die großen Sprachmodelle und fremde Server bleiben außen vor.
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/vendor/models/')) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});
