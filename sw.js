// HTMU TTS Service Worker
const CACHE_NAME = 'htmu-tts-v3';
const VOICE_CACHE = 'htmu-tts-voices';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './jszip.min.js',
  './default.json',
  './manifest.json'
];

// Install - cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Caching app shell');
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate - clean old caches (keep voice cache)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME && key !== VOICE_CACHE)
            .map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Handle messages from main thread (to cache voice files)
self.addEventListener('message', event => {
  if (event.data.type === 'CACHE_VOICE_FILE') {
    const { url, data, mimeType } = event.data;
    caches.open(VOICE_CACHE).then(cache => {
      const response = new Response(data, {
        headers: { 'Content-Type': mimeType }
      });
      cache.put(url, response);
      console.log('[SW] Cached voice file:', url);
    });
  }
});

// Fetch - check voice cache first, then app cache
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  
  const url = new URL(event.request.url);
  
  // Handle voice file requests (served from cache)
  if (url.pathname.includes('/voice/')) {
    event.respondWith(
      caches.open(VOICE_CACHE).then(cache => {
        return cache.match(event.request).then(response => {
          if (response) {
            console.log('[SW] Serving from voice cache:', url.pathname);
            return response;
          }
          return new Response('Voice file not cached', { status: 404 });
        });
      })
    );
    return;
  }
  
  // Skip cross-origin except CDN
  if (url.origin !== location.origin && !url.href.includes('cdnjs.cloudflare.com')) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        return cached;
      }
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
