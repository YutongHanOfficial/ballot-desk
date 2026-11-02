// Cached loader for the map and county files in data/geo.
const cache = new Map();
const pending = new Map();

export function loadGeo(url) {
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  if (!pending.has(url)) {
    pending.set(url, fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); })
      .then(d => { cache.set(url, d); return d; })
      .catch(e => { pending.delete(url); throw e; }));
  }
  return pending.get(url);
}

export const cachedGeo = (url) => cache.get(url);

export const COUNTY_BASE_URL = '/data/geo/counties-2024.json';
export const countyBaseline = () => cache.get(COUNTY_BASE_URL) || null;
export const loadCountyBaseline = () => loadGeo(COUNTY_BASE_URL);
