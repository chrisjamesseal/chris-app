/* Offline support for Hobi. The app itself already works with no network once it's loaded -
   everything reads from localStorage first, Firebase sync is a background nice-to-have that
   already fails silently - the only reason opening this app with no signal at all previously
   failed outright is that the browser had nothing cached to load in the first place: index.html
   is served with Cache-Control: no-cache (see vercel.json), which needs a network round-trip to
   revalidate before Safari will use anything it already has.

   Two different strategies below, on purpose:
   - the app shell (this page itself) always tries the network FIRST, so a redeploy shows up the
     moment you're back online, and only falls back to the last cached copy when that fetch
     genuinely fails (no connection at all).
   - every CDN library (Font Awesome, Leaflet, MapLibre, Firebase's own JS, lz-string) is
     cache-first instead: each one is pinned to an exact version in index.html's own <script>/
     <link> tags, so a URL that's ever been fetched successfully will never need fetching again -
     no separate list to keep in sync with those tags, whatever gets requested on first load just
     gets cached the moment it succeeds. */
const SHELL_CACHE = 'hobi-shell-v1';
const RUNTIME_CACHE = 'hobi-runtime-v1';
const APP_SHELL = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;

  const isShell = req.mode === 'navigate' || new URL(req.url).pathname === '/index.html';
  if(isShell){
    event.respondWith(
      fetch(req).then(res => {
        caches.open(SHELL_CACHE).then(cache => cache.put('/index.html', res.clone()));
        return res;
      }).catch(() => caches.match('/index.html').then(cached => cached || caches.match('/')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => {
      if(cached) return cached;
      return fetch(req).then(res => {
        if(res && res.status === 200){
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then(cache => cache.put(req, copy)).catch(()=>{});
        }
        return res;
      });
    })
  );
});
