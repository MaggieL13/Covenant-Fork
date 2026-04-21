// Minimal service worker — no caching logic, just present so the PWA manifest
// installs cleanly on mobile/TV. Intentionally a no-op for now.
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', () => { /* network only */ });
