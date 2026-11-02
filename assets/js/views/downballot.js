// Down-ballot statewide offices, state legislatures and ballot measures.
import { h, sortableTable, ratingChip, pct, partyVar } from '../ui.js';
import { store, racesOf, OFFICE } from '../store.js';
import { raceColumns, electionBanner } from './common.js';
import { legisCard, measureItem } from './states.js';

export function render(root, params = {}) {
  const tab = params.tab || 'offices';
  const tabs = [['offices', 'Statewide offices'], ['legislatures', 'Legislatures'], ['measures', 'Ballot measures']];
  root.append(electionBanner() || '',
    h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, 'Down-ballot'),
      h('h1', null, 'Beyond Congress and governors'),
      h('p', { class: 'dek' }, 'Lieutenant governors, attorneys general and secretaries of state, who will run the 2028 election in many states; control of 88 legislative chambers; and the ballot measures voters will decide directly.')),
    h('div', { class: 'seg', style: { marginBottom: '18px' } }, tabs.map(([k, l]) => h('button', { type: 'button', class: k === tab ? 'on' : '', onclick: () => { location.hash = `#/downballot/${k}`; } }, l))));

  if (tab === 'offices') {
    for (const type of ['ag', 'sos', 'ltgov']) {
      const rows = racesOf(type);
      root.append(h('section', { class: 'section' },
        h('div', { class: 'section-head' }, h('div', null, h('h2', null, OFFICE[type].plural), h('p', null, `${rows.length} races. Forecasts use partisan lean, Sabato’s ratings, polls and Polymarket where available.`))),
        sortableTable(raceColumns({ type }), rows, { sortKey: 'p', onRow: r => { location.hash = r.url; }, stateKey: `down-${type}` })));
    }
  } else if (tab === 'legislatures') {
    const L = store.base.legislatures.slice().sort((a, b) => Math.abs(score(a)) - Math.abs(score(b)));
    const cols = [
      { key: 'ch', label: 'Chamber', render: l => h('a', { class: 'race-name', href: `#/state/${l.state}` }, `${store.stateByCode[l.state].name} ${l.chamber}`), sort: l => `${store.stateByCode[l.state].name} ${l.chamber}`, defaultAsc: true },
      { key: 'last', label: 'Current', render: l => l.last || '—', hideSm: true },
      { key: 'up', label: 'Seats up', num: true, render: l => l.seatsUp ? `${l.seatsUp}/${l.seatsTotal}` : '—', hideSm: true },
      { key: 'r', label: 'Ratings', render: l => h('div', { class: 'chips' }, Object.entries(l.ratings || {}).map(([n, r]) => ratingChip({ ...r, label: `${n}: ${r.label}` }))), sort: l => Math.abs(score(l)), defaultAsc: true },
      { key: 'm', label: 'Polymarket', num: true, render: l => { const m = store.markets.legislatures?.[l.id]; if (!m) return h('span', { class: 'muted' }, '—'); const top = m.outcomes.filter(o => o.party)[0]; return top ? h('b', { style: { color: partyVar(top.party) } }, `${top.party} ${pct(top.p)}`) : '—'; } },
    ];
    root.append(h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'Legislative chambers'), h('p', null, 'Sorted from most to least competitive by average rating.'))),
      sortableTable(cols, L, { sortKey: 'r', desc: false, onRow: l => { location.hash = `#/state/${l.state}`; }, stateKey: 'legislatures' })));
    const withMarkets = L.filter(l => store.markets.legislatures?.[l.id]);
    if (withMarkets.length) root.append(h('section', { class: 'section' }, h('h3', { style: { marginBottom: '12px' } }, 'Chambers with prediction markets'), h('div', { class: 'grid g3' }, withMarkets.map(legisCard))));
  } else {
    const byState = {};
    for (const m of store.base.measures) (byState[m.state] ||= []).push(m);
    root.append(h('p', { class: 'muted' }, `${store.base.measures.length} statewide measures on the Nov. 3 ballot across ${Object.keys(byState).length} states.`));
    for (const st of store.states) {
      const ms = byState[st.code];
      if (!ms) continue;
      root.append(h('section', { class: 'section', style: { marginTop: '22px' } },
        h('div', { class: 'section-head', style: { marginBottom: '8px' } }, h('h3', null, h('a', { href: `#/state/${st.code}`, style: { textDecoration: 'none' } }, st.name)), h('span', { class: 'small muted' }, `${ms.length} measure${ms.length === 1 ? '' : 's'}`)),
        h('div', { class: 'card' }, ms.map(measureItem))));
    }
  }
}

function score(l) {
  const v = Object.values(l.ratings || {}).map(r => r.score);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 9;
}

export const title = () => 'Down-ballot races';
