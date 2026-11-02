// Photo credits: every candidate photo on the site with its author and license.
import { h, lastName, partyVar } from '../ui.js';
import { store } from '../store.js';
import { loadPhotos, license } from '../photos.js';

export function render(root) {
  root.append(h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, 'About'), h('h1', null, 'Photo credits'),
    h('p', { class: 'dek' }, 'Candidate photos are the lead images of the candidates’ Wikipedia articles, cropped to a headshot and used under their free licenses. Each photo is matched through the race’s own table on Wikipedia, never by name alone. Candidates without a freely licensed photo are shown with their initials.')));
  const P = store.photos;
  if (!P) {
    root.append(h('div', { class: 'card empty' }, 'Loading photo credits…'));
    loadPhotos();
    return;
  }
  // Each person once, with every race they appear in.
  const seen = {};
  for (const [rid, names] of Object.entries(P.races)) {
    const r = store.byId[rid];
    if (!r) continue;
    for (const [name, article] of Object.entries(names)) {
      const c = (r.candidates || []).find(x => x.name === name);
      (seen[article] ||= { name, party: c?.party, races: [] }).races.push(r);
    }
  }
  const rows = Object.entries(seen).filter(([a]) => P.people[a])
    .sort(([, a], [, b]) => lastName(a.name).localeCompare(lastName(b.name)) || a.name.localeCompare(b.name));
  root.append(h('p', { class: 'small muted' }, `${rows.length} photos. Public-domain photos are mostly official portraits; for the rest, the photographer and license are listed with a link to the original file.`),
    h('div', { class: 'credits-grid' }, rows.map(([article, x]) => {
      const p = P.people[article];
      return h('div', { class: 'credit-item' },
        h('img', { src: `/assets/img/people/${p.f}`, alt: '', width: 56, height: 56, loading: 'lazy', decoding: 'async', style: { borderColor: partyVar(x.party) } }),
        h('div', { class: 'credit-text' },
          h('b', null, x.name),
          h('div', { class: 'xs muted' }, x.races.map((r, i) => [i ? ' · ' : '', h('a', { href: r.url }, r.title)])),
          h('div', { class: 'xs' }, `Photo: ${p.by}, `, license(p), ' · ', h('a', { href: p.page, target: '_blank', rel: 'noopener' }, 'original'))));
    })));
}

export const title = () => 'Photo credits';
