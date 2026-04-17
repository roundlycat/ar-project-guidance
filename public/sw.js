const CACHE_NAME = 'ar-guide-cache-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Simple pass-through for now to satisfy PWA requirements
  event.respondWith(
    fetch(event.request).catch(() => {
      return new Response("Offline Mode active. Reconnect to use fully.");
    })
  );
});
