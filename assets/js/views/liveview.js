// Election-night dashboard. From late afternoon on Election Day until the counting is done it is also the front page.
import { h, pct, num, partyVar, partyChip, probColor, timeAgo, fmtTimeET, lastName, marginText, sortableTable } from '../ui.js';
import { store, cur, chamber, marketControl, racesOf, nightMode, awaiting, raceFill } from '../store.js';
import { calledSeats, resultsEnabled, wantCounties, houseVote } from '../live.js';
import { CONFIG, POLL_CLOSE_ET, pollCloseDate } from '../config.js';
import { raceCard, CHAMBERS, countdown } from './common.js';
import { eventsSoFar, clockLabel } from '../sim.js';
import { competitive, stateFill, stateTip } from './home.js';
import { usMap, mapLegend, splitBar, probMini, probCell, RESULT_LEGEND, BAND_LEGEND } from '../charts.js';
import { houseMap, countyMap } from '../maps.js';

/** The side a probability favours: { party, tag: 'D' / 'R' / an independent's surname, q: its chance }. */
function favOdds(r, p) {
  const left = p >= 0.5;
  const party = left ? r.leftParty : r.rightParty;
  return { party, tag: party === 'D' || party === 'R' ? party : lastName(left ? r.left : r.right), q: Math.min(0.999, Math.max(p, 1 - p)) };
}

/** Party a race has gone to (called) or is heading to (live favourite); null if unknown. */
function winnerOrFav(r) {
  const res = store.live.results[r.id];
  if (res?.called) return res.called === 'left' ? r.leftParty : res.called === 'right' ? r.rightParty : 'O';
  if (!r.left || !r.right) return r.left ? r.leftParty : r.rightParty;
  const p = cur(r).p;
  return p === null || p === undefined ? null : p >= 0.5 ? r.leftParty : r.rightParty;
}

// ------------------------------------------------------------------------------------------- chambers

/** Seats won so far, and the live chance of control from our model and from Polymarket. */
function chamberLive(type) {
  const C = CHAMBERS[type];
  const s = calledSeats(type);
  const total = C.total;
  const und = Math.max(0, total - s.D - s.R - s.O);
  const ch = chamber(type);
  const bar = h('div', { style: { position: 'relative', marginTop: '22px' } },
    h('div', { class: 'split-bar', style: { height: '26px', borderRadius: '6px' } },
      h('span', { style: { width: `${(s.D / total) * 100}%`, background: 'var(--dem)' } }),
      h('span', { style: { width: `${(und / total) * 100}%`, background: 'var(--none)' } }),
      s.O ? h('span', { style: { width: `${(s.O / total) * 100}%`, background: 'var(--oth)' } }) : null,
      h('span', { style: { width: `${(s.R / total) * 100}%`, background: 'var(--rep)' } })),
    h('div', { class: 'strip-mark', style: { left: `calc(${(C.need / total) * 100}% - 1px)`, top: '-18px', bottom: '-4px' } }, h('span', null, `${C.need} to win`)));

  let odds;
  if (type === 'gov') {
    const d = Math.round(ch.dSeats.mean);
    odds = h('div', { class: 'cl-odds' },
      h('div', { class: 'cl-title' }, h('span', null, ch.live ? 'Projected after counting' : 'Forecast')),
      h('div', { class: 'cl-row gov' }, h('b', { class: 'c-dem' }, `${d} D`), splitBar(d / 50, 1 - d / 50, { height: 8 }), h('b', { class: 'c-rep' }, `${50 - d} R`)),
      h('div', { class: 'xs muted' }, `80% range: ${ch.dSeats.p10}–${ch.dSeats.p90} Democratic governors`));
  } else {
    const mk = store.sim ? null : marketControl(type);
    const row = (label, pD, pR, pO = 0) => h('div', { class: 'cl-row' }, h('span', { class: 'cl-k' }, label),
      h('b', { class: 'c-dem' }, pct(pD)), splitBar(pD, pR, { pO, height: 8 }), h('b', { class: 'c-rep' }, pct(pR)));
    odds = h('div', { class: 'cl-odds' },
      h('div', { class: 'cl-title' }, h('span', null, ch.live ? 'Live chance of control' : 'Chance of control'), h('span', null, h('span', { class: 'c-dem' }, 'Dem.'), ' · ', h('span', { class: 'c-rep' }, 'Rep.'))),
      row(ch.live ? 'Our model' : 'Our forecast', ch.pD, ch.pR, ch.pNeither || 0),
      mk && mk.pD !== null && mk.pD !== undefined ? row('Polymarket', mk.pD, mk.pR ?? 1 - mk.pD) : null);
  }

  return h('div', { class: 'card chamber-live' },
    h('div', { class: 'chamber-top' }, h('a', { class: 'chamber-name', href: C.url, style: { textDecoration: 'none' } }, C.name),
      ch.live ? h('span', { class: 'pill live' }, h('span', { class: 'live-dot' }), 'Live') : h('span', { class: 'pill' }, 'Before results')),
    h('div', { class: 'odds-row', style: { marginTop: '6px' } },
      h('div', { class: 'odds dem' }, h('span', { class: 'pct' }, s.D), h('span', { class: 'who c-dem' }, 'Democrats')),
      h('div', { class: 'odds rep right' }, h('span', { class: 'pct' }, s.R), h('span', { class: 'who c-rep' }, 'Republicans'))),
    bar,
    h('div', { class: 'compare-line', style: { marginTop: '10px' } },
      h('span', null, h('b', null, und), ` ${type === 'gov' ? 'governorships' : 'seats'} not yet called`),
      type === 'house' ? null : h('span', null, 'Includes seats not up'),
      s.O ? h('span', null, h('b', null, s.O), ' other') : null),
    odds);
}

// ------------------------------------------------------------------------------------------- scoreboard

/** House popular vote, votes counted, races called and pickups so far. */
function nightStats() {
  const v = houseVote();
  const label = { senate: 'Senate', house: 'House', gov: 'Governors' };
  const types = ['senate', 'house', 'gov'];
  const called = types.map(t => {
    const rs = racesOf(t).filter(r => r.left || r.right);
    return [t, rs.filter(r => store.live.results[r.id]?.called).length, rs.length];
  });
  const pickups = types.map(t => {
    const g = { D: 0, R: 0, O: 0 };
    for (const r of racesOf(t)) {
      const res = store.live.results[r.id];
      if (!res?.called || !r.holder) continue;
      const party = winnerOrFav(r);
      if (party && party !== r.holder) g[party === 'D' || party === 'R' ? party : 'O']++;
    }
    return [t, g];
  });
  const share = (x) => `${((x / v.total) * 100).toFixed(1)}%`;
  return h('section', { class: 'card night-stats' },
    h('div', { class: 'ns-cell' },
      h('div', { class: 'ns-k' }, 'House popular vote'),
      v ? [
        h('div', { class: 'ns-pv' }, h('span', null, h('b', { class: 'c-dem' }, share(v.D)), ' Dem.'), h('span', null, 'Rep. ', h('b', { class: 'c-rep' }, share(v.R)))),
        splitBar(v.D / v.total, v.R / v.total, { pO: v.O / v.total, height: 8 }),
        h('div', { class: 'xs muted', style: { marginTop: '6px' } }, `${num(v.D)} to ${num(v.R)}`),
      ] : h('div', { class: 'muted small' }, 'No votes counted yet')),
    h('div', { class: 'ns-cell' }, h('div', { class: 'ns-k' }, 'Votes counted'), h('div', { class: 'ns-big' }, v ? num(v.total) : '0'),
      h('div', { class: 'xs muted' }, v && v.eevp ? `House races · about ${Math.round(v.eevp)}% of the expected vote` : 'House races')),
    h('div', { class: 'ns-cell' }, h('div', { class: 'ns-k' }, 'Races called'),
      called.map(([t, n, of]) => h('div', { class: 'ns-line' }, h('span', null, label[t]), h('span', null, h('b', null, n), ` of ${of}`)))),
    h('div', { class: 'ns-cell' }, h('div', { class: 'ns-k' }, 'Pickups so far'),
      pickups.map(([t, g]) => h('div', { class: 'ns-line' }, h('span', null, label[t]),
        h('span', null, h('b', { class: 'c-dem' }, `D +${g.D}`), '  ', h('b', { class: 'c-rep' }, `R +${g.R}`), g.O ? h('b', null, `  Oth. +${g.O}`) : null)))));
}

// ------------------------------------------------------------------------------------------- maps

const HERO = { tab: 'senate', mode: 'results' };

/** Each race's live chance of winning, in the forecast's colours (called races are certain). */
function oddsFill(r) {
  if (!r) return 'var(--none)';
  if (!r.left || !r.right) return partyVar((r.left ? r.leftParty : r.rightParty) || r.samePartyGeneral, 1);
  return probColor(cur(r).p, r.leftParty, r.rightParty);
}

/** The big map at the top: Senate, governors or House, by results so far or by live odds. */
function heroMap() {
  const night = nightMode();
  const tabs = [['senate', 'Senate'], ['gov', 'Governors'], ['house', 'House']];
  const modes = [['results', 'Results'], ['odds', 'Live odds']];
  const seg = h('div', { class: 'seg' });
  const modeSeg = h('div', { class: 'seg' });
  const hint = h('span', { class: 'xs muted' });
  const body = h('div');
  const summary = h('div', { class: 'compare-line', style: { marginTop: '10px' } });
  const draw = () => {
    const type = HERO.tab;
    const odds = night && HERO.mode === 'odds';
    seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', tabs[i][0] === type));
    modeSeg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', modes[i][0] === HERO.mode));
    const fill = odds ? oddsFill : raceFill;
    const legend = night && !odds ? RESULT_LEGEND : BAND_LEGEND.slice(0, 8);
    if (type === 'house') body.replaceChildren(houseMap({ id: 'live-house', caption: false, fill, legend }));
    else {
      const go = (code) => { const r = store.races.find(x => x.type === type && x.state === code && !x.special) || store.races.find(x => x.type === type && x.state === code); if (r) location.hash = r.url; };
      body.replaceChildren(usMap({ fill: stateFill(type, fill), tip: stateTip(type), onClick: go }), mapLegend(legend));
    }
    hint.textContent = !night ? 'Colored by our forecast until results arrive' : odds ? 'Each race’s live chance of winning' : 'Solid = projected winner · light = leading';
    const races = racesOf(type).filter(r => r.left || r.right);
    const called = races.filter(r => store.live.results[r.id]?.called).length;
    const counting = races.filter(r => { const x = store.live.results[r.id]; return x && x.total > 0 && !x.called; }).length;
    const waiting = races.filter(r => awaiting(r)).length;
    summary.replaceChildren(
      h('span', null, h('b', null, called), ` of ${races.length} races projected`),
      night ? h('span', null, h('b', null, counting), ' counting · ', h('b', null, waiting), ' polls still open') : h('span', null, 'Click a state or district for its race'));
  };
  tabs.forEach(([k, label]) => seg.appendChild(h('button', { type: 'button', onclick: () => { HERO.tab = k; draw(); } }, label)));
  modes.forEach(([k, label]) => modeSeg.appendChild(h('button', { type: 'button', onclick: () => { HERO.mode = k; draw(); } }, label)));
  draw();
  return h('section', { class: 'section card hero-map' },
    h('div', { class: 'map-toolbar' }, h('div', { class: 'hero-controls' }, seg, night ? modeSeg : null), hint),
    body, summary);
}

/** Small-multiple county maps of the most competitive statewide races, with votes and live odds. */
function battlegrounds() {
  const list = store.races.filter(r => (r.type === 'senate' || r.type === 'gov') && r.left && r.right && r.state !== 'AK' && r.p !== null)
    .sort((a, b) => Math.abs(a.p - 0.5) - Math.abs(b.p - 0.5)).slice(0, 8);
  if (nightMode() && !store.sim) wantCounties(list.map(r => r.id));
  const card = (r) => {
    const c = cur(r);
    const res = c.result;
    const tot = res?.total || 0;
    const line = (side) => {
      const name = side === 'left' ? r.left : r.right, party = side === 'left' ? r.leftParty : r.rightParty;
      const votes = res ? (side === 'left' ? res.left : res.right) : 0;
      const won = res?.called === side;
      return h('div', { class: 'bg-cand' }, partyChip(party),
        h('span', { class: 'nm' }, lastName(name), won ? h('span', { class: 'winner-check', style: { marginLeft: '5px' } }, '✓') : null),
        tot ? [h('span', { class: 'bg-votes' }, num(votes)), h('b', { style: { color: partyVar(party) } }, `${((votes / tot) * 100).toFixed(1)}%`)] : null);
    };
    const f = favOdds(r, c.p ?? 0.5);
    const m = c.marketP !== null && c.marketP !== undefined && !store.sim ? favOdds(r, c.marketP) : null;
    const odds = res?.called
      ? h('div', { class: 'bg-odds' }, h('span', { class: 'muted' }, store.sim ? 'Projected winner (simulated desk)' : 'Projected winner (AP)'))
      : h('div', { class: 'bg-odds' }, probMini(c.p ?? 0.5, r),
        h('span', null, h('b', { style: { color: partyVar(f.party) } }, `${f.tag} ${pct(f.q)}`), c.live ? ' live odds' : ' to win'),
        m ? h('span', { class: 'muted' }, `Polymarket ${m.tag} ${pct(m.q)}`) : null);
    const status = res?.called ? h('span', { class: 'pill called' }, 'Projected')
      : awaiting(r) ? h('span', { class: 'pill' }, `Polls close ${fmtTimeET(pollCloseDate(r.state)).replace(' ET', '')}`)
      : tot ? h('span', { class: 'pill live' }, `${Math.round(c.eevp)}% counted`) : h('span', { class: 'pill' }, nightMode() ? 'Awaiting votes' : r.office);
    return h('a', { class: 'bg-card', href: r.url },
      h('div', { class: 'bg-head' }, h('b', null, `${r.stateName} ${r.office === 'Governor' ? 'Gov.' : 'Sen.'}${r.special ? ' (S)' : ''}`), status),
      h('div', { class: 'bg-cands' }, line('left'), line('right')),
      odds,
      countyMap(r.state, { raceId: r.id, width: 380, maxHeight: 250, compact: true }));
  };
  return h('div', { class: 'card span2' },
    h('div', { class: 'card-title' }, 'Battlegrounds, county by county', h('span', { class: 'muted', style: { textTransform: 'none', letterSpacing: 0 } }, nightMode() ? 'Shaded by leader and margin' : 'Shaded by the 2024 vote until counting starts')),
    h('div', { class: 'bg-grid' }, list.map(card)));
}

// ------------------------------------------------------------------------------------------- every race

const RES = { type: 'senate', filter: 'all', q: '' };
const FILTERS = [['all', 'All'], ['close', 'Competitive'], ['counting', 'Counting'], ['called', 'Called'], ['flips', 'Flips'], ['waiting', 'No votes yet']];

function statusKey(r) {
  const res = store.live.results[r.id];
  if (res?.called) return 4;
  if (res?.runoff) return 3.5;
  if (res && res.total > 0) return 2 + (res.eevp || 0) / 100;
  return awaiting(r) || !nightMode() ? 0 : 1;
}

function statusCell(r) {
  const res = store.live.results[r.id];
  if (res?.called) return h('span', { class: 'pill called' }, 'Called');
  if (res?.runoff) return h('span', { class: 'pill' }, 'Runoff');
  if (res && res.total > 0) {
    const e = res.eevp || 0;
    return h('div', { class: 'res-status' }, h('span', { class: 'tnum' }, `${Math.round(e)}%`), h('span', { class: 'eevp-bar' }, h('i', { style: { width: `${Math.min(100, e)}%` } })));
  }
  const close = pollCloseDate(r.state);
  if ((awaiting(r) || !nightMode()) && close) return h('span', { class: 'muted small nowrap' }, `Polls close ${fmtTimeET(close).replace(' ET', '')}`);
  return h('span', { class: 'muted small nowrap' }, 'No votes yet');
}

function candResult(r, side) {
  const name = side === 'left' ? r.left : r.right;
  if (!name) return h('span', { class: 'muted' }, '—');
  const party = side === 'left' ? r.leftParty : r.rightParty;
  const res = store.live.results[r.id];
  const tot = res?.total || 0;
  const votes = res ? (side === 'left' ? res.left : res.right) : 0;
  const other = res ? (side === 'left' ? res.right : res.left) : 0;
  const won = res?.called === side;
  return h('div', { class: 'res-cand' },
    h('div', { class: 'cand-line' }, partyChip(party), h('span', { class: 'nm', style: { fontWeight: won || (tot && votes > other) ? 700 : 500 } }, name),
      won ? h('span', { class: 'winner-check', title: 'Projected winner' }, '✓') : null),
    tot ? h('div', { class: 'res-votes' }, h('b', { style: { color: partyVar(party) } }, `${((votes / tot) * 100).toFixed(1)}%`), h('span', null, num(votes))) : null);
}

function voteMargin(r) {
  const res = store.live.results[r.id];
  return r.left && r.right && res && res.total > 0 ? ((res.left - res.right) / res.total) * 100 : null;
}

function resultColumns() {
  return [
    { key: 'race', label: 'Race', render: r => h('a', { class: 'race-name', href: r.url }, r.type === 'house' ? r.short : r.stateName + (r.special ? ' (special)' : '')), sort: r => r.type === 'house' ? r.id : r.stateName, defaultAsc: true },
    { key: 'status', label: 'Counted', render: statusCell, sort: statusKey },
    { key: 'left', label: 'Democrat / Ind.', render: r => candResult(r, 'left') },
    { key: 'right', label: 'Republican', render: r => candResult(r, 'right') },
    { key: 'margin', label: 'Vote margin', num: true, hideSm: true, render: r => { const m = voteMargin(r); return m === null ? h('span', { class: 'muted' }, '—') : h('span', { class: 'tnum' }, marginText(m, r)); }, sort: voteMargin },
    { key: 'p', label: 'Chance of winning', num: true, render: r => r.left && r.right ? probCell(r) : h('span', { class: 'muted small' }, 'Uncontested'), sort: r => { const p = cur(r).p; return p === null || !r.left || !r.right ? null : -Math.abs(p - 0.5); } },
    { key: 'mk', label: 'Polymarket', num: true, hideSm: true, render: r => { const p = cur(r).marketP; if (p === null || p === undefined || !r.left || !r.right || store.sim) return h('span', { class: 'muted' }, '—'); const m = favOdds(r, p); return h('span', { class: 'tnum' }, `${m.tag} ${pct(m.q)}`); }, sort: r => cur(r).marketP },
  ];
}

function matches(r, filter, q) {
  const res = store.live.results[r.id];
  const p = cur(r).p;
  if (filter === 'close' && !(r.left && r.right && !res?.called && p > 0.05 && p < 0.95)) return false;
  if (filter === 'counting' && !(res && res.total > 0 && !res.called)) return false;
  if (filter === 'called' && !res?.called) return false;
  if (filter === 'waiting' && (res?.called || (res && res.total > 0))) return false;
  if (filter === 'flips') { const w = winnerOrFav(r); if (!w || !r.holder || w === r.holder) return false; }
  if (q) {
    const hay = `${r.title} ${r.short} ${r.stateName} ${r.state} ${r.left || ''} ${r.right || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Every Senate, governor and House race: votes, share counted, live odds and market price. */
function resultsSection() {
  const types = [['senate', 'Senate'], ['gov', 'Governors'], ['house', 'House']];
  const typeSeg = h('div', { class: 'seg' });
  const filterSeg = h('div', { class: 'seg' });
  const input = h('input', { type: 'search', placeholder: 'Search state, district or candidate…', value: RES.q, 'aria-label': 'Search races' });
  const holder = h('div');
  const draw = () => {
    typeSeg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', types[i][0] === RES.type));
    filterSeg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', FILTERS[i][0] === RES.filter));
    const q = RES.q.trim().toLowerCase();
    const rows = racesOf(RES.type).filter(r => matches(r, RES.filter, q));
    holder.replaceChildren(sortableTable(resultColumns(), rows, { sortKey: 'race', desc: false, onRow: r => { location.hash = r.url; }, stateKey: `live-${RES.type}`, limit: 50 }));
  };
  types.forEach(([k, label]) => typeSeg.appendChild(h('button', { type: 'button', onclick: () => { RES.type = k; draw(); } }, label)));
  FILTERS.forEach(([k, label]) => filterSeg.appendChild(h('button', { type: 'button', onclick: () => { RES.filter = k; draw(); } }, label)));
  input.addEventListener('input', () => { RES.q = input.value; draw(); });
  draw();
  return h('section', { class: 'section', id: 'every-race' },
    h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'Every race, live'),
      h('p', null, nightMode() ? 'Votes counted so far, the share of the expected vote that is in, and each race’s live chance of winning.' : 'Vote counts fill in here as polls close. Until then: our forecast and Polymarket’s price.'))),
    h('div', { class: 'toolbar' }, typeSeg, filterSeg, h('div', { class: 'search' }, input)),
    holder);
}

// ------------------------------------------------------------------------------------------- timeline

function timeline() {
  const groups = {};
  for (const [st, t] of Object.entries(POLL_CLOSE_ET)) (groups[t] ||= []).push(st);
  const order = Object.keys(groups).sort((a, b) => pollCloseDate(groups[a][0]) - pollCloseDate(groups[b][0]));
  return h('div', { class: 'timeline' }, order.map(t => {
    const d = pollCloseDate(groups[t][0]);
    const past = Date.now() >= d;
    const states = groups[t].filter(s => store.stateByCode[s]).sort();
    const key = states.flatMap(s => (store.byState[s] || []).filter(r => (r.type === 'senate' || r.type === 'gov') && r.left && r.right && Math.abs((cur(r).p ?? 0.5) - 0.5) < 0.35));
    return h('div', { class: `tl-row${past ? ' past' : ''}` },
      h('div', { class: 't' }, fmtTimeET(d).replace(' ET', '')),
      h('div', null,
        h('div', { class: 'chips' }, states.map(s => h('a', { href: `#/state/${s}` }, s))),
        key.length ? h('div', { class: 'xs muted', style: { marginTop: '5px' } }, 'Watch: ', key.map((r, i) => [i ? ', ' : '', h('a', { href: r.url }, `${r.stateName} ${r.office.toLowerCase()}`)])) : null));
  }));
}

// ------------------------------------------------------------------------------------------- page

export function render(root) {
  const enabled = resultsEnabled();
  const live = store.live;
  const last = Object.values(live.resultsAt || {}).sort().pop();
  const first = Date.parse(CONFIG.firstPollsClose);
  const beforePolls = !store.sim && !live.active && Date.now() < first;
  root.append(h('header', { class: 'page-head' },
    h('div', { class: 'eyebrow' }, live.active ? h('span', { class: 'live-dot' }) : null, 'Election night', h('span', null, '·'),
      live.demo ? 'Simulated results' : last ? `Results updated ${timeAgo(last)}` : 'Waiting for results'),
    h('h1', null, live.active ? 'Live results and projections' : 'Election night: live results'),
    h('p', { class: 'dek' }, live.demo
      ? 'Simulated returns generated from the forecast, replaying an election night so you can see how this page behaves. None of these numbers are real.'
      : live.active
        ? 'Vote counts from the Associated Press (via The New York Times), our live projection of every race as ballots are counted, and live Polymarket prices. Calls are the AP’s.'
        : beforePolls
          ? 'The first polls close at 6 p.m. Eastern in parts of Indiana and Kentucky. Vote counts, live odds and maps fill in on their own from then; there’s no need to refresh.'
          : enabled
            ? 'Polls are closing. Counts will appear here automatically; this page refreshes itself.'
            : 'Results start flowing after the first polls close at 6 p.m. Eastern on Tuesday, Nov. 3. Leave this page open: it updates on its own.',
      ' ', live.demo ? null : h('a', { href: '#/forecast' }, 'See the pre-election forecast'), live.demo || live.active ? null : [' or ', h('a', { href: '#/simulate' }, 'simulate election night')], live.demo ? null : '.')));

  if (beforePolls) {
    root.append(h('div', { class: 'banner' }, h('div', { class: 'grow' }, h('b', null, 'First polls close in'), h('div', { class: 'xs muted' }, 'Indiana and Kentucky at 6 p.m. Eastern; the last, in Alaska, at 1 a.m.')), countdown(first)));
  }
  if (store.sim && !live.active) {
    root.append(h('div', { class: 'banner live' }, h('span', { class: 'live-dot' }), h('div', { class: 'grow' }, h('b', null, `${clockLabel(store.sim.t)}. `), 'Polls are about to close. The first results arrive shortly after 6 p.m.')));
  }
  if (live.resultsOk === false && enabled && !live.demo) {
    root.append(h('div', { class: 'banner' }, h('div', { class: 'grow' }, h('b', null, 'The results feed is not reachable right now. '), 'Showing the pre-election forecast and live Polymarket prices; counts will appear when the feed responds.')));
  }

  root.append(h('div', { class: 'grid g3' }, chamberLive('senate'), chamberLive('house'), chamberLive('gov')));
  if (live.active) root.append(nightStats());
  root.append(heroMap());

  const feed = eventFeed();
  root.append(h('section', { class: 'section grid g3 bg-row' }, battlegrounds(),
    feed || h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Election night, as it happens'), h('p', { class: 'muted small', style: { margin: 0 } }, 'Poll closings and projections will appear here through the night.'))));

  if (live.active && live.swing && live.swing.n >= 3) {
    const sw = live.swing.swing;
    root.append(h('div', { class: 'notice' }, `In the ${live.swing.n} races that are mostly counted, the left-side candidate is running `,
      h('b', null, `${Math.abs(sw).toFixed(1)} points ${sw >= 0 ? 'ahead of' : 'behind'}`), ' our pre-election forecast. The live model shifts uncounted races by that amount.'));
  }

  if (live.active) {
    const counting = racesOf('senate').concat(racesOf('gov'), racesOf('house')).filter(r => { const res = live.results[r.id]; return res && res.total > 0 && !res.called && r.left && r.right; });
    const close = counting.sort((a, b) => Math.abs(cur(a).p - 0.5) - Math.abs(cur(b).p - 0.5)).slice(0, 12);
    root.append(h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'Too close to call'), h('p', null, 'Uncalled races with votes counted, closest first: vote share, votes and each race’s live chance of winning.'))),
      close.length ? h('div', { class: 'race-cards' }, close.map(r => raceCard(r))) : h('div', { class: 'card empty' }, 'No uncalled races with votes yet.')));
  } else {
    root.append(h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'House races to watch'), h('p', null, 'These switch to live counts as soon as votes are reported.'))),
      h('div', { class: 'race-cards' }, competitive('house', 6).map(r => raceCard(r)))));
  }

  root.append(resultsSection());

  root.append(h('section', { class: 'section grid g2' },
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'When polls close (Eastern time)'), timeline()),
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'How to read election night'),
      h('div', { class: 'prose', style: { fontSize: '14px' } },
        h('p', null, h('b', null, 'Maps'), ' turn light when a candidate leads and solid when a race is projected. Switch to ', h('i', null, 'Live odds'), ' to color each race by its live chance of winning instead. Counties are shaded by who leads them and by how much.'),
        h('p', null, h('b', null, 'Expected vote counted'), ' is the AP’s estimate of the share of all ballots that have been tallied. Early returns can lean heavily toward one party depending on whether mail, early or Election Day votes are counted first.'),
        h('p', null, h('b', null, 'Live odds'), ' come from our model, which blends the counted vote with the pre-election forecast in proportion to how much is left and nudges uncounted races by how far results are running from expectations elsewhere. Polymarket’s prices are shown alongside for comparison.'),
        h('p', null, h('b', null, 'Calls'), ' come from the Associated Press. Close races, ranked-choice tabulation in Alaska and Maine, and Georgia’s 50% runoff rule can delay outcomes for days.'),
        h('p', { class: 'muted', style: { marginBottom: 0 } }, `Results refresh every ${CONFIG.results.refreshSec.senate} seconds (House every ${Math.round(CONFIG.results.refreshSec.house / 60)} minutes); markets every ${CONFIG.markets.nightRefreshSec} seconds.`)))));
}

// ------------------------------------------------------------------------------------------- feed

const FEED = { all: false };

/** When AP calls (plus seats not up) first give a party a majority: replayed from the order of the calls. */
function controlEvents() {
  const out = [];
  const now = Date.now();
  for (const type of ['senate', 'house']) {
    const C = CHAMBERS[type];
    const tally = type === 'senate' ? { ...store.base.chambers.senate.notUp } : { D: 0, R: 0 };
    const seq = [];
    for (const r of racesOf(type)) {
      const res = store.live.results[r.id];
      const close = pollCloseDate(r.state);
      if (res?.called === 'left' || res?.called === 'right') seq.push({ d: new Date(res.calledAt || now), party: res.called === 'left' ? r.leftParty : r.rightParty });
      else if (r.settled && close && close <= now) seq.push({ d: close, party: r.left ? r.leftParty : r.rightParty });
    }
    seq.sort((a, b) => a.d - b.d);
    for (const e of seq) {
      if (e.party !== 'D' && e.party !== 'R') continue;
      tally[e.party] = (tally[e.party] || 0) + 1;
      if (tally[e.party] >= (e.party === 'R' ? C.needR : C.need)) {
        // Republicans hold both chambers going in.
        out.push({ d: e.d, kind: 'control', party: e.party, text: `Projection: ${e.party === 'D' ? 'Democrats win' : 'Republicans keep'} control of the ${C.name}.` });
        break;
      }
    }
  }
  return out;
}

/** Election-night ticker: poll closings, projections and chamber calls, newest first. */
function eventFeed() {
  let items;
  if (store.sim) {
    items = eventsSoFar().map(e => ({ ...e, when: clockLabel(e.t, { short: true }) }));
  } else if (store.live.active) {
    const now = Date.now();
    const closes = {};
    for (const [st, t] of Object.entries(POLL_CLOSE_ET)) if (store.stateByCode[st]) (closes[t] ||= []).push(st);
    items = Object.values(closes).map(sts => ({ d: pollCloseDate(sts[0]), kind: 'close', text: `Polls close in ${sts.map(s => store.stateByCode[s].name).sort().join(', ')}.` }))
      .filter(e => e.d <= now);
    for (const r of store.races) {
      const res = store.live.results[r.id];
      if (!res || !res.called || !res.calledAt || !r.left || !r.right) continue;
      const party = res.called === 'left' ? r.leftParty : r.rightParty;
      const name = res.called === 'left' ? r.left : r.right;
      items.push({ d: new Date(res.calledAt), kind: 'call', party, id: r.id, text: `AP: ${name} (${party}) wins ${r.title}${r.holder && party !== r.holder ? ', a pickup' : ''}.` });
    }
    items.push(...controlEvents());
    const order = { close: 0, call: 1, control: 2 };
    items.sort((a, b) => (b.d - a.d) || (order[b.kind] - order[a.kind]));
    items = items.map(e => ({ ...e, when: fmtTimeET(e.d).replace(' ET', '') }));
  } else return null;
  if (!items.length) return null;
  const shown = FEED.all ? items : items.slice(0, 12);
  const icon = (k, party) => {
    const sym = { close: '◷', call: '✓', batch: '✓', control: '★', info: 'ℹ', final: '■' }[k] || '•';
    return h('span', { class: `feed-icon ${k}`, style: party ? { background: partyVar(party), color: '#fff' } : null }, sym);
  };
  return h('section', { class: 'card feed' },
    h('div', { class: 'card-title' }, store.sim ? 'Election night, as it happens (simulated)' : 'Election night, as it happens',
      items.length > 12 ? h('button', { type: 'button', class: 'linkish', onclick: () => { FEED.all = !FEED.all; const p = document.querySelector('.feed'); if (p) p.replaceWith(eventFeed()); } }, FEED.all ? 'Show fewer' : `Show all ${items.length}`) : null),
    h('ol', { class: 'feed-list' }, shown.map(e => h('li', { class: `feed-item ${e.kind}${e.big || e.kind === 'control' ? ' big' : ''}` },
      h('span', { class: 'feed-time' }, e.when), icon(e.kind, e.party),
      h('span', { class: 'feed-text' }, e.id ? h('a', { href: store.byId[e.id]?.url }, e.text) : e.text)))));
}

export const title = () => 'Live results';
