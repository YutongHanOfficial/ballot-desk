// States index and individual state pages.
import { h, pct, num, partyChip, partyVar, ratingChip, sortableTable, esc, PARTY_NAME } from '../ui.js';
import { store, cur } from '../store.js';
import { raceCard, raceColumns, electionBanner, pollCloseText } from './common.js';
import { stateGrid } from './home.js';
import { usMap, mapLegend, probMini, marginLegend } from '../charts.js';
import { stateDistrictMap, countyMap, countyResults, countyLegend, countyPending, areaLevel, areaWord, byArea } from '../maps.js';
import { nightMode } from '../store.js';
import { wantCounties } from '../live.js';
import { navigate } from '../nav.js';

// Projected Democratic share of a state's House seats: the neutral toss-up shade when even, darker toward a
// sweep. Blending toward a fixed light colour (not the page background) keeps darker = safer in dark mode too.
const shareFill = (dShare) => `color-mix(in srgb, var(${dShare >= 0.5 ? '--dem' : '--rep'}) ${Math.round(15 + Math.abs(dShare - 0.5) * 170)}%, var(--toss))`;

export function renderIndex(root) {
  const fill = (code) => {
    const rs = (store.byState[code] || []).filter(r => r.type === 'house');
    if (!rs.length) return 'var(--none)';
    return shareFill(rs.reduce((s, r) => s + dWin(r), 0) / rs.length);
  };
  const tip = (code) => {
    const st = store.stateByCode[code];
    const rs = store.byState[code] || [];
    const house = rs.filter(r => r.type === 'house');
    const expD = house.reduce((s, r) => s + dWin(r), 0);
    return `<div class="tt-title">${esc(st.name)}</div><div class="tt-row"><span>House seats</span><b>${house.length}</b></div><div class="tt-row"><span>Projected D seats</span><b>${expD.toFixed(1)}</b></div><div class="tt-row"><span>Statewide races</span><b>${rs.filter(r => r.type !== 'house').length}</b></div>`;
  };
  root.append(electionBanner() || '',
    h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, 'States'), h('h1', null, 'Every state on the 2026 ballot'),
      h('p', { class: 'dek' }, 'Pick a state for its Senate, House and governor races, down-ballot statewide offices, legislative chambers and ballot measures.')),
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Projected share of each state’s House delegation'), usMap({ fill, onClick: (c) => { navigate(`/state/${c}`); }, tip }),
      mapLegend([[shareFill(1), 'All D'], [shareFill(0.75), 'Mostly D'], ['var(--toss)', 'Even split'], [shareFill(0.25), 'Mostly R'], [shareFill(0), 'All R']])),
    h('section', { class: 'section' }, stateGrid()));
}

export function dWin(r) {
  const p = cur(r).p;
  if (!r.left || !r.right) {
    const party = r.left ? r.leftParty : r.rightParty;
    return party === 'D' ? 1 : 0;
  }
  if (p === null) return 0;
  return (r.leftParty === 'D' ? p : 0) + (r.rightParty === 'D' ? 1 - p : 0);
}

export function renderState(root, code) {
  const st = store.stateByCode[code];
  if (!st) { root.append(h('div', { class: 'empty' }, 'Unknown state.')); return; }
  const rs = store.byState[code] || [];
  const statewide = rs.filter(r => r.type !== 'house');
  const house = rs.filter(r => r.type === 'house');
  const pvi = (rs.find(r => r.type === 'senate' || r.type === 'gov') || {}).pvi ?? (store.base.legislatures.find(l => l.state === code) || {}).pvi;
  const pviText = pvi === undefined || pvi === null ? '—' : pvi === 0 ? 'EVEN' : `${pvi > 0 ? 'D' : 'R'}+${Math.abs(pvi)}`;
  const holdNow = { D: 0, R: 0, I: 0, new: 0 };
  house.forEach(r => { if (r.holder) holdNow[r.holder] = (holdNow[r.holder] || 0) + 1; else holdNow.new++; });
  const expD = house.reduce((s, r) => s + dWin(r), 0);

  root.append(electionBanner() || '',
    h('div', { class: 'eyebrow' }, h('a', { href: '/states' }, 'States'), h('span', null, '›'), h('span', null, st.name)),
    h('header', { class: 'page-head' },
      h('h1', null, st.name),
      h('p', { class: 'dek' }, `Cook partisan lean ${pviText} · Polls close at ${pollCloseText(code)} · ${house.length} House seat${house.length === 1 ? '' : 's'} · ${statewide.length} statewide race${statewide.length === 1 ? '' : 's'}`)));

  if (statewide.length) {
    root.append(h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, 'Statewide races')),
      h('div', { class: 'race-cards' }, statewide.map(r => raceCard(r)))));
  }

  if (house.length) {
    root.append(h('section', { class: 'section' },
      h('div', { class: 'section-head' },
        h('div', null, h('h2', null, 'U.S. House'),
          h('p', null, `Now: ${holdNow.D} D · ${holdNow.R} R${holdNow.I ? ` · ${holdNow.I} I` : ''}${holdNow.new ? ` · ${holdNow.new} new or vacant` : ''}. Projected: ${expD.toFixed(1)} D · ${(house.length - expD).toFixed(1)} R (expected seats).`))),
      stateMapCard(st, house, statewide),
      sortableTable(raceColumns({ type: 'house' }), house, { sortKey: 'race', desc: false, onRow: r => { navigate(r.url); }, stateKey: `state-${code}` })));
  }

  const legis = store.base.legislatures.filter(l => l.state === code);
  if (legis.length) {
    root.append(h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'State legislature'), h('p', null, 'Ratings from Sabato’s Crystal Ball and State Navigate; Polymarket where a market exists.'))),
      h('div', { class: 'grid g2' }, legis.map(legisCard))));
  }

  const measures = store.base.measures.filter(m => m.state === code);
  if (measures.length) {
    root.append(h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, 'Ballot measures')),
      h('div', { class: 'card' }, measures.map(measureItem))));
  }
}

const MAPVIEW = {};   // per state: 'districts' or a race id / 'pres24' for the county map

function stateMapCard(st, house, statewide) {
  const code = st.code;
  const countyRaces = statewide.filter(r => r.left && r.right && (r.type === 'senate' || r.type === 'gov'));
  if (nightMode() && !store.sim) wantCounties(countyRaces.map(r => r.id));
  let view = MAPVIEW[code] || (nightMode() && countyRaces.length ? countyRaces[0].id : 'districts');
  const body = h('div');
  const hint = h('span', { class: 'xs muted' });
  const seg = h('div', { class: 'seg' });
  // Alaska's county-style maps show its state House districts, so its U.S. House map gets a name that can't be
  // mistaken for them. New England's live maps show towns; its 2024 map, counties.
  const opts = [['districts', code === 'AK' ? 'U.S. House' : 'House districts']];
  if (nightMode()) countyRaces.forEach(r => opts.push([r.id, `${r.office} ${byArea(areaLevel(code, r.id), true)}`]));
  opts.push(['pres24', `2024 ${byArea(areaLevel(code), true)}`]);
  const draw = () => {
    seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', opts[i][0] === view));
    const level = areaLevel(code, view === 'districts' || view === 'pres24' ? null : view), one = areaWord(level);
    hint.textContent = view === 'districts' ? `${house.length > 1 ? `${house.length} districts` : 'At-large district'} · 2026 lines` : `Hover a ${one} for details`;
    if (view === 'districts') {
      body.replaceChildren(stateDistrictMap(code, { zoomKey: `state-${code}` }), marginLegend({ check: false, ind: false }));
    } else {
      const raceId = view === 'pres24' ? null : view;
      const live = !!(raceId && countyResults(raceId)), pending = raceId ? countyPending(raceId) : null;
      body.replaceChildren(countyMap(code, { raceId, zoomKey: `stcounty-${code}-${view}` }), countyLegend(raceId ? store.byId[raceId] : null, live || !!pending, level),
        h('p', { class: 'xs muted', style: { margin: '6px 0 0' } }, live ? `Live ${one} results, shaded by leader and margin.`
          : pending === 'loading' ? `Loading the ${one} results…` : pending ? `The ${one} results for this race aren’t available yet.`
          : `2024 presidential vote ${byArea(level)} (Harris vs. Trump).`));
    }
  };
  opts.forEach(([k, label]) => seg.appendChild(h('button', { type: 'button', onclick: () => { view = k; MAPVIEW[code] = k; draw(); } }, label)));
  draw();
  return h('div', { class: 'card', style: { marginBottom: '14px' } },
    h('div', { class: 'map-toolbar' }, seg, hint),
    body);
}

export function legisCard(l) {
  const mk = store.markets.legislatures?.[l.id];
  const rs = Object.entries(l.ratings || {});
  return h('div', { class: 'card flat' },
    h('div', { class: 'chamber-top' }, h('div', null, h('div', { class: 'chamber-name', style: { fontSize: '17px' } }, `${store.stateByCode[l.state].name} ${l.chamber}`),
      h('div', { class: 'chamber-sub' }, [l.last ? `Now: ${l.last}` : null, l.seatsUp ? `${l.seatsUp} of ${l.seatsTotal} seats up` : null].filter(Boolean).join(' · ')))),
    h('div', { class: 'chips', style: { marginTop: '10px' } }, rs.length ? rs.map(([n, r]) => ratingChip({ ...r, label: `${n}: ${r.label}` })) : h('span', { class: 'muted small' }, 'No published ratings')),
    mk ? h('div', { class: 'compare-line', style: { marginTop: '10px' } }, h('span', null, 'Polymarket: ',
      mk.outcomes.filter(o => o.party).map((o, i) => h('b', { style: { color: partyVar(o.party), marginLeft: i ? '8px' : '0' } }, `${o.party} ${pct(o.p)}`)))) : null);
}

export function measureItem(m) {
  return h('div', { class: 'measure' },
    h('h4', null, m.name),
    h('p', null, m.description),
    h('div', { class: 'xs muted', style: { marginTop: '4px' } }, `${m.origin || ''}${m.origin ? ' · ' : ''}${m.status || ''}`));
}

export const title = (code) => store.stateByCode[code]?.name || 'State';
void num; void partyChip; void probMini; void PARTY_NAME;
