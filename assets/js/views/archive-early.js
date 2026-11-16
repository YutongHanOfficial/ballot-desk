// The archive before 1976: presidential results by state (1788-1972), from Wikipedia's tables with some state returns
// corrected where two other sources agree, and the party split of each new Congress (1788-1974), from the House's and
// Senate's historians (pipeline/early/, via pipeline/build_archive.mjs). Less complete than the years since 1976: no
// county maps and no race-by-race results.
import { h, num, esc, sortableTable, lastName } from '../ui.js';
import {
  assignFamilies, congressFamilies, familyFill, familyColor, familyText, familyChip, nationalStateMap, stateName, ttRow, ttTitle, pctOf,
} from '../archive.js';
import { swingUrl } from './swing.js';

// The two elections the House of Representatives decided. Who it chose comes with the data (president.winner).
const CONTINGENT = {
  1800: 'Thomas Jefferson and Aaron Burr tied at 73 electoral votes, and the House of Representatives chose Jefferson.',
  1824: 'No one won a majority of electoral votes, and the House of Representatives chose John Quincy Adams over Andrew Jackson, who had won the most.',
};
const SHORT = {
  Democrats: 'Dem.', Republicans: 'Rep.', Whigs: 'Whig', Federalists: 'Fed.', 'Democratic-Republicans': 'Dem.-Rep.',
  'Anti-Administration': 'Anti-Admin.', 'Pro-Administration': 'Pro-Admin.', Jacksonians: 'Jacksonian', 'Anti-Jacksonians': 'Anti-Jackson',
  'Jackson Republicans': 'Jackson Rep.', 'Adams-Clay Republicans': 'Adams-Clay Rep.', 'Jackson & Crawford Republicans': 'Jackson & Crawford',
  'Adams-Clay Republicans & Federalists': 'Adams-Clay & Fed.', Adams: 'Adams', Opposition: 'Opposition', Others: 'Others',
};
const short = (party) => SHORT[party] || party;
// The parties as people, for sentences: "Jacksonians held 104 seats".
const MEMBERS = { Adams: 'Adams supporters', 'Pro-Administration': 'Pro-Administration members', 'Anti-Administration': 'Anti-Administration members',
  Opposition: 'the Opposition coalition' };

// Slates without a person ("Unpledged electors", "No candidate") keep their whole name.
const isSlate = (name) => /^(unpledged|no candidate)/i.test(name || '');
// "Van Buren", "Stevenson".
const shortName = (name) => (isSlate(name) ? name : lastName(name));
// "J. Adams" for John Adams when Samuel Adams ran the same year; "C. C. Pinckney".
function initialsName(name) {
  const last = lastName(name);
  const firsts = name.replace(/\b(Jr\.?|Sr\.?|II|III|IV)$/i, '').trim().split(/\s+/).slice(0, -last.split(' ').length);
  return [...firsts.map(w => `${w[0]}.`), last].join(' ');
}

/**
 * A year's names for its candidates: full, with the party added where two share a name (1816's two unpledged slates),
 * and brief, for tables, with initials where two share a surname (John and Samuel Adams, 1796).
 */
function namesOf(p) {
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  const fulls = count(p.candidates.map(c => c.name)), briefs = count(p.candidates.map(c => shortName(c.name)));
  const full = {}, brief = {};
  for (const c of p.candidates) {
    full[c.id] = fulls.get(c.name) > 1 ? `${c.name} (${c.party})` : c.name;
    brief[c.id] = briefs.get(shortName(c.name)) > 1 ? (isSlate(c.name) ? full[c.id] : initialsName(c.name)) : shortName(c.name);
  }
  return { full, brief };
}

/** The president of an early year: the House's choice in a contingent election, else the most electoral votes. */
export function winnerOf(p) {
  return p.candidates.find(x => x.id === p.winner) || p.candidates[0];
}

/** "Dem. 131 · Rep. 94 · Others 13", each in its party's colour. */
function seatsLine(seats) {
  const fams = assignFamilies(seats.map(([party]) => party));
  return h('span', { class: 'ar-seats' }, seats.map(([party, n], i) => h('b', { style: { color: familyText(fams[i]) } }, `${short(party)} ${n}`)));
}

/** A bar of seats by party, with the majority mark. */
function seatsBar(seats, height = 6) {
  const fams = assignFamilies(seats.map(([party]) => party));
  const total = seats.reduce((t, [, n]) => t + n, 0) || 1;
  return h('div', { class: 'ar-bar', style: { height: `${height}px` } },
    seats.map(([party, n], i) => h('span', { title: `${party} ${n}`, style: { width: `${(100 * n) / total}%`, background: familyColor(fams[i]) } })),
    h('i', { class: 'ar-mid', title: 'Majority' }));
}

/** The index card. Its president line names the winner, then the electoral votes, the winner's first. */
export function earlyCard(e) {
  const p = e.president;
  const lines = [];
  if (p) {
    const fams = assignFamilies(p.cands.map(c => c[1]), { hints: p.cands.map(c => c[3]), reserved: congressFamilies(e.congress.house, e.congress.senate) });
    const wi = p.winner ?? 0;
    const [name, , ev] = p.cands[wi];
    const score = [ev, ...p.cands.filter((_, i) => i !== wi).map(c => c[2])].join('–');
    lines.push(h('div', { class: 'ar-line' }, h('span', { class: 'ar-k' }, 'President'),
      h('span', null, h('b', { style: { color: familyText(fams[wi]) } }, name), h('span', { class: 'muted' }, ` ${score}`))));
  }
  lines.push(h('div', { class: 'ar-line' }, h('span', { class: 'ar-k' }, 'House'), seatsLine(e.congress.house)));
  lines.push(h('div', { class: 'ar-line' }, h('span', { class: 'ar-k' }, 'Senate'), seatsLine(e.congress.senate)));
  return h('a', { class: 'ar-card', href: `/archive/${e.year}` },
    h('div', { class: 'ar-head' }, h('b', null, e.label), h('span', { class: 'ar-kind' }, e.presidential ? 'Presidential' : 'Midterm')),
    lines, seatsBar(e.congress.house));
}

// ------------------------------------------------------------------------------------------- one election

const sectionHead = (title, sub) => h('div', { class: 'section-head' }, h('div', null, h('h2', null, title), sub ? h('p', null, sub) : null));
const pvTotalOf = (p) => Object.values(p.states).reduce((t, st) => t + (st.total || 0), 0);

/** Each candidate's group: its own id, or the slate whose electors cast its votes (see SLATES in build_archive.mjs). */
function groupsOf(p) {
  const g = Object.fromEntries(p.candidates.map(c => [c.id, c.id]));
  for (const [key, s] of Object.entries(p.slates || {})) for (const id of s.cast) g[id] = key;
  return g;
}

/** The candidates with electoral votes, one entry per slate in candidate order: { g, ev, lead } (lead: who to name). */
function slateGroups(p, groupOf) {
  const out = [];
  for (const c of p.candidates.filter(x => x.ev > 0)) {
    const g = groupOf[c.id], prior = out.find(x => x.g === g);
    if (prior) { prior.ev += c.ev; prior.many = true; } else out.push({ g, ev: c.ev, c, many: false });
  }
  const byId = Object.fromEntries(p.candidates.map(c => [c.id, c]));
  // A slate split among several men is named for its own candidate (Greeley); one man's votes keep his name (Byrd).
  return out.map(x => ({ ...x, lead: x.many ? byId[x.g] || x.c : x.c }));
}

/** Colour families by group, in candidate order, kept off the colours of the Congress parties on the same page. */
function earlyFamilies(p, groupOf, reserved) {
  const first = new Map();
  for (const c of p.candidates) if (!first.has(groupOf[c.id])) first.set(groupOf[c.id], c);
  const keys = [...first.keys()];
  const fams = assignFamilies(keys.map(k => first.get(k).party), { hints: keys.map(k => first.get(k).family), reserved });
  const byKey = Object.fromEntries(keys.map((k, i) => [k, fams[i]]));
  return Object.fromEntries(p.candidates.map(c => [c.id, byKey[groupOf[c.id]]]));
}

/** The summary sentence for an early year. */
export function earlySummary(e, data) {
  const parts = [];
  const p = data.president;
  if (p) {
    const w = winnerOf(p);
    const groupOf = groupsOf(p);
    const { full } = namesOf(p);
    if (CONTINGENT[e.year]) parts.push(CONTINGENT[e.year]);
    else {
      // The runners-up, one entry per slate: "to the 66 cast by Horace Greeley’s electors".
      const rest = slateGroups(p, groupOf).filter(x => x.g !== groupOf[w.id]);
      const evs = rest.length ? ` to ${rest.slice(0, 3).map(x => (x.many ? `the ${x.ev} cast by ${p.slates[x.g].label}` : `${full[x.c.id]}’s ${x.ev}`)).join(', ')}` : '';
      // The popular vote, unless nobody ran against the winner in it (Washington's elector slates all backed him).
      const pvTotal = pvTotalOf(p);
      const top = p.candidates.filter(x => x.pv && groupOf[x.id] !== groupOf[w.id]).sort((a, b) => b.pv - a.pv)[0];
      const pv = !w.pv || !pvTotal || !top ? ''
        : top.pv > w.pv ? `, while losing the popular vote, ${pctOf(w.pv, pvTotal)} to ${shortName(top.name)}’s ${pctOf(top.pv, pvTotal)}`
          : `, and ${pctOf(w.pv, pvTotal)} of the popular vote`;
      parts.push(`${w.name} (${w.party}) won the presidency with ${w.ev} electoral votes${evs}${pv}.`);
    }
  }
  const hs = data.congress.house.seats.filter(([party, n]) => n > 0 && party !== 'Others').sort((a, b) => b[1] - a[1]);
  if (hs.length >= 2) parts.push(`In the House chosen in that election, ${MEMBERS[hs[0][0]] || hs[0][0]} held ${hs[0][1]} seats and ${MEMBERS[hs[1][0]] || hs[1][0]} ${hs[1][1]}.`);
  return parts.join(' ');
}

export function earlyYearPage(e, data) {
  const p = data.president;
  const reserved = congressFamilies(data.congress.house.seats, data.congress.senate.seats);
  return h('div', null,
    p ? presidentEarly(e, p, reserved) : null,
    congressSection(e, data),
    sourcesNote(e, data));
}

function presidentEarly(e, p, reserved) {
  const y = e.year;
  const groupOf = groupsOf(p);
  const famOf = earlyFamilies(p, groupOf, reserved);
  const { full, brief } = namesOf(p);
  const w = winnerOf(p);
  const evTotal = p.candidates.reduce((t, c) => t + (c.ev || 0), 0);
  const pvTotal = pvTotalOf(p);
  const popular = p.candidates.some(c => c.pv);
  const legislature = Object.entries(p.states).filter(([, st]) => st.method === 'legislature').map(([code]) => code);

  // Each state's winner (most electoral votes there; a tie goes to the one with more popular votes) and, where it had
  // a popular vote, the margin over the strongest rival, negative when the winner trailed (leader: who led instead).
  // A slate's popular vote counts for the electors chosen on it.
  const pvOf = (st, id) => (st.votes ? st.votes[groupOf[id]] ?? st.votes[id] ?? 0 : 0);
  const evOrder = (st) => Object.entries(st.evs || {}).sort((a, b) => b[1] - a[1] || pvOf(st, b[0]) - pvOf(st, a[0]));
  const stateWin = {};
  for (const [code, st] of Object.entries(p.states)) {
    const evs = evOrder(st);
    if (!evs.length) continue;
    const id = evs[0][0], g = groupOf[id];
    let margin = null, leader = id;
    // No margin where only partial returns survive. "other" is a rival only where it is one slate (otherSlate: South
    // Carolina's unpledged electors in 1956); elsewhere it is several minor candidates added together.
    if (st.votes && st.total > 0 && !st.partial) {
      let best = 0, bestId = null;
      for (const [k, v] of Object.entries(st.votes)) {
        if ((k === 'other' && !st.otherSlate) || (groupOf[k] || k) === g || v <= best) continue;
        best = v; bestId = k;
      }
      margin = (100 * (pvOf(st, id) - best)) / st.total;
      if (margin < 0) leader = bestId;
    }
    stateWin[code] = { id, margin, leader };
  }
  const noMargin = (code) => stateWin[code] && stateWin[code].margin === null;
  const fill = (code) => {
    const x = stateWin[code];
    if (!x) return null;
    return familyFill(famOf[x.id] || 'O', x.margin === null ? null : Math.max(0, x.margin));
  };
  const tip = (code) => {
    const st = p.states[code];
    if (!st) return `${ttTitle(stateName(code))}<div class="muted">No electoral votes in ${e.label}: not yet a state, or its votes weren’t cast or counted</div>`;
    const evRows = evOrder(st).map(([id, n]) => ttRow(esc(full[id] || id), `${n} electoral vote${n === 1 ? '' : 's'}`)).join('');
    const pvRows = st.votes && st.total > 0 && !st.partial
      ? Object.entries(st.votes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, v]) => ttRow(esc(id === 'other' ? 'Others' : full[id] || id), pctOf(v, st.total), true)).join('')
      : '';
    const foot = (t) => `<div class="tt-foot">${t}</div>`;
    const how = st.method === 'legislature'
      ? foot(st.votes ? 'The state legislature chose the electors, though a popular vote was held.' : 'Electors chosen by the state legislature: no popular vote.')
      : st.method === 'mixed' ? foot('Some electors chosen by voters, some by the legislature.')
        : !st.votes ? foot('No popular-vote returns survive.') : st.partial ? foot('Only partial popular-vote returns survive.') : '';
    const uncounted = !evRows && st.ev > 0 ? foot(`Congress didn’t count its ${st.ev} electoral votes.`) : '';
    const overlap = st.overlap ? foot('Voters could pick electors from more than one slate, so the shares add up to more than 100%.') : '';
    return ttTitle(stateName(code)) + evRows + pvRows + how + uncounted + overlap;
  };
  const map = nationalStateMap({ fill, tip, striped: noMargin, label: `Map of the ${e.label} presidential election by state` });
  // The legend lists who carried a state on the map, one entry per slate.
  const carried = new Set(Object.values(stateWin).map(x => groupOf[x.id]));
  const legendItems = [];
  for (const c of p.candidates) {
    const g = groupOf[c.id];
    if (!carried.has(g) || legendItems.some(x => x.g === g)) continue;
    legendItems.push({ g, fam: famOf[c.id] || 'O', label: p.slates?.[g]?.label || full[c.id] });
  }
  const legend = h('div', { class: 'legend' },
    legendItems.map(x => h('span', null, h('i', { style: { background: familyFill(x.fam) } }), x.label)),
    Object.keys(p.states).some(noMargin) ? h('span', null, h('i', { class: 'lg-hatch' }), 'No popular vote, or no full returns') : null,
    // The map always draws the 50 states and D.C.; any without a winner here is blank.
    Object.keys(stateWin).length < 51 ? h('span', null, h('i', { class: 'lg-blank' }), 'No electoral votes (not yet a state, or not cast or counted)') : null);

  const withEv = p.candidates.filter(c => c.ev > 0);
  const evBar = h('div', { class: 'ar-ev' },
    h('div', { class: 'split-bar', style: { height: '14px' } },
      withEv.map(c => h('span', { title: `${full[c.id]} ${c.ev}`, style: { width: `${(100 * c.ev) / evTotal}%`, background: familyColor(famOf[c.id] || 'O') } }))),
    h('div', { class: 'ar-ev-list' }, withEv.map(c => h('span', null, familyChip(famOf[c.id] || 'O', ''), h('b', null, full[c.id]), ` ${c.ev}`))),
    h('div', { class: 'xs muted', style: { marginTop: '6px' } }, y < 1804
      ? 'Before 1804 each elector cast two votes for president; the runner-up became vice president.'
      : `${p.needed ?? Math.floor(evTotal / 2) + 1} electoral votes to win.`));   // needed: a majority of electors appointed, where some didn't vote
  // Popular votes, most first, with anyone not listed as Others.
  const otherPv = pvTotal - p.candidates.reduce((t, c) => t + (c.pv || 0), 0);
  const pvCard = popular ? h('div', null,
    h('div', { class: 'ar-ev-list' },
      p.candidates.filter(c => c.pv).sort((a, b) => b.pv - a.pv).map(c => h('span', null, familyChip(famOf[c.id] || 'O', ''), h('b', null, full[c.id]), ` ${pctOf(c.pv, pvTotal)}`)),
      otherPv >= 0.005 * pvTotal ? h('span', null, familyChip('O', ''), h('b', null, 'Others'), ` ${pctOf(otherPv, pvTotal)}`) : null),
    h('div', { class: 'xs muted', style: { marginTop: '6px' } }, `${num(pvTotal)} votes counted in the states with a popular vote${legislature.length ? `; in ${legislature.length === 1 ? stateName(legislature[0]) : `${legislature.length} states`} the legislature chose the electors` : ''}.`))
    : h('p', { class: 'small muted', style: { margin: 0 } }, 'There is no national popular vote for this election: most electors were chosen by state legislatures, and few states kept full returns.');

  const rows = Object.entries(p.states).map(([code, st]) => ({ code, st, w: stateWin[code] }));
  const marginCell = (x) => {
    const m = x.w?.margin;
    if (m === null || m === undefined) return h('span', { class: 'muted' }, !x.st.votes ? (x.st.method === 'legislature' ? 'Legislature' : 'No returns') : x.st.partial ? 'Partial' : '—');
    // The electoral-vote winner's lead, or, where that winner trailed, who led the popular vote and by how much.
    const who = m >= 0 ? x.w.id : x.w.leader;
    return h('span', { style: { color: familyText(famOf[who] || 'O') } }, m >= 0 ? `+${points(m)}` : `${who === 'other' ? 'Others' : brief[who] || who} +${points(-m)}`);
  };
  const table = sortableTable([
    { key: 'st', label: 'State', render: x => stateName(x.code), sort: x => stateName(x.code), defaultAsc: true },
    { key: 'w', label: 'Electoral votes', render: x => (Object.keys(x.st.evs || {}).length
      // The separators sit outside the no-wrap entries, so a long list wraps on a phone.
      ? h('span', null, evOrder(x.st).map(([id, n], i) => [i ? ' · ' : '', h('span', { class: 'ar-evs' }, familyChip(famOf[id] || 'O', ''), `${brief[id] || id} ${n}`)]))
      : h('span', { class: 'muted' }, `${x.st.ev} not counted`)), sort: x => x.w?.id },
    { key: 'm', label: 'Margin', num: true, render: marginCell, sort: x => x.w?.margin ?? null },
    { key: 't', label: 'Votes', num: true, hideSm: true, render: x => (x.st.total ? num(x.st.total) : '—'), sort: x => x.st.total || 0 },
  ], rows, { sortKey: 'st', desc: false, stateKey: `ar-early-${y}` });

  const prev = y - 4;
  const who = slateGroups(p, groupOf).slice(0, 4).map(x => `${x.lead.name} (${x.lead.party})`).join(', ');
  return h('section', { class: 'section' },
    sectionHead('President', who),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Electoral votes', h('span', { class: 'ar-won', style: { color: familyText(famOf[w.id] || 'O') } }, `${w.name} won`)), evBar),
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Popular vote'), pvCard)),
    h('div', { class: 'card', style: { marginTop: '16px' } },
      h('div', { class: 'map-toolbar' }, h('span', { class: 'xs muted' }, 'Today’s state shapes. Shaded by the winner of each state’s electoral votes; darker for a bigger popular-vote margin.'),
        y >= 1860 ? h('a', { class: 'more small', href: swingUrl({ from: prev, to: y, level: 'states', style: 'arrows' }) }, `How the map shifted from ${prev} →`) : null),
      map, legend),
    h('div', { class: 'ar-table', style: { marginTop: '16px' } }, table),
    p.notes?.length ? h('ul', { class: 'sw-notes' }, p.notes.map(n => h('li', null, n))) : null);
}

function congressSection(e, data) {
  const c = data.congress;
  const chamber = (title, ch) => {
    const seats = ch.seats.filter(([, n]) => n > 0);
    return h('div', { class: 'card' }, h('div', { class: 'card-title' }, title, h('span', { class: 'muted', style: { textTransform: 'none', letterSpacing: 0 } }, `${ch.total} seats`)),
      h('div', { class: 'ar-ev-names' }, seatsLine(seats)), seatsBar(seats, 14),
      h('div', { class: 'xs muted', style: { marginTop: '6px' } }, [
        ch.minor?.length ? `Others: ${ch.minor.map(([party, n]) => `${party} ${n}`).join(', ')}. ` : '',
        ch.vacancies ? `${ch.vacancies} vacant. ` : '', ch.note || ''].join('') || ' '));
  };
  // The Congress chosen in 1912 met in March 1913, before the Seventeenth Amendment took effect: its senators were still
  // the legislatures' choices.
  return h('section', { class: 'section' },
    sectionHead(`The ${ordinalWord(c.number)} Congress`, `Chosen in the ${e.label} elections, serving ${c.years}: the House as the returns first stood, the Senate as the Congress began. ${e.year <= 1912 ? 'Senators were chosen by state legislatures until 1913, so the Senate split comes from those choices, not a popular vote.' : ''}`),
    h('div', { class: 'grid g2' }, chamber('House', c.house), chamber('Senate', c.senate)));
}

// One decimal, more for a margin that would otherwise read 0.0 (Roosevelt won California by 174 votes in 1912).
const points = (m) => m.toFixed(m >= 0.05 ? 1 : m >= 0.005 ? 2 : 3);
const ordinalWord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
// The sources checked for a year's corrections (including any that disagreed), by family, in a fixed order.
const SOURCE_NAMES = [
  [/American Presidency Project/, 'the American Presidency Project'], [/^Polidata/, 'Polidata'], [/Tribune Almanac/, 'the Tribune Almanac'],
  [/World Almanac/, 'the World Almanac'], [/State Election Board/, 'the Oklahoma State Election Board'], [/^A New Nation Votes/, 'A New Nation Votes'],
  [/^Vote Archive/, 'Vote Archive'], [/^Wikipedia/, 'Wikipedia’s articles on the states'],
];
const sourceNames = (corrections) => {
  const seen = Object.values(corrections).flatMap(c => c.sources || []);
  return SOURCE_NAMES.filter(([re]) => seen.some(n => re.test(n.replace(/^The /, '')))).map(([, name]) => name);
};
const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');

function sourcesNote(e, data) {
  const link = (s) => h('a', { href: s.rev ? `${s.url}?oldid=${s.rev}` : s.url, target: '_blank', rel: 'noopener' }, s.title);
  const wiki = data.sources.filter(s => s.rev), official = data.sources.filter(s => !s.rev);
  const corrections = data.president?.corrections || {};
  const fixed = Object.keys(corrections).map(stateName).sort();
  return h('section', { class: 'section' }, h('p', { class: 'xs muted', style: { maxWidth: '760px' } },
    'Before 1976 the archive is less complete: results by state for president, and the party split of each Congress, but no county maps or individual House and Senate races. Popular votes before the 1830s are partial: many legislatures chose the electors, and some states kept no full returns. ',
    wiki.length ? ['Presidential results: ', wiki.map(link), ' (CC BY-SA 4.0), with electoral votes checked against the National Archives’ records. '] : null,
    fixed.length ? `The returns for ${andList(fixed)} are corrected where two other sources agree (sources checked: ${andList(sourceNames(corrections))}). ` : null,
    'Party splits: ', official.map((s, i) => [i ? '; ' : '', link(s)]), '.'));
}
