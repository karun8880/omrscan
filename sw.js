// Service worker: caches the app shell and the 10 MB OpenCV engine so the scanner
// opens instantly and works without a network. Bump VERSION on every deploy.
const VERSION = 'omr-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.json', 'icon-192.png', 'icon-512.png',
  'js/layout.js', 'js/recognize.js', 'js/sheetpdf.js', 'js/store.js', 'js/app.js',
  'vendor/opencv.js', 'vendor/jsQR.js', 'vendor/qrcode.js', 'vendor/jspdf.umd.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // backend + Google sign-in go to network
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
