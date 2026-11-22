// Offline cache for the app shell. Bump VERSION on every release.
const VERSION = 'v0.3.2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './css/app.css', './js/config.js', './js/google.js', './js/app.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Google APIs go straight to the network
  // Network first so updates arrive straight away; the cache is the offline fallback.
  e.respondWith(fetch(e.request, {cache: 'no-cache'}).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html'))));
});
