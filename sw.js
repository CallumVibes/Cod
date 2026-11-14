var CACHE = 'stratboard-v8';
var ASSETS = [
  './',
  './index.html',
  './app.js',
  './nostr.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './icon-180.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(ASSETS.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* Genuinely network first, with a 3.5s leash. Online, you always get the
   current build on the very next open; offline, the cache answers instead. */
function timed(promise, ms) {
  return new Promise(function (res, rej) {
    var settled = false;
    var t = setTimeout(function () {
      if (!settled) { settled = true; rej(new Error('timeout')); }
    }, ms);
    promise.then(function (v) {
      if (settled) return;
      settled = true; clearTimeout(t); res(v);
    }, function (e) {
      if (settled) return;
      settled = true; clearTimeout(t); rej(e);
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return timed(fetch(req), 3500).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone()).catch(function () {});
        return res;
      }).catch(function () {
        return cache.match(req, { ignoreSearch: true }).then(function (hit) {
          if (hit) return hit;
          if (req.mode === 'navigate') return cache.match('./index.html');
          return Response.error();
        });
      });
    })
  );
});
