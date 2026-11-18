// Site-wide search, opened from the header's Search button, "/" or Ctrl/Cmd+K: politicians with a profile
// (data/people/index.json, fetched the first time the search opens), 2026 races, states, archive years and the main
// pages. Results are ordinary links, so the site's in-page navigation (app.js onLinkClick) follows a click; the arrow
// keys move through them and Enter follows the highlighted one.
import { h, num } from './ui.js';
import { store } from './store.js';
import { navigate } from './nav.js';
import { liveFrontPage } from './live.js';
import { PEOPLE_URL, personHref } from './views/person.js';

/** For matching: lower case, no accents, no apostrophes or periods ("O’Neill" is "oneill", "J.D." is "jd"), and
 *  dashes, slashes and commas as spaces ("PA-07" is "pa 07"). */
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[‘’ʼ'.]/g, '').replace(/[-‐-―/_,]/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => (s ? s.split(' ') : []);
/** Every query word starts some word of the text. */
const prefixesAll = (qw, tw) => qw.every(w => tw.some(t => t.startsWith(w)));

const LIMIT = { people: 8, races: 5, states: 3, years: 1, pages: 3 };
const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>';

// ------------------------------------------------------------------------------------------- the people list
let people = null;          // [{ p, name, nw, top }] once loaded
let peopleLoad = null;      // the request in flight
let peopleFailed = false;
// Presidents and vice presidents first among equal matches: "adams" is John Adams before Alma Adams.
const TOP = /\b(vice )?president of the united states\b|\bu ?s president\b/;
function loadPeople() {
  if (people || peopleLoad) return;
  peopleFailed = false;
  peopleLoad = fetch(PEOPLE_URL)
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(idx => {
      people = idx.people.map(p => { const name = fold(p.n); return { p, name, nw: words(name), top: TOP.test(fold(p.d)) }; });
    })
    // An outage or a deploy (GitHub Pages can answer 503 for a moment): say so, and try again next time.
    .catch(() => { peopleFailed = true; })
    .finally(() => { peopleLoad = null; if (isOpen()) draw(); });
}

function matchPeople(q, qw) {
  if (!people) return [];
  // Inside one name only: "neill" finds O'Neill and "adams" McAdams, but "adams" isn't Adam Smith.
  const inside = qw.length === 1 && q.length >= 3;
  const hits = [];
  for (const e of people) {
    const score = e.name === q ? 0 : e.name.startsWith(q) ? 1 : prefixesAll(qw, e.nw) ? 2
      : inside && e.nw.some(t => t.includes(q)) ? 3 : -1;
    if (score >= 0) hits.push([score, e]);
  }
  const last = (e) => (e.p.y ? e.p.y[1] : 0);
  hits.sort((a, b) => a[0] - b[0] || b[1].top - a[1].top || last(b[1]) - last(a[1]) || a[1].p.n.localeCompare(b[1].p.n));
  return hits;
}

const yearsText = (y) => (!y ? '' : y[0] === y[1] ? String(y[0]) : `${y[0]}–${y[1]}`);
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ------------------------------------------------------------------------------------------- races, states, pages
const OFFICE_WORDS = {
  senate: 'senate senator sen', house: 'house district congress representative rep', gov: 'governor gov',
  ltgov: 'lieutenant governor lt gov', ag: 'attorney general ag', sos: 'secretary of state sos',
};
const OFFICE_ORDER = { senate: 0, gov: 1, house: 2, ltgov: 3, ag: 4, sos: 5 };
let raceIndex = null, raceCount = 0;
function races() {
  if (!store.races) return [];
  if (raceIndex && raceCount === store.races.length) return raceIndex;
  raceCount = store.races.length;
  raceIndex = store.races.map(r => {
    const names = [r.leftCand?.name || r.left, r.rightCand?.name || r.right].filter(Boolean);
    const all = (r.candidates || []).map(c => c.name);
    return {
      r, id: fold(r.id), names,
      hw: words(fold(`${r.title} ${r.id} ${r.short} ${r.stateName} ${r.state} ${OFFICE_WORDS[r.type] || r.office}`)),
      cw: words(fold([...names, ...all].join(' '))),
    };
  });
  return raceIndex;
}
function matchRaces(q, qw) {
  // "pa7", "PA 7" and "pa-07" all mean PA-07.
  const m = q.match(/^([a-z]{2}) ?0?(\d{1,2})$/);
  const district = m ? `${m[1]} ${m[2].padStart(2, '0')}` : null;
  const hits = [];
  for (const e of races()) {
    const score = e.id === q || e.id === district ? 0 : prefixesAll(qw, e.hw) ? 1 : q.length >= 3 && prefixesAll(qw, e.cw) ? 2 : -1;
    if (score >= 0) hits.push([score, e]);
  }
  hits.sort((a, b) => a[0] - b[0] || OFFICE_ORDER[a[1].r.type] - OFFICE_ORDER[b[1].r.type] || (a[1].r.district || 0) - (b[1].r.district || 0) || a[1].r.title.localeCompare(b[1].r.title));
  return hits;
}

function matchStates(q, qw) {
  if (!store.states || q.length < 2) return [];
  const hits = [];
  for (const s of store.states) {
    const name = fold(s.name);
    const score = q === s.code.toLowerCase() || q === name ? 0 : name.startsWith(q) ? 1 : prefixesAll(qw, words(name)) ? 2 : -1;
    if (score >= 0) hits.push([score, s]);
  }
  return hits.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
}

/** An archive year in the query ("1860", "1824 election"): the archive has every even year from 1788 to 2024. */
function matchYears(qw) {
  const w = qw.find(x => /^\d{4}$/.test(x));
  if (!w) return [];
  const y = +w;
  if (y === 2025 || y === 2026) return [[0, { title: 'The 2026 midterms', sub: 'Forecast and live results', href: '/' }]];
  if (y < 1788 || y > 2024) return [];
  const even = y % 2 ? y - 1 : y;
  const label = even === 1788 ? '1788–89' : String(even);
  return [[0, { title: `The ${label} elections`, sub: even % 4 === 0 ? 'Past elections · presidential results by state and the new Congress' : 'Past elections · the new Congress', href: `/archive/${even}` }]];
}

const PAGES = [
  ['Live results', '/live', 'election night count votes'],
  ['Forecast overview', null, 'odds chances model'],
  ['Senate forecast', '/senate', 'senate control chamber'],
  ['House forecast', '/house', 'house control chamber'],
  ['Governor races', '/governors', 'governors'],
  ['All states', '/states', 'states map'],
  ['Down-ballot races', '/downballot', 'lieutenant attorney general secretary of state legislatures ballot measures'],
  ['Election simulator', '/simulate', 'simulate simulation what if'],
  ['Past elections', '/archive', 'archive history results'],
  ['Swing map', '/swing', 'shift counties change'],
  ['All politicians', '/people', 'people profiles everyone list'],
  ['How the forecast works', '/methodology', 'methodology model data sources'],
].map(([title, href, k]) => ({ title, href, w: words(fold(`${title} ${k}`)) }));
function matchPages(q, qw) {
  if (q.length < 3) return [];
  return PAGES.filter(p => prefixesAll(qw, p.w)).map(p => [1, { ...p, href: p.href || (liveFrontPage() ? '/forecast' : '/') }]);
}

// ------------------------------------------------------------------------------------------- the panel
let overlay, panel, input, list, closeBtn, live, trigger, opener = null;
let options = [], active = -1;
const isOpen = () => !!overlay && !overlay.hidden;

function option(href, title, sub, extra = {}) {
  const el = h('a', { class: 'sx-item', href, role: 'option', id: `sx-opt-${options.length}`, tabindex: '-1', 'aria-selected': 'false', ...extra },
    h('b', null, title), sub ? h('span', { class: 'sx-sub' }, sub) : null);
  options.push(el);
  return el;
}

function group(label, count, items) {
  const id = `sx-head-${label.replace(/\W+/g, '')}`;
  return h('div', { role: 'group', 'aria-labelledby': id },
    h('div', { class: 'sx-head', id }, h('span', null, label), count ? h('span', null, count) : null), items);
}

function tips() {
  const chip = (text) => h('button', { type: 'button', class: 'sx-chip', onclick: () => { input.value = text; draw(); input.focus(); } }, text);
  return h('div', { class: 'sx-tips' },
    h('p', null, 'Find a politician, a 2026 race, a state or a past election.'),
    h('div', { class: 'sx-chips' }, ['Nancy Pelosi', 'Abraham Lincoln', 'PA-07', 'Georgia', '1860'].map(chip)),
    h('p', { class: 'xs muted' }, 'Or browse ', h('a', { href: '/people', onclick: close }, `all ${people ? num(people.length) : ''} politicians`.replace('  ', ' ')), ' and ', h('a', { href: '/archive', onclick: close }, 'every past election'), '.',
      matchMedia('(hover: hover)').matches ? ' Press / on any page to search.' : null));
}

function draw() {
  options = [];
  const raw = input.value.trim();
  const q = fold(raw), qw = words(q);
  if (!q) {
    list.replaceChildren(tips());
    setActive(-1);
    live.textContent = '';
    input.setAttribute('aria-expanded', 'false');
    return;
  }
  const P = matchPeople(q, qw), R = matchRaces(q, qw), S = matchStates(q, qw), Y = matchYears(qw), G = matchPages(q, qw);
  // Groups in order of their best match, people first among equals.
  const groups = [
    ['people', P], ['races', R], ['states', S], ['years', Y], ['pages', G],
  ].filter(([, hits]) => hits.length).sort((a, b) => a[1][0][0] - b[1][0][0]);
  const blocks = groups.map(([kind, hits]) => {
    const top = hits.slice(0, LIMIT[kind]);
    if (kind === 'people') {
      const items = top.map(([, e]) => option(personHref(e.p.s), e.p.n, [capital(e.p.d), yearsText(e.p.y)].filter(Boolean).join(' · ')));
      if (hits.length > top.length) items.push(option(`/people?q=${encodeURIComponent(raw)}`, `See all ${num(hits.length)} politicians matching “${raw}”`, null, { class: 'sx-item sx-more' }));
      return group('Politicians', hits.length > 1 ? num(hits.length) : null, items);
    }
    if (kind === 'races') {
      return group('2026 races', hits.length > top.length ? `${top.length} of ${num(hits.length)}` : null,
        top.map(([, e]) => option(e.r.url, e.r.title, [e.r.type === 'house' ? e.r.short : null, e.names.length === 2 ? `${e.names[0]} vs. ${e.names[1]}` : e.names[0]].filter(Boolean).join(' · '))));
    }
    if (kind === 'states') return group('States', null, top.map(([, s]) => option(`/state/${s.code}`, s.name, 'Its 2026 races, House map and ballot measures')));
    if (kind === 'years') return group('Past elections', null, top.map(([, y]) => option(y.href, y.title, y.sub)));
    return group('Pages', null, top.map(([, p]) => option(p.href, p.title, null)));
  });
  // The list of politicians is still on its way (or failed): say so where the people would be.
  if (!people) {
    blocks.unshift(h('div', { class: 'sx-empty' }, peopleFailed
      ? ['Couldn’t load the list of politicians. ', h('button', { type: 'button', class: 'sx-retry', onclick: () => { loadPeople(); draw(); input.focus(); } }, 'Try again')]
      : 'Loading politicians…'));
  }
  if (!options.length && people) blocks.push(h('div', { class: 'sx-empty' }, `Nothing matches “${raw}”. Try a last name, a state, or a district such as PA-07.`));
  list.replaceChildren(...blocks);
  input.setAttribute('aria-expanded', options.length ? 'true' : 'false');
  setActive(options.length ? 0 : -1);
  live.textContent = options.length ? `${options.length} result${options.length === 1 ? '' : 's'}` : 'No results';
}

function setActive(i) {
  options.forEach((el, j) => { el.classList.toggle('active', j === i); el.setAttribute('aria-selected', j === i ? 'true' : 'false'); });
  active = i;
  if (i >= 0) {
    input.setAttribute('aria-activedescendant', options[i].id);
    options[i].scrollIntoView({ block: 'nearest' });
  } else input.removeAttribute('aria-activedescendant');
}

function onKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!options.length) return;
    const step = e.key === 'ArrowDown' ? 1 : -1;
    setActive((active + step + options.length) % options.length);
  } else if (e.key === 'Enter') {
    if (active < 0) return;
    e.preventDefault();
    const href = options[active].getAttribute('href');
    close();
    navigate(href);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    close();
  } else if (e.key === 'Tab') {
    // Keep focus inside the panel: the box and the close button.
    e.preventDefault();
    (document.activeElement === input ? closeBtn : input).focus();
  }
}

function build() {
  input = h('input', {
    type: 'search', class: 'sx-input', placeholder: 'Search politicians, races, states, years', autocomplete: 'off', spellcheck: 'false',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-controls': 'sx-list', 'aria-expanded': 'false', 'aria-label': 'Search Ballot Desk',
  });
  list = h('div', { class: 'sx-results', id: 'sx-list', role: 'listbox', 'aria-label': 'Search results' });
  closeBtn = h('button', { type: 'button', class: 'sx-close', 'aria-label': 'Close search', title: 'Close (Esc)', onclick: () => close() }, h('kbd', null, 'Esc'));
  live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  panel = h('div', { class: 'sx-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' },
    h('div', { class: 'sx-bar' }, h('span', { class: 'sx-icon', html: ICON }), input, closeBtn), list, live);
  overlay = h('div', { class: 'sx-overlay', hidden: true }, panel);
  // A click on the dimmed page behind closes the search; a click on a result closes it as the link is followed.
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  list.addEventListener('click', (e) => { if (e.target.closest('a[href]')) close(); });
  list.addEventListener('mousemove', (e) => { const i = options.indexOf(e.target.closest('.sx-item')); if (i >= 0 && i !== active) setActive(i); });
  input.addEventListener('input', draw);
  panel.addEventListener('keydown', onKey);
  document.body.append(overlay);
}

export function openSearch(text) {
  if (!overlay) build();
  loadPeople();
  opener = document.activeElement;
  if (typeof text === 'string') input.value = text;
  overlay.hidden = false;
  document.body.classList.add('sx-open');
  trigger?.setAttribute('aria-expanded', 'true');
  draw();
  input.focus();
  input.select();
}

function close() {
  if (!isOpen()) return;
  overlay.hidden = true;
  document.body.classList.remove('sx-open');
  trigger?.setAttribute('aria-expanded', 'false');
  // Back to where the search was opened from (the Search button, say). Opened from the page itself, focus goes back
  // to the page: a hidden box that kept it would swallow the next "/".
  if (opener && opener.isConnected && opener !== document.body && !panel.contains(opener)) opener.focus({ preventScroll: true });
  else input.blur();
  opener = null;
}

/** "/" or Ctrl/Cmd+K opens the search from anywhere, except while typing in a field. */
function onGlobalKey(e) {
  if (document.body.classList.contains('broadcast-mode')) return;   // the stream's stage has no header
  const t = e.target;
  const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (isOpen()) close(); else openSearch();
  } else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !isOpen()) {
    e.preventDefault();
    openSearch();
  }
}

/** The Search button in the header, beside the theme toggle. */
export function setupSearch() {
  const tools = document.querySelector('.header-tools');
  if (!tools || document.querySelector('.search-btn')) return;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  trigger = h('button', {
    type: 'button', class: 'search-btn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    'aria-label': 'Search politicians, races and states', title: `Search (/ or ${mac ? '⌘' : 'Ctrl+'}K)`, 'aria-keyshortcuts': '/ Control+K Meta+K',
    onclick: () => openSearch(), onpointerenter: loadPeople, onfocus: loadPeople,
  }, h('span', { class: 'sx-icon', html: ICON }), h('span', { class: 'search-btn-label' }, 'Search'));
  tools.prepend(trigger);
  document.addEventListener('keydown', onGlobalKey);
  // Leaving the page another way (back button, a link elsewhere) closes it too.
  window.addEventListener('popstate', close);
  window.addEventListener('bd:navigate', close);
}
