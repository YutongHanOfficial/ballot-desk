// Senate, House and Governor pages.
import { h, pct, num, timeAgo, sortableTable } from '../ui.js';
import { store, cur, chamber, racesOf } from '../store.js';
import { usMap, mapLegend, BAND_LEGEND, histogram, seatStrip } from '../charts.js';
import { houseMap } from '../maps.js';
import { chamberCard, raceColumns, electionBanner, CHAMBERS } from './common.js';
import { stateFill, stateTip } from './home.js';
import { calledSeats } from '../live.js';

const VIEW_STATE = {};

function filterBar(state, onChange, { withHeld = true, house = false } = {}) {
  const seg = h('div', { class: 'seg', role: 'tablist' });
  const opts = [['competitive', 'Competitive'], ['all', house ? 'All 435' : 'All']];
  if (withHeld) opts.push(['D', 'Held by Dem.'], ['R', 'Held by Rep.']);
  opts.push(['flips', 'Projected flips']);
  for (const [k, label] of opts) {
    const b = h('button', { class: state.filter === k ? 'on' : '', type: 'button' }, label);
    b.addEventListener('click', () => { state.filter = k; onChange(); });
    seg.appendChild(b);
  }
  const input = h('input', { type: 'search', placeholder: house ? 'Search district, state or candidate…' : 'Search state or candidate…', value: state.q || '', 'aria-label': 'Search races' });
  input.addEventListener('input', () => { state.q = input.value; onChange(true); });
  return h('div', { class: 'toolbar' }, seg, h('div', { class: 'search' }, input));
}

function applyFilter(list, state) {
  const q = (state.q || '').trim().toLowerCase();
  return list.filter(r => {
    const p = cur(r).p;
    if (state.filter === 'competitive' && !(r.left && r.right && p > 0.03 && p < 0.97)) return false;
    if ((state.filter === 'D' || state.filter === 'R') && r.holder !== state.filter) return false;
    if (state.filter === 'flips') {
      if (!r.holder || !r.left || !r.right || p === null) return false;
      const fav = p >= 0.5 ? r.leftParty : r.rightParty;
      if (fav === r.holder) return false;
    }
    if (q) {
      const hay = `${r.title} ${r.short} ${r.stateName} ${r.state} ${(r.candidates || []).map(c => c.name).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function renderChamber(root, type) {
  const C = CHAMBERS[type];
  const ch = chamber(type);
  const races = racesOf(type);
  const fav = ch.pD >= ch.pR ? 'Democrats' : 'Republicans';
  const favP = Math.max(ch.pD, ch.pR);
  const title = type === 'gov'
    ? `Democrats are projected to hold about ${Math.round(ch.dSeats.mean)} of 50 governorships`
    : `${fav} have a ${pct(favP)} chance of winning the ${C.name}`;
  root.append(electionBanner() || '',
    h('header', { class: 'page-head' },
      h('div', { class: 'eyebrow' }, `${C.name} forecast`, h('span', null, '·'), `Updated ${timeAgo(store.forecast.updated)}`),
      h('h1', null, title),
      h('p', { class: 'dek' }, type === 'senate'
        ? `Democrats hold 47 seats (including two independents) and need a net gain of four for a majority, because Vice President JD Vance breaks ties for Republicans. ${races.length} seats are on the ballot, including special elections in Ohio and Florida.`
        : type === 'house'
          ? 'All 435 seats are up and a majority takes 218. Mid-decade redistricting produced new maps in nine states: Alabama, California, Florida, Louisiana, North Carolina, Ohio, Tennessee, Texas and Utah.'
          : '36 states elect a governor. Republicans hold 26 governorships and Democrats 24.')));

  // Control + distribution
  const live = calledSeats(type);
  const distCard = h('div', { class: 'card span2' },
    h('div', { class: 'card-title' }, type === 'gov' ? 'Distribution of Democratic governorships' : 'Distribution of Democratic seats',
      h('span', { class: 'muted', style: { textTransform: 'none', letterSpacing: 0 } }, `${num(ch.live ? store.live.sim?.sims : store.forecast.sims)} simulations`)),
    histogram(ch.hist, { threshold: C.need, total: C.total, xLabel: type === 'gov' ? 'Democratic governors' : 'Democratic seats' }),
    ch.live ? h('p', { class: 'small', style: { marginBottom: 0 } }, h('b', null, 'Called so far: '), `${live.D} D · ${live.R} R${live.O ? ` · ${live.O} other` : ''}`) : null);
  root.append(h('div', { class: 'grid g3' }, chamberCard(type, { link: false }), distCard));

  // Seat strip
  const base = type === 'senate' ? store.base.chambers.senate.notUp.D : type === 'gov' ? Object.values(store.base.chambers.governors.notUp).filter(p => p === 'D').length : 0;
  root.append(h('section', { class: 'section card' },
    h('div', { class: 'card-title' }, type === 'house' ? 'All 435 seats, from most to least Democratic' : `All ${races.length} races, from most to least Democratic`),
    type !== 'house' ? h('p', { class: 'small muted', style: { marginTop: 0 } }, `Democrats start with ${base} ${type === 'gov' ? 'governorships' : 'seats'} not on the ballot; the marker shows the race that would give them ${C.need}.`) : null,
    seatStrip(races, { need: C.need, base, height: type === 'house' ? 40 : 46, majorityLabel: type === 'gov' ? `${C.need}th governorship` : `${C.need}th seat` }),
    mapLegend(BAND_LEGEND.slice(0, 8))));

  // Map
  if (type === 'house') {
    root.append(h('section', { class: 'section card' },
      h('div', { class: 'card-title' }, 'House forecast map', h('span', { class: 'muted', style: { textTransform: 'none', letterSpacing: 0 } }, '2026 district lines')),
      houseMap({ id: 'house' })));
  } else {
    const go = (code) => { const r = races.find(x => x.state === code && !x.special) || races.find(x => x.state === code); if (r) location.hash = r.url; };
    root.append(h('section', { class: 'section card' },
      h('div', { class: 'card-title' }, `${C.name} map`),
      usMap({ fill: stateFill(type), onClick: go, tip: stateTip(type) }), mapLegend(BAND_LEGEND)));
  }

  // Table (filter and search survive the live re-render)
  const state = (VIEW_STATE[type] ||= { filter: 'competitive', q: '' });
  const tableHolder = h('div');
  const bar = filterBar(state, () => draw(), { house: type === 'house' });
  function draw() {
    const rows = applyFilter(races, state);
    tableHolder.replaceChildren(sortableTable(raceColumns({ type }), rows, { sortKey: state.filter === 'all' && type !== 'house' ? 'race' : 'p', desc: !(state.filter === 'all' && type !== 'house'), onRow: r => { location.hash = r.url; }, stateKey: `chamber-${type}` }));
    bar.querySelectorAll('.seg button').forEach((b, i) => b.classList.toggle('on', ['competitive', 'all', 'D', 'R', 'flips'][i] === state.filter));
  }
  draw();
  root.append(h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('div', null, h('h2', null, type === 'house' ? 'House races' : `${C.name} races`), h('p', null, 'Chance of winning from our model; Polymarket price shown for comparison.'))),
    bar, tableHolder));
}

export const title = (type) => `${CHAMBERS[type].name} forecast`;
