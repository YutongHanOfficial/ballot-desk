// Candidate photos: the lead image of each candidate's Wikipedia article, cropped to a headshot by
// pipeline/build_photos.py. Matched through the race's own Wikipedia table, never on a name alone.
import { h, partyVar, partyChip, lastName, PARTY_NAME } from './ui.js';
import { store, notify } from './store.js';
import { samePerson } from './model.js';

let loading = null, tries = 0;
/**
 * Fetch data/photos.json once; pages redraw when it lands. A missing file just means initials everywhere; a server
 * error (GitHub Pages can answer 503 for a moment during a deploy) or a dropped connection is retried a few times.
 */
export function loadPhotos() {
  loading ||= fetch('/data/photos.json', { cache: 'no-cache' })
    .then(res => {
      if (res.status >= 500) throw new Error(`photos.json: HTTP ${res.status}`);
      return res.ok ? res.json() : null;
    })
    .then(d => { if (d?.people) { store.photos = d; notify('photos'); } })
    .catch(() => { loading = null; if (++tries < 4) setTimeout(loadPhotos, 15000 * tries); });
  return loading;
}

/** { src, by, lic, licUrl, page, article } for a candidate in a race, or null. */
export function photoOf(r, name) {
  const P = store.photos;
  const map = P && r && name ? P.races[r.id] : null;
  if (!map) return null;
  let article = map[name];
  if (!article) {
    // Another spelling (the results feed's): only when it can be just one of the race's candidates.
    const hits = (r.candidates || []).filter(c => samePerson(c.name, name));
    if (hits.length === 1) article = map[hits[0].name];
  }
  const p = article && P.people[article];
  return p ? { ...p, article, src: `/assets/img/people/${p.f}` } : null;
}

export function initials(name) {
  const parts = String(name || '?').replace(/\b(Jr\.?|Sr\.?|III|II|IV)\b/g, '').trim().split(/\s+/);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/**
 * A round headshot ringed in the party colour. Without a photo: the initials on the party colour
 * (fallback 'initials') or the party chip in a slot of the same width, so names still line up ('chip').
 * badge: the party letter on the photo's corner, for rows where the photo replaces the chip.
 */
export function avatar(r, name, party, { size = 40, fallback = 'initials', badge = false, color } = {}) {
  const p = photoOf(r, name);
  const ring = color || partyVar(party);
  if (p) {
    // A photo that fails to load (an outage, a blocked image) falls back like a candidate without one.
    const el = h('span', { class: 'avatar photo', style: { width: `${size}px`, height: `${size}px`, borderColor: ring }, title: `${name}. Photo: ${p.by} (${p.lic})` },
      h('img', { src: p.src, alt: '', width: size, height: size, loading: 'lazy', decoding: 'async', onerror: () => el.replaceWith(avatar(null, name, party, { size, fallback, badge, color })) }),
      badge ? h('b', { class: 'av-badge', style: { background: ring }, title: PARTY_NAME[party] || 'Other' }, party || '?') : null);
    return el;
  }
  if (fallback === 'chip') return h('span', { class: 'avatar-slot', style: { width: `${size}px` } }, partyChip(party));
  return h('span', { class: 'avatar', style: { width: `${size}px`, height: `${size}px`, background: ring, fontSize: `${Math.round(size * 0.36)}px` } }, initials(name));
}

/** "Photos: Ossoff by United States Senate, public domain; …" for the candidates shown, linking each file page. */
export function photoCredits(r, names) {
  const items = names.map(n => [n, photoOf(r, n)]).filter(([, p]) => p);
  if (!items.length) return null;
  return h('p', { class: 'xs muted photo-credit' }, items.length > 1 ? 'Photos: ' : 'Photo: ',
    items.map(([n, p], i) => [i ? '; ' : '', h('a', { href: p.page, target: '_blank', rel: 'noopener' }, lastName(n)), ` by ${p.by}, `, license(p)]),
    '. ', h('a', { href: '/credits' }, 'Photo credits'));
}

export const licenseText = (p) => (p.lic === 'Public domain' ? 'public domain' : p.lic);

/** The license, linked to its text when it has one ("public domain" has none). */
export function license(p) {
  return p.licUrl && p.lic !== 'Public domain' ? h('a', { href: p.licUrl, target: '_blank', rel: 'noopener license' }, licenseText(p)) : licenseText(p);
}
