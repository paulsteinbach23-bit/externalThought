const CACHE = 'memo-v21';
const PRECACHE = [
  './index.html',
  './style.css',
  './app.js',
  './sync.js',
  './canvas.js',
  './config.js',
  './vendor/supabase.js',
  './icon_ET.png',
  './manifest.json',
];

self.addEventListener('install', e => {
  // Individual adds (not addAll) so one missing optional asset (e.g. config.js
  // on a device without it yet) doesn't fail the whole precache atomically.
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(PRECACHE.map(url => c.add(url).catch(err => console.warn('Precache failed:', url, err))))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Network-first for Google Fonts (can update)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Network-first for actively-changing app code during development
  if (url.origin === self.location.origin && (url.pathname.endsWith('/app.js') || url.pathname.endsWith('/sync.js') || url.pathname.endsWith('/canvas.js'))) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for local assets
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
