// Politician profiles (/person/<slug>) and everyone with one (/people): who they are, from Wikidata and Wikipedia,
// and every race of theirs in the archive and in 2026 (data/people, from pipeline/build_people.py).
import { h, num, partyVar, partyChip, sortableTable, PARTY_NAME } from '../ui.js';
import { withData, stateName } from '../archive.js';
import { license, initials } from '../photos.js';
import { CONFIG } from '../config.js';

export const PEOPLE_URL = '/data/people/index.json';
const profileUrl = (slug) => `/data/people/p/${slug}.json`;
export const personHref = (slug) => `/person/${slug}`;

/** A name linked to its profile when it has one (slug), else the name as it was. */
export const personLink = (name, slug, attrs = {}) => (slug ? h('a', { class: 'person-link', href: personHref(slug), ...attrs }, name) : name);

// The names with a profile on each archive year page and on 2026's race pages (data/people/years/<year>.json):
// { president: { name: slug }, senate: { 'AZ' | 'AZ-special': {...} }, house: { 'AZ-07': {...} }, races: { 'GA-SEN': {...} } }.
const yearMaps = {}, loaded = {};
export function peopleOf(year) {
  yearMaps[year] ||= fetch(`/data/people/years/${year}.json`)
    .then(r => (r.ok ? r.json() : r.status === 404 ? {} : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(m => (loaded[year] = m))
    // An outage or a deploy (GitHub Pages can answer 503 for a moment): plain names this time, a fresh try next time.
    .catch(() => { delete yearMaps[year]; return {}; });
  return yearMaps[year];
}

/**
 * A name that links to its profile, looked up in a year's map at path (['senate', 'AZ']) by key (the name as the
 * data spells it; text is what to show). Until the map arrives it is plain text, then it becomes the link, so a page
 * never waits for it.
 */
export function nameLink(text, year, path, key = text) {
  const slugIn = (m) => path.reduce((o, k) => o?.[k], m)?.[key];
  if (loaded[year]) return personLink(text, slugIn(loaded[year]));
  const el = h('span', null, text);
  peopleOf(year).then(m => { const s = slugIn(m); if (s && el.parentNode) el.replaceWith(personLink(text, s)); });
  return el;
}

// The kinds of race in a history (build_people.py ORDER).
const KIND = { P: 'President', S: 'Senate', H: 'House', G: 'Governor', L: 'Lieutenant governor', A: 'Attorney general', C: 'Secretary of state' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "June 12, 1941" from "1941-06-12"; a date known only to the month or the year comes as "1941-06" or "1941". */
function dateText(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  if (!m) return String(y);
  return d ? `${MONTHS[m - 1]} ${d}, ${y}` : `${MONTHS[m - 1]} ${y}`;
}
/** Age on a date, or null unless both dates are known to the day. */
const ageAt = (born, on) => {
  if (born.length < 10 || on.length < 10) return null;
  const [by, bm, bd] = born.split('-').map(Number);
  const [y, m, d] = on.split('-').map(Number);
  return y - by - ((m < bm || (m === bm && d < bd)) ? 1 : 0);
};
const today = () => new Date().toISOString().slice(0, 10);

/** Where a race was: "Arizona", "Arizona (special)", "AZ-07", or "" for president. */
function raceWhere(x) {
  if (x.o === 'P') return '';
  if (x.o === 'H') return x.k.replace(/-0?(\d+)$/, (_, n) => `-${n.padStart(2, '0')}`);
  const st = (x.k || '').slice(0, 2);
  return `${stateName(st)}${/special/.test(x.k || '') ? ' (special)' : ''}`;
}
const raceHref = (x) => (x.race ? `/race/${x.race}` : `/archive/${x.y}`);

/** A party as a chip (a letter code from the archive) or as words (presidential candidates' parties). */
const partyCell = (p) => (!p ? h('span', { class: 'muted' }, '—') : /^[A-Z]{1,2}$/.test(p) ? h('span', { title: PARTY_NAME[p] || p }, partyChip(p)) : h('span', { class: 'small' }, p));

// Profiles fetched this visit: slug -> the profile, or null where there is none (a mistyped address).
const ready = {}, pending = {};
function loadProfile(slug) {
  pending[slug] ||= fetch(profileUrl(slug))
    .then(r => (r.status === 404 ? null : r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(p => (ready[slug] = p?.name ? p : null))
    .catch(e => { delete pending[slug]; throw e; });
  return pending[slug];
}

export function render(root, slug) {
  if (slug in ready) return root.append(profile(ready[slug]));
  const holder = h('div', { class: 'skeleton', style: { height: '600px' } });
  root.append(holder);
  loadProfile(slug).then(p => {
    if (!holder.isConnected) return;
    holder.replaceWith(profile(p));
    document.title = `${CONFIG.siteName} - ${title(slug)}`;
  }).catch(() => { if (holder.isConnected) holder.replaceWith(h('div', { class: 'empty small' }, 'This profile could not be loaded. Try again in a moment.')); });
}

function profile(p) {
  if (!p) {
    return h('div', { class: 'card not-found' }, h('div', { class: 'eyebrow' }, 'Politicians'), h('h1', null, 'No profile at this address'),
      h('p', { class: 'dek' }, 'The link may be mistyped, or the profile may have moved.'),
      h('div', { class: 'nf-links' }, h('a', { class: 'btn primary', href: '/people' }, 'Find a politician'), h('a', { class: 'btn', href: '/archive' }, 'Past elections')));
  }
  // Ringed in the party of their latest race with a party code (grey for the early parties, which have none).
  const code = (x) => ({ Democratic: 'D', Republican: 'R' })[x.p] || x.p || '';
  const ring = partyVar(p.history.map(code).find(c => /^[A-Z]{1,2}$/.test(c)));
  const noPhoto = () => h('span', { class: 'avatar person-photo', style: { background: ring } }, initials(p.name));
  const photo = p.photo
    ? h('span', { class: 'avatar photo person-photo', style: { borderColor: ring } },
      h('img', { src: `/assets/img/people/${p.photo.f}`, alt: '', width: 96, height: 96, decoding: 'async', onerror: (ev) => ev.target.parentNode?.replaceWith(noPhoto()) }))
    : noPhoto();

  const facts = [];
  const age = p.born ? ageAt(p.born, p.died || today()) : null;
  if (p.born) facts.push(['Born', [dateText(p.born), p.birthplace ? ` in ${p.birthplace}` : '', !p.died && age !== null ? ` (age ${age})` : '']]);
  if (p.died) facts.push(['Died', [dateText(p.died), age !== null ? ` (aged ${age})` : '']]);
  if (p.parties?.length) facts.push([p.parties.length > 1 ? 'Parties' : 'Party', p.parties.join(', ')]);

  const head = h('header', { class: 'page-head person-head' },
    h('div', { class: 'eyebrow' }, h('a', { href: '/people' }, 'Politicians'), h('span', null, '›'), h('span', null, p.name)),
    h('div', { class: 'person-top' }, photo,
      h('div', null, h('h1', null, p.name), p.desc ? h('p', { class: 'dek', style: { margin: '4px 0 0' } }, p.desc[0].toUpperCase() + p.desc.slice(1)) : null)),
    facts.length ? h('dl', { class: 'person-facts' }, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : null);

  const offices = p.offices?.length ? h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'Offices held'))),
    h('div', { class: 'card' }, h('ul', { class: 'person-offices' }, p.offices.map(o => h('li', null,
      h('span', null, h('b', null, o.t), o.w ? h('span', { class: 'muted' }, `, ${o.w}`) : null),
      o.n ? null : h('span', { class: 'person-years' }, o.x ? `from ${o.f}` : o.f === o.u ? String(o.f) : `${o.f}–${o.u ?? 'present'}`)))))) : null;

  const runs = p.history.filter(x => x.y <= 2024);
  const now = p.history.filter(x => x.y > 2024);
  const won = runs.filter(x => x.w).length;
  const table = runs.length ? sortableTable([
    { key: 'y', label: 'Year', num: true, render: x => h('a', { href: raceHref(x) }, String(x.y)), sort: x => x.y },
    { key: 'o', label: 'Race', render: x => h('span', null, h('a', { href: raceHref(x) }, KIND[x.o] || x.o), raceWhere(x) ? h('span', { class: 'muted', style: { whiteSpace: 'nowrap' } }, ` · ${raceWhere(x)}`) : null), sort: x => `${x.o}${x.k || ''}` },
    { key: 'p', label: 'Party', render: x => partyCell(x.p), sort: x => x.p || '' },
    { key: 'v', label: 'Votes', num: true, hideSm: true, render: x => (x.v ? num(x.v) : h('span', { class: 'muted' }, '—')), sort: x => x.v || 0 },
    { key: 's', label: 'Share', num: true, render: x => (x.s !== null && x.s !== undefined ? `${x.s.toFixed(2)}%` : h('span', { class: 'muted' }, '—')), sort: x => x.s ?? -1 },
    { key: 'w', label: 'Result', render: x => h('span', { class: x.w ? 'person-won' : 'muted', title: x.vp ? 'Before 1804 the runner-up in electoral votes became vice president.' : x.void ? 'The result was never certified, and the seat stayed vacant until a new election.' : null }, x.w ? 'Won' : x.vp ? 'Vice president' : x.void ? 'Not certified' : 'Lost', x.u ? h('span', { class: 'muted' }, ' · unopposed') : null, x.o === 'P' && x.ev ? h('span', { class: 'muted' }, ` · ${x.ev} electoral vote${x.ev === 1 ? '' : 's'}`) : null), sort: x => (x.w ? 3 : x.vp ? 2 : x.void ? 1 : 0) },
  ], runs, { sortKey: 'y', desc: true, stateKey: `person-${p.slug}` }) : null;

  const history = h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'Electoral history'),
      h('p', null, runs.length ? `${runs.length} general election${runs.length === 1 ? '' : 's'} in the archive, ${won} won. Presidential races since 1788; House and Senate races since 1976.` : 'No general elections in the archive’s years (president since 1788; House and Senate since 1976).'))),
    now.length ? h('div', { class: 'card person-now' }, now.map(x => h('div', null, h('b', null, `${x.y}: `), `${KIND[x.o] || x.o}${raceWhere(x) ? `, ${raceWhere(x)}` : ''} `, partyCell(x.p), ' · ', h('a', { href: raceHref(x) }, 'results and forecast')))) : null,
    table ? h('div', { class: 'ar-table', style: { marginTop: now.length ? '12px' : 0 } }, table) : null);

  const about = p.summary ? h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'About'))),
    h('div', { class: 'card person-about' }, p.summary.split(/\n+/).map(t => h('p', null, t)),
      h('p', { class: 'xs muted', style: { marginBottom: 0 } }, 'The opening of Wikipedia’s article ',
        h('a', { href: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.article.replace(/ /g, '_'))}`, target: '_blank', rel: 'noopener' }, `“${p.article}”`),
        ', under ', h('a', { href: 'https://creativecommons.org/licenses/by-sa/4.0/', target: '_blank', rel: 'noopener license' }, 'CC BY-SA 4.0'), '.'))) : null;

  const credit = h('p', { class: 'xs muted', style: { maxWidth: '760px' } },
    'Born, died, party and offices from Wikidata (CC0). Results from the archive: a race is tied to this person through the seat they won or a link in Wikipedia’s election articles, or, for their other runs, by name in a state where they ran or served. ',
    p.photo ? ['Photo: ', h('a', { href: p.photo.page, target: '_blank', rel: 'noopener' }, p.photo.by), ', ', license(p.photo), '. '] : null);

  return h('div', null, head, about, offices, history, h('section', { class: 'section' }, credit));
}

// ------------------------------------------------------------------------------------------- everyone

export function renderIndex(root) {
  root.append(h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, h('a', { href: '/archive' }, 'Archive'), h('span', null, '›'), h('span', null, 'Politicians')),
    h('h1', null, 'Politicians'),
    h('p', { class: 'dek' }, 'Profiles of the people in the archive and on the 2026 ballot who have a Wikipedia article: members of Congress since 1977, presidential candidates back to 1788, Senate nominees since 1976, House nominees since 2020 and this year’s candidates. Each has their electoral history and the offices they held.')),
  withData([PEOPLE_URL], (idx) => peopleList(idx), 600));
}

function peopleList(idx) {
  const all = idx.people;
  const input = h('input', { type: 'search', placeholder: `Search ${num(all.length)} politicians by name or state`, 'aria-label': 'Search politicians', autocomplete: 'off' });
  const list = h('div', { class: 'people-list' });
  const note = h('p', { class: 'small muted', style: { margin: '12px 0 0' } });
  const LIMIT = 120;
  const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’ʼ]/g, "'").toLowerCase();
  const hay = all.map(p => fold(`${p.n} ${p.st.map(stateName).join(' ')} ${p.st.join(' ')}`));
  const draw = () => {
    const words = fold(input.value).split(/\s+/).filter(Boolean);
    const hits = all.filter((p, i) => words.every(w => hay[i].includes(w)));
    list.replaceChildren(...hits.slice(0, LIMIT).map(p => h('a', { class: 'people-item', href: personHref(p.s) },
      h('b', null, p.n), h('span', { class: 'xs muted' }, [p.d, p.y ? `${p.y[0] === p.y[1] ? p.y[0] : `${p.y[0]}–${p.y[1]}`}` : null].filter(Boolean).join(' · ')))));
    note.textContent = hits.length > LIMIT ? `Showing ${LIMIT} of ${num(hits.length)}. Type a name or a state to narrow the list.`
      : !hits.length ? 'No one by that name or in that state.' : '';
    note.hidden = !note.textContent;
  };
  input.addEventListener('input', draw);
  draw();
  return h('div', null, h('div', { class: 'search people-search' }, input), list, note);
}

export const indexTitle = () => 'Politicians';
/** The person's name once their profile has loaded; until then, a guess from the address ("bernie-sanders"). */
export function title(slug) {
  if (ready[slug]) return ready[slug].name;
  if (slug in ready) return 'Profile not found';
  return slug.replace(/-q\d+$/, '').split('-').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}
