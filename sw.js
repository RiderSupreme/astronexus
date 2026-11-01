// Polaris: keeps the map working offline after the first visit.
//
// Polaris shares astronexusnms.com with the landing page and starbase.html, so
// this worker must only ever answer for its own files. It sits at the site root
// (that is where polaris.html lives), which means the browser hands it every
// request on the origin — including the landing page and the judging portal.
// Anything that is not Polaris is passed straight through to the network.
const CACHE = 'polaris-v2';
const PAGE = 'polaris.html';
const CORE = [PAGE, 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

const isPolarisPage = url => url.pathname === '/' + PAGE || url.pathname.endsWith('/' + PAGE);
const isCore = url => CORE.some(f => url.pathname.endsWith('/' + f));

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())));

self.addEventListener('activate', e =>
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())));

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const url = new URL(r.url);
  const font = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);

  if (font) {                                    // shared with the rest of the site, safe to keep
    e.respondWith(caches.match(r).then(m => m || fetch(r).then(res => {
      const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); return res;
    })));
    return;
  }
  if (url.origin !== location.origin) return;

  if (r.mode === 'navigate') {
    // Only Polaris. The landing page and starbase.html must reach the network
    // untouched, and must never overwrite the saved Polaris page.
    if (!isPolarisPage(url)) return;
    e.respondWith(
      fetch(r).then(res => {
        const cp = res.clone();
        caches.open(CACHE).then(c => c.put(new Request(PAGE), cp));
        return res;
      }).catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || caches.match(PAGE)))
    );
    return;
  }

  if (!isCore(url)) return;                      // not ours: let the network serve it
  e.respondWith(caches.match(r, { ignoreSearch: true }).then(m => m || fetch(r).then(res => {
    const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); return res;
  })));
});
