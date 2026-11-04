// The swing map (/swing): how the presidential vote moved between two elections, county by county (2000 on) or
// state by state (1976 on), as arrows or shading. The choice lives in the address (?from=2020&to=2024), so it can be shared.
import { h, num, partyVar, sortableTable, esc } from '../ui.js';
import {
  withData, PRES_YEARS, COUNTY_YEARS, COUNTY_GEO, PRESIDENT_URL, INDEX_URL, countiesUrl, marginOf, marginLabel, shiftLabel,
  shiftWords, shiftFill, stateOfFips, stateName, WHOLE_STATE, nationalCountyMap, nationalStateMap, countyCentres, stateCentroids,
  arrowKey, shiftLegend, ttRow, ttTitle,
} from '../archive.js';

const COUNTY_K = 1.6, STATE_K = 2.4;   // arrow length in map pixels per point of shift

/**
 * Settings from the address, made valid: two different presidential years, in either order (2024 to 2020 shows the
 * same moves the other way round); counties only from 2000.
 */
export function swingSettings(q = new URLSearchParams(location.search)) {
  let from = +q.get('from'), to = +q.get('to');
  if (!PRES_YEARS.includes(to)) to = 2024;
  if (!PRES_YEARS.includes(from) || from === to) from = PRES_YEARS[PRES_YEARS.indexOf(to) - 1] || PRES_YEARS[1];
  const countiesOk = COUNTY_YEARS.includes(from) && COUNTY_YEARS.includes(to);
  const level = q.get('level') === 'states' || !countiesOk ? 'states' : 'counties';
  const style = q.get('style') === 'shading' ? 'shading' : 'arrows';
  return { from, to, level, style, countiesOk };
}
export const swingUrl = (o) => `/swing?from=${o.from}&to=${o.to}${o.level === 'states' ? '&level=states' : ''}${o.style === 'shading' ? '&style=shading' : ''}`;

// ------------------------------------------------------------------------------------------- the numbers

/** Each state's margin both years and the shift: { code: { a, b, sh, ta, tb } }. */
function stateShifts(pres, from, to) {
  const A = pres.years[from].states, B = pres.years[to].states;
  const out = {};
  for (const code of Object.keys(B)) {
    if (!A[code]) continue;
    const a = marginOf(...A[code]), b = marginOf(...B[code]);
    out[code] = { a, b, sh: b - a, ta: A[code][0], tb: B[code][0] };
  }
  return out;
}

/** The same for every county with a result both years: { fips: { a, b, sh, ta, tb } }. */
function countyShifts(A, B) {
  const out = {};
  for (const [f, vb] of Object.entries(B)) {
    const va = A[f];
    if (!va) continue;
    const a = marginOf(...va), b = marginOf(...vb);
    if (a === null || b === null) continue;
    out[f] = { a, b, sh: b - a, ta: va[0], tb: vb[0] };
  }
  return out;
}

const turnout = (ta, tb) => (ta > 0 ? `${tb >= ta ? '+' : '−'}${Math.abs((100 * (tb - ta)) / ta).toFixed(1)}%` : '—');
const shiftHtml = (sh) => `<span style="color:${partyVar(sh >= 0 ? 'D' : 'R')}">${shiftLabel(sh)}</span>`;
const colored = (m, text) => h('span', { style: { color: partyVar(m >= 0 ? 'D' : 'R') } }, text);

function placeTip(title, x, from, to, note) {
  if (!x) return `${ttTitle(title)}<div class="muted">${esc(note || `No result for both ${from} and ${to}.`)}</div>`;
  return ttTitle(title) + ttRow(String(from), marginLabel(x.a)) + ttRow(String(to), marginLabel(x.b)) + ttRow('Shift', shiftHtml(x.sh)) +
    ttRow('Votes cast', `${num(x.ta)} → ${num(x.tb)}`, true) + (note ? `<div class="tt-foot">${esc(note)}</div>` : '');
}

// ------------------------------------------------------------------------------------------- the map

/**
 * The shift map on its own, used on this page and as the archive's teaser. Returns a placeholder that fills in once
 * the data has loaded (at once when it is cached); onData(info) then gets the shifts, for the summary.
 */
export function shiftMap(o, { key = 'swing', onData = null, height = 'map' } = {}) {
  if (o.level === 'states') {
    return withData([PRESIDENT_URL], (pres) => {
      const sh = stateShifts(pres, o.from, o.to);
      const fill = (code) => (o.style === 'shading' ? (sh[code] ? shiftFill(sh[code].sh) : 'var(--none)') : 'var(--surface-2)');
      const map = nationalStateMap({
        fill, label: `Map of the shift in the presidential vote by state, ${o.from} to ${o.to}`,
        tip: (code) => placeTip(stateName(code), sh[code], o.from, o.to),
        arrows: o.style === 'arrows' ? Object.entries(sh).map(([code, x]) => ({ code, sh: x.sh })) : null, arrowScale: STATE_K,
      });
      if (onData) onData({ pres, states: sh });
      return h('div', null, map, o.style === 'arrows' ? arrowKey({ k: STATE_K }) : shiftLegend());
    }, height);
  }
  return withData([COUNTY_GEO, countiesUrl(o.from), countiesUrl(o.to), PRESIDENT_URL, INDEX_URL], (topo, A, B, pres, idx) => {
    const sh = countyShifts(A, B);
    const st = stateShifts(pres, o.from, o.to);
    const whole = (f) => WHOLE_STATE[f.st];
    const fill = (f) => {
      if (o.style !== 'shading') return 'var(--surface-2)';
      const x = whole(f) ? st[f.st] : sh[f.id];
      return x ? shiftFill(x.sh) : 'var(--none)';
    };
    const tip = (f) => {
      if (whole(f)) return placeTip(`${stateName(f.st)} (whole state)`, st[f.st], o.from, o.to, WHOLE_STATE[f.st]);
      const note = !sh[f.id] && f.id === '08014' && (o.from === 2000 || o.to === 2000) ? 'Broomfield County was formed in 2001.' : null;
      return placeTip(`${f.n}, ${f.st}`, sh[f.id], o.from, o.to, note);
    };
    let arrows = null;
    if (o.style === 'arrows') {
      const at = countyCentres(topo);
      arrows = Object.entries(sh).filter(([f]) => at[f] && !WHOLE_STATE[stateOfFips(f)]).map(([f, x]) => ({ x: at[f][0], y: at[f][1], sh: x.sh }));
      const centre = stateCentroids();
      for (const code of Object.keys(WHOLE_STATE)) if (st[code] && centre[code]) arrows.push({ x: centre[code][0], y: centre[code][1], sh: st[code].sh });
    }
    const map = nationalCountyMap(topo, { fill, tip, arrows, arrowScale: COUNTY_K, key, label: `Map of the shift in the presidential vote by county, ${o.from} to ${o.to}` });
    if (onData) onData({ pres, states: st, counties: sh, topo, idx });
    return h('div', null, map, o.style === 'arrows' ? arrowKey({ k: COUNTY_K }) : shiftLegend());
  }, height);
}

// ------------------------------------------------------------------------------------------- the page

export function render(root) {
  const body = h('div');
  const go = (changes) => { history.replaceState(null, '', swingUrl({ ...swingSettings(), ...changes })); draw(); };
  root.append(
    h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, h('a', { href: '/archive' }, 'Archive'), h('span', null, '›'), h('span', null, 'Swing map')),
      h('h1', null, 'How the vote has shifted'),
      h('p', { class: 'dek' }, 'Pick two presidential elections to see where the vote moved. Each arrow is a county, or a state: it points left where the margin moved toward Democrats and right where it moved toward Republicans, and the longer it is, the bigger the shift.')),
    body);
  function draw() {
    const o = swingSettings();
    const sum = h('div', { class: 'sw-summary' }, h('div', { class: 'skeleton', style: { height: '220px' } }));
    const map = h('section', { class: 'card sw-map' },
      h('div', { class: 'card-title' }, `Presidential vote, ${o.from} to ${o.to}, by ${o.level === 'states' ? 'state' : 'county'}`,
        o.level === 'counties' ? h('span', { class: 'muted map-hint', style: { textTransform: 'none', letterSpacing: 0 } }, 'Click a state to zoom · pinch or Ctrl/⌘-scroll') : null),
      shiftMap(o, { key: `swing-${o.level}`, onData: (info) => fillSummary(sum, o, info) }));
    body.replaceChildren(controls(o, go), map, sum);
  }
  draw();
}

function controls(o, go) {
  const yearSelect = (label, value, onPick, allowed) => {
    const sel = h('select', { class: 'input', 'aria-label': `${label} year` }, PRES_YEARS.filter(allowed).map(y => h('option', { value: y }, String(y))));
    sel.value = String(value);
    sel.addEventListener('change', () => onPick(+sel.value));
    return h('label', { class: 'sw-pick' }, h('span', null, label), sel);
  };
  const seg = (opts, value, onPick, disabled = () => false) => h('div', { class: 'seg', role: 'tablist' }, opts.map(([k, label]) => {
    const off = disabled(k);
    const b = h('button', { type: 'button', class: k === value ? 'on' : '', disabled: off ? '' : null, title: off ? 'County results start in 2000' : null }, label);
    b.addEventListener('click', () => { if (!off) onPick(k); });
    return b;
  }));
  // Either year can come first. Picking the year the other box already has swaps the two.
  const pickFrom = (y) => go({ from: y, to: y === o.to ? o.from : o.to });
  const pickTo = (y) => go({ to: y, from: y === o.from ? o.to : o.from });
  const swap = h('button', { type: 'button', class: 'sw-swap', title: 'Swap the years', 'aria-label': `Swap the years: ${o.to} to ${o.from}`, onclick: () => go({ from: o.to, to: o.from }) }, '⇄');
  const presets = [[2020, 2024], [2016, 2020], [2012, 2016], [2000, 2024], [1980, 2024]];
  return h('div', { class: 'card sw-controls' },
    h('div', { class: 'sw-row' },
      yearSelect('From', o.from, pickFrom, () => true),
      swap,
      yearSelect('To', o.to, pickTo, () => true),
      seg([['counties', 'Counties'], ['states', 'States']], o.level, (k) => go({ level: k }), (k) => k === 'counties' && !o.countiesOk),
      seg([['arrows', 'Arrows'], ['shading', 'Shading']], o.style, (k) => go({ style: k }))),
    h('div', { class: 'sw-presets' }, h('span', { class: 'muted xs' }, 'Try'),
      presets.map(([a, b]) => h('button', { type: 'button', class: `chip-btn${a === o.from && b === o.to ? ' on' : ''}`, onclick: () => go({ from: a, to: b }) }, `${a} → ${b}`))));
}

const kpi = (label, value, sub) => h('div', { class: 'card sw-kpi' }, h('div', { class: 'sw-k' }, label), h('div', { class: 'sw-v' }, value), h('div', { class: 'xs muted' }, sub));

function fillSummary(el, o, { pres, states, counties, topo, idx }) {
  const nat = (y) => { const v = pres.years[y].votes; return marginOf(v.total, v.D, v.R); };
  const natShift = nat(o.to) - nat(o.from);
  const stRows = Object.entries(states).map(([code, x]) => ({ code, ...x }));
  const towardD = stRows.filter(x => x.sh > 0).length;
  const kpis = [
    kpi('National popular vote', h('span', null, colored(nat(o.from), marginLabel(nat(o.from))), ' → ', colored(nat(o.to), marginLabel(nat(o.to)))), `A shift of ${shiftWords(natShift)}`),
    kpi('States that moved', h('span', null, h('b', { class: 'c-rep' }, `${stRows.length - towardD} toward R`), ' · ', h('b', { class: 'c-dem' }, `${towardD} toward D`)), 'The 50 states and D.C.'),
  ];
  let lists = null;
  if (counties) {
    const xs = Object.entries(counties);
    const cd = xs.filter(([, x]) => x.sh > 0).length, cr = xs.filter(([, x]) => x.sh < 0).length;
    kpis.push(kpi('Counties that moved', h('span', null, h('b', { class: 'c-rep' }, `${num(cr)} toward R`), ' · ', h('b', { class: 'c-dem' }, `${num(cd)} toward D`)), `Of ${num(xs.length)} with a result both years`));
    const names = Object.fromEntries(topo.objects.counties.geometries.map(g => [g.properties.id, g.properties.n]));
    const big = xs.filter(([f, x]) => x.tb >= 10000 && !WHOLE_STATE[stateOfFips(f)]);
    const top = (dir) => [...big].sort((p, q) => (q[1].sh - p[1].sh) * dir).slice(0, 10);
    const list = (title, rows) => h('div', { class: 'card' }, h('div', { class: 'card-title' }, title),
      h('ol', { class: 'sw-list' }, rows.map(([f, x], i) => h('li', null,
        h('span', { class: 'sw-rank' }, String(i + 1)),
        h('span', { class: 'sw-place' }, `${names[f] || f}, ${stateOfFips(f)}`, h('span', { class: 'xs muted' }, `${marginLabel(x.a)} → ${marginLabel(x.b)}`)),
        h('b', { style: { color: partyVar(x.sh >= 0 ? 'D' : 'R') } }, shiftLabel(x.sh))))));
    lists = h('div', { class: 'grid g2' }, list('Biggest shifts toward Democrats', top(1)), list('Biggest shifts toward Republicans', top(-1)));
  }
  const table = sortableTable([
    { key: 'st', label: 'State', render: x => stateName(x.code), sort: x => stateName(x.code), defaultAsc: true },
    { key: 'a', label: String(o.from), num: true, render: x => colored(x.a, marginLabel(x.a)), sort: x => x.a },
    { key: 'b', label: String(o.to), num: true, render: x => colored(x.b, marginLabel(x.b)), sort: x => x.b },
    { key: 'sh', label: 'Shift', num: true, render: x => h('b', { style: { color: partyVar(x.sh >= 0 ? 'D' : 'R') } }, shiftLabel(x.sh)), sort: x => x.sh },
    { key: 'tb', label: 'Votes cast', num: true, hideSm: true, render: x => `${num(x.tb)} (${turnout(x.ta, x.tb)})`, sort: x => x.tb },
  ], stRows, { sortKey: 'sh', desc: false, stateKey: 'swing-states', limit: 15 });
  el.replaceChildren(
    h('div', { class: `grid ${counties ? 'g3' : 'g2'} sw-kpis` }, kpis),
    lists ? h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'Counties that moved most'), h('p', null, `Among counties with at least 10,000 votes in ${o.to}.`))), lists) : null,
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'Every state'), h('p', null, 'Margins are the Democrat’s share minus the Republican’s, in points of all votes cast.'))), table),
    notes(o, idx));
}

function notes(o, idx) {
  const items = [];
  if (o.level === 'counties') {
    items.push(WHOLE_STATE.AK, WHOLE_STATE.CT);
    if (o.from === 2000 || o.to === 2000) items.push('Broomfield County, Colorado, formed in 2001, has no result for 2000.');
    items.push('Counties are matched to today’s map: Bedford city, Virginia, counts in Bedford County, Clifton Forge in Alleghany County, Shannon County, South Dakota, as Oglala Lakota County, and Kansas City, Missouri, which counts its votes apart from its counties, in Jackson County.');
    for (const y of [o.from, o.to]) for (const n of idx?.years.find(e => e.year === y)?.countyNotes || []) items.push(`${y}: ${n.text}`);
  }
  items.push('A shift is the change in the Democratic-minus-Republican margin, in points of all votes cast, so a third-party candidate’s rise or fall moves it too.');
  items.push('Results are official returns compiled by the MIT Election Data and Science Lab (Harvard Dataverse, CC0).');
  return h('section', { class: 'section' }, h('h2', null, 'About the data'), h('ul', { class: 'sw-notes' }, items.map(t => h('li', null, t))));
}

export const title = () => 'Swing map';
