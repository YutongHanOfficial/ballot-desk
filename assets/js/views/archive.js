// The archive: every federal general election since 1976 (/archive) and a page for each one (/archive/2024).
// Data from pipeline/build_archive.mjs: official returns compiled by the MIT Election Data and Science Lab.
import { h, num, partyChip, partyVar, sortableTable, esc, marginFill } from '../ui.js';
import { store } from '../store.js';
import {
  withData, INDEX_URL, PRESIDENT_URL, COUNTY_GEO, yearUrl, countiesUrl, PRES_YEARS, COUNTY_YEARS, marginOf, marginFillDR,
  marginLabel, shiftLabel, pctOf, stateName, WHOLE_STATE, nationalCountyMap, nationalStateMap, resultLegend, ttRow, ttTitle,
} from '../archive.js';
import { shiftMap, swingUrl } from './swing.js';

const PARTY_WORD = { D: 'Democrats', R: 'Republicans', O: 'independents' };
const colored = (party, text, tag = 'span') => h(tag, { style: { color: partyVar(party) } }, text);
const marginCell = (m) => (m === null ? h('span', { class: 'muted' }, '—') : colored(m >= 0 ? 'D' : 'R', marginLabel(m)));

// ------------------------------------------------------------------------------------------- index

export function renderIndex(root) {
  root.append(
    h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, 'Archive'), h('h1', null, 'Past elections'),
      h('p', { class: 'dek' }, 'Every federal general election since 1976: who won the White House, the Senate races and the House, with maps by state and, from 2000, by county. The results are official returns compiled by the MIT Election Data and Science Lab.')),
    h('section', { class: 'card sw-teaser' },
      h('div', { class: 'card-title' }, 'How the map has shifted', h('a', { class: 'more', href: '/swing' }, 'Open the swing map →')),
      h('p', { class: 'small', style: { margin: '0 0 10px' } }, 'From 2020 to 2024, county by county. Each arrow points left where the margin moved toward Democrats and right where it moved toward Republicans; the longer the arrow, the bigger the shift.'),
      shiftMap({ from: 2020, to: 2024, level: 'counties', style: 'arrows' }, { key: 'archive-teaser' }),
      h('div', { class: 'sw-teaser-foot' }, h('a', { class: 'btn small', href: swingUrl({ from: 2020, to: 2024, level: 'counties', style: 'arrows' }) }, 'Compare any two elections'))),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'Every election'), h('p', null, 'Presidential years and midterms, newest first.'))),
      withData([INDEX_URL], (idx) => h('div', { class: 'ar-grid' }, [...idx.years].reverse().map(electionCard)), 640)));
}

function seats(w) {
  return h('span', { class: 'ar-seats' }, h('b', { class: 'c-dem' }, `D ${w.D}`), h('b', { class: 'c-rep' }, `R ${w.R}`), w.O ? h('b', { class: 'ar-oth' }, `Ind. ${w.O}`) : null);
}

/** A thin bar of House seats with the 218 mark. */
function houseBar(s, height = 6) {
  const total = s.D + s.R + s.O;
  return h('div', { class: 'ar-bar', style: { height: `${height}px` } },
    h('span', { style: { width: `${(100 * s.D) / total}%`, background: 'var(--dem)' } }),
    s.O ? h('span', { style: { width: `${(100 * s.O) / total}%`, background: 'var(--ind)' } }) : null,
    h('span', { style: { width: `${(100 * s.R) / total}%`, background: 'var(--rep)' } }),
    h('i', { class: 'ar-mid', title: '218 for a majority' }));
}

function electionCard(e) {
  const p = e.president;
  const lines = [];
  if (p) {
    const win = p.ev.D > p.ev.R ? 'D' : 'R';
    lines.push(h('div', { class: 'ar-line' }, h('span', { class: 'ar-k' }, 'President'),
      h('span', null, colored(win, p[win], 'b'), h('span', { class: 'muted' }, ` ${p.ev[win]}–${p.ev[win === 'D' ? 'R' : 'D']}`))));
  }
  lines.push(h('div', { class: 'ar-line' }, h('span', { class: 'ar-k' }, 'House'), seats(e.house.seats)));
  lines.push(h('div', { class: 'ar-line' }, h('span', { class: 'ar-k' }, `Senate, ${e.senate.races} races`), seats(e.senate.won)));
  return h('a', { class: 'ar-card', href: `/archive/${e.year}` },
    h('div', { class: 'ar-head' }, h('b', null, String(e.year)), h('span', { class: 'ar-kind' }, e.presidential ? 'Presidential' : 'Midterm')),
    lines, houseBar(e.house.seats));
}

// ------------------------------------------------------------------------------------------- one election

export function renderYear(root, year) {
  const y = +year;
  root.append(withData([INDEX_URL], (idx) => {
    const e = idx.years.find(x => x.year === y);
    if (!e) {
      return h('div', { class: 'card not-found' }, h('div', { class: 'eyebrow' }, 'Archive'), h('h1', null, `No ${year} election in the archive`),
        h('p', { class: 'dek' }, 'The archive covers the general elections from 1976 to 2024.'), h('a', { class: 'btn primary', href: '/archive' }, 'Every election'));
    }
    const urls = [yearUrl(y), ...(e.presidential ? [PRESIDENT_URL] : [])];
    return h('div', null, yearHead(e, idx), withData(urls, (data, pres) => h('div', null,
      e.presidential ? presidentSection(e, pres) : null,
      senateSection(e, data.senate),
      houseSection(e, data.house),
      footnote(e, data)), 900));
  }, 600));
}

function yearHead(e, idx) {
  const y = e.year;
  const p = e.president;
  const parts = [];
  if (p) {
    const win = p.ev.D > p.ev.R ? 'D' : 'R', lose = win === 'D' ? 'R' : 'D';
    const pw = pctOf(p.votes[win], p.votes.total), pl = pctOf(p.votes[lose], p.votes.total);
    parts.push(`${p[win]} won the presidency with ${p.ev[win]} electoral votes to ${p[lose]}’s ${p.ev[lose]}, ${p.votes[win] > p.votes[lose] ? `and ${pw} of the popular vote to ${pl}` : `while losing the popular vote, ${pw} to ${pl}`}.`);
  }
  const hs = e.house.seats, hw = hs.D > hs.R ? 'D' : 'R', hl = hw === 'D' ? 'R' : 'D';
  parts.push(`${PARTY_WORD[hw]} won ${hs[hw]} House seats to ${PARTY_WORD[hl].replace(/s$/, 's’')} ${hs[hl]}${hs.O ? `, with ${hs.O} independent${hs.O > 1 ? 's' : ''}` : ''}.`);
  const sw = e.senate.won;
  parts.push(`Of the ${e.senate.races} Senate races, Democrats won ${sw.D} and Republicans ${sw.R}${sw.O ? `; independents won ${sw.O}` : ''}.`);
  const years = idx.years.map(x => x.year);
  const i = years.indexOf(y);
  const list = h('div', { class: 'yr-list' }, years.map(x => h('a', { href: `/archive/${x}`, class: x === y ? 'on' : '', 'aria-current': x === y ? 'page' : null }, String(x))));
  // Scroll the strip to this year (on a phone it starts at 1976 otherwise).
  requestAnimationFrame(() => { const on = list.querySelector('a.on'); if (on) list.scrollLeft = on.offsetLeft - (list.clientWidth - on.offsetWidth) / 2; });
  return h('header', { class: 'page-head' },
    h('div', { class: 'eyebrow' }, h('a', { href: '/archive' }, 'Archive'), h('span', null, '›'), h('span', null, String(y))),
    h('h1', null, `The ${y} elections`),
    h('p', { class: 'dek' }, parts.join(' ')),
    h('nav', { class: 'yr-nav', 'aria-label': 'Other elections' },
      i > 0 ? h('a', { class: 'yr-step', href: `/archive/${years[i - 1]}` }, `← ${years[i - 1]}`) : null,
      list,
      i < years.length - 1 ? h('a', { class: 'yr-step', href: `/archive/${years[i + 1]}` }, `${years[i + 1]} →`) : h('a', { class: 'yr-step', href: '/forecast' }, '2026 →')));
}

const sectionHead = (title, sub) => h('div', { class: 'section-head' }, h('div', null, h('h2', null, title), sub ? h('p', null, sub) : null));

// ---- President

function presidentSection(e, pres) {
  const y = e.year;
  const p = pres.years[y];
  const prev = pres.years[y - 4] ? y - 4 : null;
  const margins = Object.fromEntries(Object.entries(p.states).map(([st, v]) => [st, marginOf(...v)]));
  const win = p.ev.D > p.ev.R ? 'D' : 'R';
  const evBar = h('div', { class: 'ar-ev' },
    h('div', { class: 'ar-ev-names' }, colored('D', h('b', null, `${p.D} ${p.ev.D}`)), colored('R', h('b', null, `${p.ev.R} ${p.R}`))),
    h('div', { class: 'split-bar', style: { height: '14px', position: 'relative' } },
      h('span', { style: { width: `${(100 * p.ev.D) / 538}%`, background: 'var(--dem)' } }),
      h('span', { style: { width: `${(100 * (538 - p.ev.D - p.ev.R)) / 538}%`, background: 'var(--oth)' } }),
      h('span', { style: { width: `${(100 * p.ev.R) / 538}%`, background: 'var(--rep)' } }),
      h('i', { class: 'ar-mid tall', title: '270 to win' })),
    h('div', { class: 'xs muted', style: { marginTop: '6px' } }, p.ev.note || '270 electoral votes to win.'));
  const others = (p.others || []).map(o => `${o.name} ${pctOf(o.votes, p.votes.total)}`);
  const pv = h('div', null,
    h('div', { class: 'ar-pv' }, colored('D', h('b', null, pctOf(p.votes.D, p.votes.total))), h('span', { class: 'muted' }, ' to '), colored('R', h('b', null, pctOf(p.votes.R, p.votes.total)))),
    h('div', { class: 'xs muted' }, `${num(p.votes.D)} to ${num(p.votes.R)}${others.length ? `; ${others.join(', ')}` : ''}. ${num(p.votes.total)} votes in all.`));

  const view = { mode: 'states' };
  const holder = h('div');
  const seg = h('div', { class: 'seg' });
  const modes = [['states', 'States'], ...(COUNTY_YEARS.includes(y) ? [['counties', 'Counties']] : [])];
  const draw = () => {
    seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', modes[i][0] === view.mode));
    holder.replaceChildren(view.mode === 'counties' ? countyMarginMap(y, p) : stateMarginMap(p, margins), resultLegend());
  };
  for (const [k, label] of modes) seg.appendChild(h('button', { type: 'button', onclick: () => { view.mode = k; draw(); } }, label));
  draw();

  const rows = Object.entries(p.states).map(([st, v]) => ({ st, T: v[0], D: v[1], R: v[2], m: margins[st],
    sh: prev && pres.years[prev].states[st] ? margins[st] - marginOf(...pres.years[prev].states[st]) : null }));
  const table = sortableTable([
    { key: 'st', label: 'State', render: x => stateName(x.st), sort: x => stateName(x.st), defaultAsc: true },
    { key: 'd', label: lastWord(p.D), num: true, render: x => pctOf(x.D, x.T), sort: x => x.D / x.T },
    { key: 'r', label: lastWord(p.R), num: true, render: x => pctOf(x.R, x.T), sort: x => x.R / x.T },
    { key: 'm', label: 'Margin', num: true, render: x => marginCell(x.m), sort: x => x.m },
    prev ? { key: 'sh', label: `Shift from ${prev}`, num: true, hideSm: true, render: x => x.sh === null ? '—' : colored(x.sh >= 0 ? 'D' : 'R', shiftLabel(x.sh)), sort: x => x.sh } : null,
    { key: 't', label: 'Votes', num: true, hideSm: true, render: x => num(x.T), sort: x => x.T },
  ].filter(Boolean), rows, { sortKey: 'st', desc: false, stateKey: `ar-pres-${y}` });

  return h('section', { class: 'section' },
    sectionHead('President', `${p.D} (D) and ${p.R} (R)`),
    h('div', { class: 'grid g2' }, h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Electoral votes', colored(win, h('span', { class: 'ar-won' }, `${p[win]} won`))), evBar),
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Popular vote', h('span', { class: 'ar-won' }, marginCell(marginOf(p.votes.total, p.votes.D, p.votes.R)))), pv)),
    h('div', { class: 'card', style: { marginTop: '16px' } },
      h('div', { class: 'map-toolbar' }, seg, prev ? h('a', { class: 'more small', href: swingUrl({ from: prev, to: y, level: COUNTY_YEARS.includes(prev) ? 'counties' : 'states', style: 'arrows' }) }, `How the map shifted from ${prev} →`) : null),
      holder),
    h('div', { class: 'ar-table', style: { marginTop: '16px' } }, table));
}

const lastWord = (name) => name.replace(/\s+(Jr\.|Sr\.)$/, '').split(' ').pop();

function stateMarginMap(p, margins) {
  const tip = (st) => {
    const v = p.states[st];
    if (!v) return null;
    return ttTitle(stateName(st)) + ttRow(`${esc(p.D)} (D)`, pctOf(v[1], v[0])) + ttRow(`${esc(p.R)} (R)`, pctOf(v[2], v[0])) +
      ttRow('Margin', marginLabel(margins[st])) + ttRow('Votes', num(v[0]), true);
  };
  return nationalStateMap({ fill: (st) => (p.states[st] ? marginFillDR(margins[st]) : null), tip, label: 'Map of the presidential vote by state' });
}

function countyMarginMap(y, p) {
  return withData([COUNTY_GEO, countiesUrl(y)], (topo, C) => {
    const stateM = (st) => (p.states[st] ? marginOf(...p.states[st]) : null);
    const fill = (f) => (WHOLE_STATE[f.st] ? marginFillDR(stateM(f.st)) : C[f.id] ? marginFillDR(marginOf(...C[f.id])) : 'var(--none)');
    const tip = (f) => {
      if (WHOLE_STATE[f.st]) {
        const v = p.states[f.st];
        return ttTitle(`${stateName(f.st)} (whole state)`) + ttRow(`${esc(p.D)} (D)`, pctOf(v[1], v[0])) + ttRow(`${esc(p.R)} (R)`, pctOf(v[2], v[0])) +
          ttRow('Margin', marginLabel(stateM(f.st))) + `<div class="tt-foot">${esc(WHOLE_STATE[f.st])}</div>`;
      }
      const v = C[f.id];
      if (!v) return `${ttTitle(`${f.n}, ${f.st}`)}<div class="muted">No result for ${y}${f.id === '08014' && y === 2000 ? ' (formed in 2001)' : ''}.</div>`;
      return ttTitle(`${f.n}, ${f.st}`) + ttRow(`${esc(p.D)} (D)`, pctOf(v[1], v[0])) + ttRow(`${esc(p.R)} (R)`, pctOf(v[2], v[0])) +
        ttRow('Margin', marginLabel(marginOf(...v))) + ttRow('Votes', num(v[0]), true);
    };
    return nationalCountyMap(topo, { fill, tip, key: `ar-counties-${y}`, label: `Map of the ${y} presidential vote by county` });
  }, 'map');
}

// ---- Senate

/** A race's winner margin over the runner-up, in points (null without vote counts). */
function raceMargin(r) {
  if (r.unopposed) return 100;
  if (!r.total || !r.cands[1] || r.cands[0][2] === null) return r.cands[1] ? null : 100;
  return (100 * (r.cands[0][2] - r.cands[1][2])) / r.total;
}

function senateSection(e, races) {
  const byState = {};
  for (const r of races) if (!byState[r.state] || (byState[r.state].special && !r.special)) byState[r.state] = r;
  const fill = (st) => {
    const r = byState[st];
    if (!r || !r.winner) return null;
    const m = raceMargin(r);
    return m === null ? marginFill(r.winner.party, 10) : marginFill(r.winner.party, Math.abs(m));
  };
  const tip = (st) => {
    const rs = races.filter(r => r.state === st);
    if (!rs.length) return `${ttTitle(stateName(st))}<div class="muted">No Senate race in ${e.year}</div>`;
    return rs.map(r => ttTitle(`${stateName(st)}${r.special ? ' (special)' : ''}`) +
      (r.unopposed ? ttRow(`${esc(r.cands[0][0])} (${r.cands[0][1]})`, 'Unopposed')
        : r.cands.slice(0, 3).map(c => ttRow(`${esc(c[0])} (${c[1]})`, c[2] === null ? '—' : pctOf(c[2], r.total))).join('')) +
      (r.note ? `<div class="tt-foot">${esc(r.note)}</div>` : '')).join('<div style="height:8px"></div>');
  };
  const map = nationalStateMap({ fill, tip, label: `Map of the ${e.year} Senate races` });
  const table = sortableTable([
    { key: 'st', label: 'State', render: r => h('span', null, stateName(r.state), r.special ? h('span', { class: 'pill', style: { marginLeft: '6px' } }, 'Special') : null), sort: r => stateName(r.state) + (r.special ? '2' : '1'), defaultAsc: true },
    { key: 'w', label: 'Winner', render: r => candCell(r.cands[0], r.winner, r.note, r.unopposed), sort: r => r.winner?.party },
    { key: 'l', label: 'Runner-up', hideSm: true, render: r => r.cands[1] ? candCell(r.cands[1]) : h('span', { class: 'muted' }, '—'), sort: r => r.cands[1]?.[0] },
    { key: 'm', label: 'Margin', num: true, render: r => r.unopposed ? h('span', { class: 'muted' }, 'Unopposed') : winnerMargin(r), sort: r => raceMargin(r) },
  ], races, { sortKey: 'st', desc: false, stateKey: `ar-senate-${e.year}` });
  const sw = e.senate.won;
  return h('section', { class: 'section' },
    sectionHead('Senate', `${e.senate.races} races: Democrats won ${sw.D}, Republicans ${sw.R}${sw.O ? `, independents ${sw.O}` : ''}. Shaded by the winner’s margin.`),
    h('div', { class: 'card' }, map, resultLegend()),
    h('div', { class: 'ar-table', style: { marginTop: '16px' } }, table));
}

function candCell(c, winner = null, note = null, unopposed = false) {
  return h('div', { class: 'ar-cand' },
    h('div', { class: 'cand-line' }, partyChip(c[1]), h('span', { class: 'nm', style: { fontWeight: winner ? 700 : 500 } }, c[0])),
    note ? h('div', { class: 'xs muted ar-note' }, note) : null);
}
function winnerMargin(r) {
  const m = raceMargin(r);
  if (m === null) return h('span', { class: 'muted' }, 'Runoff');
  return colored(r.winner?.party || 'O', `+${Math.abs(m).toFixed(1)}`);
}

// ---- House

function houseSection(e, races) {
  const s = e.house.seats, v = e.house.votes;
  const bar = h('div', { class: 'ar-house' },
    h('div', { class: 'ar-ev-names' }, colored('D', h('b', null, `Democrats ${s.D}`)), s.O ? h('b', { style: { color: 'var(--ind)' } }, `Independents ${s.O}`) : null, colored('R', h('b', null, `${s.R} Republicans`))),
    houseBar(s, 14),
    h('div', { class: 'xs muted', style: { marginTop: '6px' } }, `218 seats for a majority. Popular vote, adding up every district: Democrats ${pctOf(v.D, v.total)}, Republicans ${pctOf(v.R, v.total)}.`));
  const states = [...new Set(races.map(r => r.id.slice(0, 2)))].sort((a, b) => stateName(a).localeCompare(stateName(b)));
  const holder = h('div');
  const filter = { st: '' };
  const select = h('select', { class: 'input', 'aria-label': 'Show one state' }, h('option', { value: '' }, 'Every state'), states.map(st => h('option', { value: st }, stateName(st))));
  const draw = () => {
    const rows = filter.st ? races.filter(r => r.id.startsWith(`${filter.st}-`)) : races;
    holder.replaceChildren(sortableTable([
      { key: 'id', label: 'District', render: r => r.id, sort: r => r.id, defaultAsc: true },
      { key: 'w', label: 'Winner', render: r => r.winner ? candCell(r.cands.find(c => c[0] === r.winner.name) || r.cands[0], r.winner, r.note) : h('div', { class: 'ar-cand' }, h('span', { class: 'muted' }, 'Vacant'), r.note ? h('div', { class: 'xs muted ar-note' }, r.note) : null), sort: r => r.winner?.party },
      { key: 'l', label: 'Runner-up', hideSm: true, render: r => { const c = r.cands.find(x => !r.winner || x[0] !== r.winner.name); return c && !r.unopposed ? candCell(c) : h('span', { class: 'muted' }, '—'); }, sort: r => r.cands[1]?.[0] },
      { key: 'm', label: 'Margin', num: true, render: r => r.unopposed ? h('span', { class: 'muted' }, 'Unopposed') : r.winner ? winnerMargin(r) : h('span', { class: 'muted' }, '—'), sort: r => (r.unopposed ? 1000 : raceMargin(r)), defaultAsc: true },
    ], rows, { sortKey: 'm', desc: false, limit: filter.st ? Infinity : 25, stateKey: `ar-house-${e.year}-${filter.st}` }));
  };
  select.addEventListener('change', () => { filter.st = select.value; draw(); });
  draw();
  return h('section', { class: 'section' },
    sectionHead('House', 'All 435 seats, closest first.'),
    h('div', { class: 'card' }, bar),
    h('div', { class: 'ar-filter' }, select),
    h('div', { class: 'ar-table' }, holder));
}

function footnote(e, data) {
  const fixed = [...data.senate.filter(r => r.note), ...data.house.filter(r => r.note)].length;
  return h('section', { class: 'section' }, h('p', { class: 'xs muted', style: { maxWidth: '760px' } },
    'Official returns compiled by the MIT Election Data and Science Lab (Harvard Dataverse, CC0). Margins are the winner’s lead over the runner-up, in points of all votes cast. ',
    fixed ? 'Races decided after election night, such as Louisiana’s December runoffs and Maine’s ranked-choice counts, carry a note; where the data mixes a runoff with the first round, only the winner and the runoff opponent are shown. ' : '',
    'A few races missing from that data were added from the official results reported on Wikipedia.'));
}

export const indexTitle = () => 'Past elections';
export const yearTitle = (y) => `${y} elections`;
