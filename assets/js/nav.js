// Plain addresses (ballotdesk.org/race/GA-SEN) with History API navigation. Every address is also a real file
// on GitHub Pages (pipeline/build_pages.mjs writes them), so links work when opened directly or shared.

// Testing switches that stay in the address while you click around (?results=on, ?demo=live).
const FLAGS = ['results', 'demo'];

/** Go to an in-site address such as '/race/GA-SEN' without reloading the page. */
export function navigate(to, { replace = false } = {}) {
  const url = new URL(to, location.origin);
  const now = new URLSearchParams(location.search);
  for (const f of FLAGS) if (now.has(f) && !url.searchParams.has(f)) url.searchParams.set(f, now.get(f));
  const next = url.pathname + url.search + url.hash;
  if (next === location.pathname + location.search + location.hash) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', next);
  window.dispatchEvent(new Event('bd:navigate'));
}

/** The page being shown: '/race/GA-SEN', without a trailing slash or '.html' ('/index' is '/'). Any letter case works. */
export function currentPath() {
  let p = location.pathname;
  try { p = decodeURIComponent(p); } catch { /* keep it encoded */ }
  p = p.replace(/\.html$/i, '').replace(/\/+$/, '');
  const id = p.match(/^\/(race|state)\/([^/]+)$/i);
  p = id ? `/${id[1].toLowerCase()}/${id[2].toUpperCase()}` : p.toLowerCase();
  return !p || p === '/index' ? '/' : p;
}

/** Show the tidy form of the address (/race/ga-sen.html becomes /race/GA-SEN). */
export function tidyAddress() {
  const p = currentPath();
  if (p !== location.pathname) history.replaceState(null, '', p + location.search + location.hash);
}

/** Links shared before the switch (/#/race/GA-SEN, /?results=on#/live) become plain addresses in place. */
export function upgradeHashLink() {
  if (!location.hash.startsWith('#/')) return;
  let [path, query] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(location.search);
  for (const [k, v] of new URLSearchParams(query || '')) params.set(k, v);
  const tab = path.match(/^\/downballot\/(\w+)$/);           // down-ballot tabs moved into the query
  if (tab) { path = '/downballot'; params.set('tab', tab[1]); }
  const qs = params.toString();
  history.replaceState(null, '', (path || '/') + (qs ? `?${qs}` : ''));
}
