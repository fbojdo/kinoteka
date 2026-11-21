// Kinoteka – service worker: aplikacja działa offline, dane odświeżane z sieci.
const V = 'kinoteka-__BUILD__';
const SHELL = ['./', 'index.html', 'app.js?v=__BUILD__', 'style.css?v=__BUILD__', 'manifest.webmanifest', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== 'kinoteka-img').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.hostname === 'image.tmdb.org') {   // plakaty: najpierw cache
    e.respondWith(caches.open('kinoteka-img').then(async c => {
      const hit = await c.match(e.request); if (hit) return hit;
      const r = await fetch(e.request); if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r;
    }));
    return;
  }
  if (u.origin !== location.origin) return;
  if (u.pathname.includes('/data/')) {     // dane: najpierw sieć
    e.respondWith(fetch(e.request).then(r => { const cl = r.clone(); caches.open(V).then(c => c.put(e.request, cl)); return r; })
      .catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(h => h || fetch(e.request)));
});
