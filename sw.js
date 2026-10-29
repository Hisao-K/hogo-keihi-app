// 保護活動経費アプリの service worker。
// 端末に置くのは、下の SHELL に書いた画面のファイルだけ。電波が弱くてもアプリが開くようにする。
// GAS との通信・写真・PDF・データは別のサイトあて（または POST）なので、ここでは扱わない・置かない。
// 画面を更新したら VERSION を上げる。
const VERSION = 'hogo-v3';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];
const SHELL_URLS = SHELL.map((p) => new URL(p, self.registration.scope).href);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

// 消すのは、このアプリの古い置き場（hogo- で始まるもの）だけ。
// 同じサイト（hisao-k.github.io）にあるほかのアプリ（名刺管理君・経費判定君）の置き場は消さない
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('hogo-') && k !== VERSION).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// SHELL のファイルの GET だけ。新しい画面を優先し、つながらないときだけ置いておいた画面を出す
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  url.search = '';
  if (!SHELL_URLS.includes(url.href)) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(url.href, copy));
        }
        return res;
      })
      .catch(() => caches.match(url.href))
  );
});
