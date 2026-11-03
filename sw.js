// A safety net for brief outages at the host. GitHub Pages can answer 503 (its "unicorn" error page) for a few
// seconds while a deploy spreads; anyone who has visited before gets the last good copy of the page instead.
// Every request still goes to the network first, so the copy is used only when the network fails or the server
// errors. Requests to other sites (Polymarket, the NYT feed) are left alone.
// To switch it off for everyone, replace this file with one that calls self.registration.unregister().
const CACHE = 'ballotdesk-copy-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

// Saved under the address without its query, so /data/forecast.json?v=123 falls back to the last good forecast.
const keyFor = (url) => url.origin + url.pathname;
const ours = (url) => url.origin === self.location.origin && url.pathname !== '/sw.js';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || !ours(url)) return;
  e.respondWith(networkFirst(e, req, url));
});

async function networkFirst(e, req, url) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(req);
      if (res.status === 200) {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then(c => c.put(keyFor(url), copy)).catch(() => {}));
        return res;
      }
      if (res.status < 500) return res;   // a real 404 or a redirect is an answer, not an outage
      last = res;
    } catch { /* offline, or the connection dropped */ }
    if (attempt === 0) await wait(700);  // one quick retry: these errors last seconds
  }
  const cache = await caches.open(CACHE);
  // Every page is the same app, so any saved page can stand in for one that was never saved.
  const saved = await cache.match(keyFor(url), { ignoreVary: true }) ||
    (req.mode === 'navigate' ? await cache.match(self.location.origin + '/', { ignoreVary: true }) : undefined);
  return saved || last || Response.error();
}

// The first visit loads before this worker exists, so the page hands over what it has already loaded.
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'save' || !Array.isArray(e.data.urls)) return;
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const u of new Set(e.data.urls)) {
      let url;
      try { url = new URL(u); } catch { continue; }
      if (!ours(url) || await cache.match(keyFor(url), { ignoreVary: true })) continue;
      try {
        const res = await fetch(u);
        if (res.status === 200) await cache.put(keyFor(url), res);
      } catch { /* skip it; the next visit saves it */ }
    }
  })());
});
