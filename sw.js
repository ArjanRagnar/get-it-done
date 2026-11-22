// Offline cache for the app shell. Bump VERSION on every release.
const VERSION = 'v0.1.0';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Google APIs go straight to the network
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
