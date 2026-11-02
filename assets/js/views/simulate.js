// Simulator page: draw one outcome instantly, or launch an election-night replay.
import { h, pct, num, partyVar, partyChip, esc, lastName, PARTY_NAME, sortableTable } from '../ui.js';
import { store } from '../store.js';
import { histogram, usMap, mapLegend } from '../charts.js';
import { houseMap } from '../maps.js';
import { makeScenario, startNight, stopSim, randomSeed, simFill, clockLabel, ensureSimData } from '../sim.js';

const OPTS = { errMode: 'random', err: 0 };   // the polling-error choice survives live re-renders
const CACHE = new Map();

function query() { return new URLSearchParams(location.hash.split('?')[1] || ''); }

function scenarioFor(seed, err) {
  const key = `${seed}|${err}`;
  if (!CACHE.has(key)) CACHE.set(key, makeScenario({ seed, nat: err }));
  return CACHE.get(key);
}

/** Start a replay (same seed = same result), once the county data for county-by-county counting is in. */
function playNight(seed, err) {
  ensureSimData().then(() => {
    startNight(makeScenario({ seed: seed ?? randomSeed(), nat: err }), { speed: 3 });
    location.hash = '#/live';
  });
}

function errText(x) {
  if (Math.abs(x) < 0.05) return 'Polls are dead-on nationally';
  return `${x > 0 ? 'Democrats' : 'Republicans'} beat their polls by ${Math.abs(x).toFixed(1)} point${Math.abs(x) === 1 ? '' : 's'}`;
}

function newQuickHash(seed = randomSeed()) {
  return `#/simulate?seed=${seed}${OPTS.errMode === 'custom' ? `&err=${OPTS.err}` : ''}`;
}

export function render(root) {
  const q = query();
  const seed = q.get('seed') ? parseInt(q.get('seed'), 10) : null;
  if (q.has('err')) { OPTS.errMode = 'custom'; OPTS.err = parseFloat(q.get('err')) || 0; }
  const err = OPTS.errMode === 'custom' ? OPTS.err : null;

  root.append(h('header', { class: 'page-head' },
    h('div', { class: 'eyebrow' }, 'Simulator'),
    h('h1', null, 'Run the 2026 midterms yourself'),
    h('p', { class: 'dek' }, 'Each run draws one plausible result from our forecast. Polling misses ripple across related races, the way they do in real elections. See the outcome at a glance, or replay it as an election night, poll closing by poll closing.')));

  // ---- controls
  const errLabel = h('b', null, errText(OPTS.err));
  const slider = h('input', { type: 'range', min: -8, max: 8, step: 0.5, value: OPTS.err, class: 'err-slider', 'aria-label': 'National polling error' });
  slider.addEventListener('input', () => { OPTS.err = parseFloat(slider.value); errLabel.textContent = errText(OPTS.err); });
  const custom = h('div', { class: 'err-custom', style: { display: OPTS.errMode === 'custom' ? '' : 'none' } },
    h('div', { class: 'err-scale' }, h('span', { class: 'c-rep' }, 'R +8'), slider, h('span', { class: 'c-dem' }, 'D +8')),
    h('div', { class: 'small', style: { textAlign: 'center' } }, errLabel));
  const seg = h('div', { class: 'seg' },
    [['random', 'Let the model decide'], ['custom', 'Set the polling error']].map(([k, label]) => h('button', {
      type: 'button', class: OPTS.errMode === k ? 'on' : '',
      onclick: (e) => { OPTS.errMode = k; custom.style.display = k === 'custom' ? '' : 'none'; e.target.parentNode.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.target)); },
    }, label)));
  const quickBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => { location.hash = newQuickHash(); } }, '🎲  Quick simulation');
  const nightBtn = h('button', { type: 'button', class: 'btn', onclick: () => playNight(seed, OPTS.errMode === 'custom' ? OPTS.err : null) },
    seed !== null ? '▶  Play this result as election night' : '▶  Simulate election night');
  root.append(h('div', { class: 'card sim-controls' },
    h('div', { class: 'sim-control-row' },
      h('div', null, h('div', { class: 'card-title' }, 'National polling error'), seg),
      h('div', { class: 'sim-buttons' }, quickBtn, nightBtn)),
    custom,
    h('p', { class: 'xs muted', style: { margin: '12px 0 0' } }, `Our model expects polls to miss by about ${2.6} points nationally, in either direction, plus regional, state and race-level misses. Set it yourself to ask "what if the polls are off like 2016, 2020 or 2022?"`)));

  if (store.sim) {
    root.append(h('div', { class: 'banner live' }, h('span', { class: 'live-dot' }),
      h('div', { class: 'grow' }, h('b', null, 'An election-night simulation is running. '), `It's ${clockLabel(store.sim.t)} in the simulation.`),
      h('a', { class: 'btn small', href: '#/live' }, 'Watch it'), h('button', { type: 'button', class: 'btn small', onclick: () => stopSim() }, 'Stop')));
  }

  if (seed === null) {
    root.append(h('div', { class: 'grid g2 section' },
      h('div', { class: 'card' }, h('h3', null, '🎲 Quick simulation'), h('p', { class: 'muted' }, 'One click, one complete result: who controls the Senate and House, every flipped seat, the upsets, and how this result compares with the other 19,999 in our forecast. Each result gets a link you can share.')),
      h('div', { class: 'card' }, h('h3', null, '▶ Election night'), h('p', { class: 'muted' }, 'Watch the night unfold: polls close from 6 p.m. to 1 a.m. Eastern, votes come in at each state’s real pace, early leads can evaporate, races get projected, and the chambers get called. Pause, speed up or drag the timeline. The whole site follows along until you exit.'))));
    return;
  }

  const sc = scenarioFor(seed, err);
  root.append(resultView(sc, seed, err));
}

function chamberLine(type, o) {
  const s = o.seats[type];
  const c = o.control[type];
  const name = type === 'senate' ? 'the Senate' : 'the House';
  const score = `${Math.max(s.D, s.R)}–${Math.min(s.D, s.R)}`;
  if (c === 'D') return `Democrats win ${name} ${score}`;
  if (c === 'R') return `Republicans hold ${name} ${score}${type === 'senate' && s.D === s.R ? ' on the vice president’s tie-breaking vote' : ''}`;
  return `${name} is split, with independents holding the balance`;
}

function resultView(sc, seed, err) {
  const o = sc.outcome;
  const same = o.control.senate === o.control.house && o.control.senate !== 'split';
  const head = same
    ? `${o.control.house === 'D' ? 'Democrats' : 'Republicans'} ${o.control.house === 'D' ? 'win' : 'hold'} the House ${o.seats.house.D >= o.seats.house.R ? `${o.seats.house.D}–${o.seats.house.R}` : `${o.seats.house.R}–${o.seats.house.D}`} and the Senate ${o.seats.senate.D >= o.seats.senate.R ? `${o.seats.senate.D}–${o.seats.senate.R}` : `${o.seats.senate.R}–${o.seats.senate.D}`}`
    : `${chamberLine('house', o)}, but ${chamberLine('senate', o).replace(/^The /, 'the ')}`;
  const keyFlips = (party) => o.flips.filter(f => f.party === party && (f.r.type === 'senate' || f.r.type === 'house' || f.r.type === 'gov')).length;
  const wrap = h('section', { class: 'section sim-result' });
  wrap.append(h('div', { class: 'card sim-headline' },
    h('div', { class: 'eyebrow' }, 'In this simulation'),
    h('h2', null, head + '.'),
    h('p', { class: 'muted', style: { margin: '8px 0 0' } }, `${errText(sc.nat)}${sc.natFixed ? ' (your setting)' : ''}. In Congress and governor races, Democrats flip ${keyFlips('D')} seats and Republicans flip ${keyFlips('R')}. `,
      h('span', { class: 'xs' }, `Simulation #${seed}. `), h('a', { href: location.hash, class: 'xs' }, 'Link to this result')),
    h('div', { class: 'sim-buttons', style: { marginTop: '14px' } },
      h('button', { type: 'button', class: 'btn primary', onclick: () => { location.hash = newQuickHash(); } }, '🎲  Simulate again'),
      h('button', { type: 'button', class: 'btn', onclick: () => playNight(seed, err) }, '▶  Play this as election night'))));

  const card = (type, label, total, need) => {
    const s = o.seats[type];
    const f = store.forecast.control[type];
    const better = f.hist.p.reduce((acc, p, i) => acc + (f.hist.start + i > s.D ? p : 0), 0);
    const ctrl = o.control[type];
    return h('div', { class: 'card' },
      h('div', { class: 'chamber-top' }, h('div', { class: 'chamber-name' }, label),
        type !== 'gov' ? h('span', { class: 'pill', style: { background: ctrl === 'D' ? 'var(--dem)' : ctrl === 'R' ? 'var(--rep)' : 'var(--oth)', color: '#fff' } }, ctrl === 'D' ? 'Democratic control' : ctrl === 'R' ? 'Republican control' : 'No majority') : null),
      h('div', { class: 'odds-row', style: { marginTop: '8px' } },
        h('div', { class: 'odds dem' }, h('span', { class: 'pct' }, s.D), h('span', { class: 'who c-dem' }, 'Democrats')),
        s.I ? h('div', { class: 'odds', style: { alignItems: 'center' } }, h('span', { class: 'pct c-ind', style: { fontSize: '28px' } }, s.I), h('span', { class: 'who c-ind' }, 'Ind.')) : null,
        h('div', { class: 'odds rep right' }, h('span', { class: 'pct' }, s.R), h('span', { class: 'who c-rep' }, 'Republicans'))),
      histogram(f.hist, { threshold: need, total, height: 150, xLabel: type === 'gov' ? 'Democratic governors' : 'Democratic seats', mark: s.D }),
      h('p', { class: 'xs muted', style: { margin: '6px 0 0' } }, `Democrats did better than this in ${pct(better)} of our 20,000 forecast simulations.`));
  };
  wrap.append(h('div', { class: 'grid g3', style: { marginTop: '16px' } }, card('senate', 'Senate', 100, 51), card('house', 'House', 435, 218), card('gov', 'Governors', 50, 26)));

  const LEGEND = [['var(--dem)', 'D by 15+'], ['var(--dem-2)', 'D by 5–15'], ['var(--dem-3)', 'D by <5'], ['var(--rep-3)', 'R by <5'], ['var(--rep-2)', 'R by 5–15'], ['var(--rep)', 'R by 15+'], ['var(--ind)', 'Independent']];
  const tip = (r) => {
    const p = sc.races[r.id];
    if (!p) return '';
    const name = p.margin > 0 ? r.left : r.right;
    const party = p.margin > 0 ? r.leftParty : r.rightParty;
    const pre = p.margin > 0 ? r.p : (r.p === null ? null : 1 - r.p);
    return `<div class="tt-title">${esc(r.title)}</div><div class="tt-row"><span><span class="party-chip ${party}" style="margin-right:6px">${party}</span>${esc(name || '')}</span><b>${p.contested ? '+' + Math.abs(p.margin).toFixed(1) : 'Unopposed'}</b></div>${pre !== null && p.contested ? `<div class="tt-row muted"><span>Forecast chance</span><span>${pct(pre)}</span></div>` : ''}`;
  };
  const fillFor = (r) => simFill(sc, r);
  const stateFill = (type) => (code) => { const r = store.races.find(x => x.type === type && x.state === code); return r ? fillFor(r) : null; };
  const stateTip = (type) => (code) => { const r = store.races.find(x => x.type === type && x.state === code); return r ? tip(r) : `<div class="tt-title">${esc(store.stateByCode[code]?.name)}</div><div class="muted">No race</div>`; };
  const go = (type) => (code) => { const r = store.races.find(x => x.type === type && x.state === code); if (r) location.hash = r.url; };
  wrap.append(
    h('div', { class: 'card section' }, h('div', { class: 'card-title' }, 'House results in this simulation'), houseMap({ id: 'sim', fill: fillFor, tip, caption: false }),
      mapLegend(LEGEND)),
    h('div', { class: 'grid g2 section' },
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Senate'), usMap({ fill: stateFill('senate'), tip: stateTip('senate'), onClick: go('senate') }), mapLegend(LEGEND.slice(0, 6))),
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Governors'), usMap({ fill: stateFill('gov'), tip: stateTip('gov'), onClick: go('gov') }), mapLegend(LEGEND.slice(0, 6)))));

  const flipChip = (f) => h('a', { href: f.r.url, style: { color: partyVar(f.party) } }, `${f.r.short} → ${f.party} +${Math.abs(f.margin).toFixed(1)}`);
  const order = { senate: 0, gov: 1, house: 2, ltgov: 3, ag: 4, sos: 5 };
  const flips = o.flips.slice().sort((a, b) => order[a.r.type] - order[b.r.type] || Math.abs(a.margin) - Math.abs(b.margin));
  wrap.append(h('div', { class: 'grid g2 section' },
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, `Seats that change hands (${flips.length})`),
      flips.length ? h('div', { class: 'chips' }, flips.map(flipChip)) : h('p', { class: 'muted small' }, 'No seats flip.')),
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Biggest upsets'),
      o.upsets.length ? o.upsets.slice(0, 8).map(u => h('div', { class: 'tl-row', style: { gridTemplateColumns: '1fr auto' } },
        h('a', { href: u.r.url }, h('b', null, u.r.title), h('div', { class: 'xs muted' }, `${(u.margin > 0 ? u.r.left : u.r.right)} (${u.party}) wins by ${Math.abs(u.margin).toFixed(1)}`)),
        h('span', { class: 'small muted' }, `had a ${pct(u.pWin)} chance`)))
        : h('p', { class: 'muted small' }, 'No real upsets: every favorite with at least a 70% chance won.'))));

  const cols = [
    { key: 'race', label: 'Race', render: x => h('a', { class: 'race-name', href: x.r.url }, x.r.title), sort: x => x.r.title, defaultAsc: true },
    { key: 'w', label: 'Winner', render: x => h('div', { class: 'cand-line' }, partyChip(x.party), h('span', { class: 'nm' }, x.margin > 0 ? x.r.left : x.r.right)) },
    { key: 'm', label: 'Margin', num: true, render: x => h('b', { style: { color: partyVar(x.party) } }, `+${Math.abs(x.margin).toFixed(1)}`), sort: x => Math.abs(x.margin), defaultAsc: true },
    { key: 'f', label: 'Forecast chance', num: true, hideSm: true, render: x => { const pw = x.margin > 0 ? x.r.p : 1 - x.r.p; return pct(pw); }, sort: x => (x.margin > 0 ? x.r.p : 1 - x.r.p) },
  ];
  wrap.append(h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, 'Closest races')),
    sortableTable(cols, o.close.slice(0, 20), { sortKey: 'm', desc: false, stateKey: 'sim-close' })));
  return wrap;
}

export const title = () => 'Simulator';
void num; void lastName; void PARTY_NAME;
