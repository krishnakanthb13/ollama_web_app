const CACHE_NAME = 'ollama-pwa-v21';
const ASSETS = [
    './',
    './index.html',
    './css/styles.css',
    './js/utils.js',
    './js/app.js',
    './vendor/marked.umd.js?v=18.1.2',
    './vendor/purify.min.js?v=3.4.17',
    './vendor/fonts/instrument-sans-latin.woff2',
    './vendor/fonts/bricolage-grotesque-latin.woff2',
    './assets/ollama.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            );
        })
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.url.includes('/api/')) {
        event.respondWith(fetch(event.request));
        return;
    }
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
