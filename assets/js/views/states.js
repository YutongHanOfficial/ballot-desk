// States index and individual state pages.
import { h, pct, num, partyChip, partyVar, ratingChip, sortableTable, esc, PARTY_NAME } from '../ui.js';
import { store, cur } from '../store.js';
import { raceCard, raceColumns, electionBanner, pollCloseText } from './common.js';
import { stateGrid } from './home.js';
import { usMap, mapLegend, probMini, BAND_LEGEND } from '../charts.js';
import { stateDistrictMap } from '../maps.js';

export function renderIndex(root) {
  const fill = (code) => {
    const rs = (store.byState[code] || []).filter(r => r.type === 'house');
    if (!rs.length) return 'var(--none)';
    const dShare = rs.reduce((s, r) => s + dWin(r), 0) / rs.length;
    return dShare >= 0.5 ? `color-mix(in srgb, var(--dem) ${Math.round(30 + (dShare - 0.5) * 140)}%, var(--surface))` : `color-mix(in srgb, var(--rep) ${Math.round(30 + (0.5 - dShare) * 140)}%, var(--surface))`;
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
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Projected share of each state’s House delegation'), usMap({ fill, onClick: (c) => { location.hash = `#/state/${c}`; }, tip }),
      mapLegend([['var(--dem)', 'More Democratic'], ['var(--rep)', 'More Republican']])),
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
    h('div', { class: 'eyebrow' }, h('a', { href: '#/states' }, 'States'), h('span', null, '›'), h('span', null, st.name)),
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
      h('div', { class: 'card', style: { marginBottom: '14px' } },
        h('div', { class: 'card-title' }, `${st.name}'s ${house.length > 1 ? `${house.length} districts` : 'at-large district'}`, h('span', { class: 'muted', style: { textTransform: 'none', letterSpacing: 0 } }, '2026 lines · tap a district')),
        stateDistrictMap(code, { zoomKey: `state-${code}` }), mapLegend(BAND_LEGEND.slice(0, 8))),
      sortableTable(raceColumns({ type: 'house' }), house, { sortKey: 'race', desc: false, onRow: r => { location.hash = r.url; }, stateKey: `state-${code}` })));
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
