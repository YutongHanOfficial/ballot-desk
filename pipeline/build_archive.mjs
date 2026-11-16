#!/usr/bin/env node
// Past federal elections for the archive (/archive) and the swing map (/swing), from the official returns compiled
// by the MIT Election Data and Science Lab (MEDSL, CC0, on Harvard Dataverse). Put these in pipeline/.cache/archive/:
//   1976-2024-president.csv     doi:10.7910/DVN/42MVDX   president by state
//   1976-2024-senate-state.csv  doi:10.7910/DVN/PEJ5QU   Senate by state
//   1976-2024-house.tab         doi:10.7910/DVN/IG0UN2   House by district (comma-separated, despite the name)
//   countypres_2000-2024.csv    doi:10.7910/DVN/VOQCHQ   president by county
// The House and county files sit behind a Dataverse guestbook, so they are downloaded by hand in a browser.
//
// Writes:
//   data/archive/index.json          one entry per general election, 1788-2024, with the headline numbers
//   data/archive/president.json      president by state, every year: { years: { 2024: { D, R, ev, states } } }
//   data/archive/YYYY.json           one election's Senate and House races
//   data/archive/counties-YYYY.json  president by county, 2000-2024: { fips: [total, dem, gop] }
//   data/geo/counties-us.json        every county in one TopoJSON file, simplified for a national map
//
// Before 1976 (less complete, no county maps): presidential results by state for 1788-1972, read from each
// election's Wikipedia article (CC BY-SA 4.0) into pipeline/early/president.json, with the electoral votes checked
// against the National Archives' records; and the party split of every Congress from the House's and Senate's own
// historians, in pipeline/early/congress.json. Those files are committed sources.
//
// One-time build: `npm run archive` (needs `npm install` for mapshaper, and pipeline/.cache/geo from `npm run geo`).
// The output is committed; the GitHub Action never runs this. Checks against official electoral votes and House
// seat totals are printed, and the build stops if one fails.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'pipeline', '.cache', 'archive');
const GEO_CACHE = path.join(ROOT, 'pipeline', '.cache', 'geo');
const OUT = path.join(ROOT, 'data', 'archive');
const MS = process.env.MAPSHAPER || path.join(ROOT, 'node_modules', '.bin', 'mapshaper');
const log = (...a) => console.log(...a);

const FIPS = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL',
  '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME',
  '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI',
  '56': 'WY',
};

// ------------------------------------------------------------------------------------------- reading

/** RFC 4180 CSV ("" escapes a quote), into objects keyed by the header row. */
function readCSV(file) {
  const text = fs.readFileSync(path.join(SRC, file), 'utf8');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((k, i) => [k, r[i]])));
}

const int = (x) => { const n = Math.round(parseFloat(x)); return Number.isFinite(n) ? n : 0; };
const isTrue = (x) => /^true$/i.test(x || '');

/** Rows that are not candidates: blank and spoiled ballots, which also stay out of the totals. */
const NOT_A_VOTE = /BLANK|OVER ?VOTE|UNDER ?VOTE|VOID|SPOILED|TOTAL VOTES|EXHAUSTED/i;
/** Write-ins and "other" lumped together: counted in the totals, never a winner. */
const LUMPED = /^(WRITE-?INS?|OTHERS?|SCATTERING|MISCELLANEOUS|NONE OF THESE CANDIDATES)$/i;

// Names come in capitals ("CARTER, JIMMY", "BILL DAVENPORT"). Title case, with the common surname patterns.
const KEEP_UPPER = new Set(['II', 'III', 'IV', 'V', 'JR.', 'SR.']);
const INNER_CAPS = { DELAURO: 'DeLauro', DESANTIS: 'DeSantis', DEFAZIO: 'DeFazio', DEGETTE: 'DeGette', DESJARLAIS: 'DesJarlais',
  DELAY: 'DeLay', DEWINE: 'DeWine', DEMINT: 'DeMint', LAHOOD: 'LaHood', LAMALFA: 'LaMalfa', LATOURETTE: 'LaTourette',
  LAROUCHE: 'LaRouche', MACARTHUR: 'MacArthur', DELBENE: 'DelBene', VANHOLLEN: 'Van Hollen', DESAULNIER: 'DeSaulnier',
  LATURNER: 'LaTurner', LAROSE: 'LaRose', MCMORRIS: 'McMorris', DEMINGS: 'Demings', DUPONT: 'du Pont' };
function titleCase(raw) {
  const s = String(raw || '').replace(/\\/g, '').replace(/\s+/g, ' ').trim().replace(/,\s*(JR|SR)\.?$/i, ' $1.');
  if (!s) return '';
  // "LAST, FIRST" -> "FIRST LAST"
  const flipped = /^[^,]+, [^,]+$/.test(s) && !/,\s*(JR|SR|II|III|IV)\.?$/i.test(s) ? s.replace(/^([^,]+), (.+)$/, '$2 $1') : s;
  return flipped.split(' ').map(w => {
    const bare = w.replace(/[^A-Z]/gi, '').toUpperCase();
    if (KEEP_UPPER.has(w.toUpperCase())) return w.toUpperCase().replace('JR.', 'Jr.').replace('SR.', 'Sr.');
    if (/^(JR|SR)\.?,?$/i.test(w)) return w[0].toUpperCase() + w.slice(1).toLowerCase();
    if (INNER_CAPS[bare]) return w.replace(new RegExp(bare, 'i'), INNER_CAPS[bare]);
    if (/^[A-Z]\.?$/i.test(w) || /^([A-Z]\.){2,3}$/i.test(w)) return w.toUpperCase();   // initials: J. or H.W.
    return w.toLowerCase()
      .replace(/^(\(?"?)mc([a-z])/, (m, a, b) => `${a}Mc${b.toUpperCase()}`)              // McCain
      .replace(/(^|[-'"(])([a-z])/g, (m, a, b) => a + b.toUpperCase());                   // after hyphens, apostrophes, quotes
  }).join(' ').replace(/\s+Jr\.?$/, ' Jr.').replace(/\s+Sr\.?$/, ' Sr.');
}

// Presidential nominees as people know them (MEDSL spells them "BUSH, GEORGE H.W.").
const NOMINEE = {
  'CARTER, JIMMY': 'Jimmy Carter', 'FORD, GERALD': 'Gerald Ford', 'REAGAN, RONALD': 'Ronald Reagan',
  'MONDALE, WALTER': 'Walter Mondale', 'BUSH, GEORGE H.W.': 'George H. W. Bush', 'DUKAKIS, MICHAEL': 'Michael Dukakis',
  'CLINTON, BILL': 'Bill Clinton', 'DOLE, ROBERT': 'Bob Dole', 'GORE, AL': 'Al Gore', 'BUSH, GEORGE W.': 'George W. Bush',
  'KERRY, JOHN': 'John Kerry', 'OBAMA, BARACK H.': 'Barack Obama', 'MCCAIN, JOHN': 'John McCain', 'ROMNEY, MITT': 'Mitt Romney',
  'CLINTON, HILLARY': 'Hillary Clinton', 'TRUMP, DONALD J.': 'Donald Trump', 'BIDEN, JOSEPH R. JR': 'Joe Biden',
  'HARRIS, KAMALA D.': 'Kamala Harris',
};

// ------------------------------------------------------------------------------------------- parties

/** D, R, I (independent), L, G or O from a detailed party label. */
function partyOf(label, simplified) {
  const p = String(label || '').toUpperCase();
  const s = String(simplified || '').toUpperCase();
  if (s === 'DEMOCRAT') return 'D';
  if (s === 'REPUBLICAN') return 'R';
  if (/^(DEMOCRAT|DEMOCRATIC)(IC)?\b|^DEMOCRATIC-(FARMER?-LABOR|NPL|NONPARTISAN LEAGUE)$|^WRITE-IN \(DEMOCRATIC\)$|\(DEMOCRAT\)$/.test(p)) return 'D';
  if (/^REPUBLICAN\b|^INDEPENDENT-REPUBLICAN$|^WRITE-IN \(REPUBLICAN\)$/.test(p)) return 'R';
  if (s === 'LIBERTARIAN' || /^LIBERTARIAN$/.test(p)) return 'L';
  if (/^GREEN$/.test(p)) return 'G';
  if (/INDEPENDENT|^NO PARTY|^NONPARTISAN|UNAFFILIATED|^CONNECTICUT FOR LIEBERMAN$/.test(p)) return 'I';
  return 'O';
}

/** Adds up a candidate's party lines (New York's fusion ballots and the like): [{ name, party, votes }], largest first. */
function candidates(rows, { simplified = false } = {}) {
  const by = new Map();
  for (const r of rows) {
    const raw = (r.candidate || '').replace(/\\/g, '').trim();
    if (NOT_A_VOTE.test(raw)) continue;
    const key = raw.toUpperCase() || 'OTHER';
    const c = by.get(key) || { raw, lines: [], votes: 0 };
    const v = int(r.candidatevotes);
    c.votes += v;
    c.lines.push([partyOf(r.party_detailed ?? r.party, simplified ? r.party_simplified : null), v, r.party_detailed ?? r.party]);
    by.set(key, c);
  }
  return [...by.values()].map(c => {
    // A major-party line wins over minor ones; otherwise the line with the most votes.
    const major = c.lines.filter(l => l[0] === 'D' || l[0] === 'R').sort((a, b) => b[1] - a[1])[0];
    const main = major || c.lines.sort((a, b) => b[1] - a[1])[0];
    const lumped = LUMPED.test(c.raw) || !c.raw;
    return { name: lumped ? 'Others' : titleCase(c.raw), party: lumped ? 'O' : main[0], label: main[2], votes: c.votes, lumped };
  }).sort((a, b) => b.votes - a.votes);
}

// ------------------------------------------------------------------------------------------- president by state

const EV_OFFICIAL = {
  // As cast. Faithless electors are listed; "pledged" adds them back to the candidate who won their state.
  1976: { D: 297, R: 240, other: [['Ronald Reagan', 1]], back: { R: 1 }, note: 'One Washington elector pledged to Gerald Ford voted for Ronald Reagan.' },
  1980: { D: 49, R: 489 },
  1984: { D: 13, R: 525 },
  1988: { D: 111, R: 426, other: [['Lloyd Bentsen', 1]], back: { D: 1 }, note: 'One West Virginia elector pledged to Michael Dukakis voted for Lloyd Bentsen.' },
  1992: { D: 370, R: 168 },
  1996: { D: 379, R: 159 },
  2000: { D: 266, R: 271, back: { D: 1 }, note: 'One District of Columbia elector pledged to Al Gore cast a blank ballot.' },
  2004: { D: 251, R: 286, other: [['John Edwards', 1]], back: { D: 1 }, note: 'One Minnesota elector pledged to John Kerry voted for John Edwards.' },
  2008: { D: 365, R: 173 },
  2012: { D: 332, R: 206 },
  2016: { D: 227, R: 304, other: [['Colin Powell', 3], ['John Kasich', 1], ['Ron Paul', 1], ['Bernie Sanders', 1], ['Faith Spotted Eagle', 1]],
    back: { D: 5, R: 2 }, note: 'Seven electors voted for someone other than their pledged candidate: five pledged to Hillary Clinton and two pledged to Donald Trump.' },
  2020: { D: 306, R: 232 },
  2024: { D: 226, R: 312 },
};
// Maine (since 1972) and Nebraska (since 1992) give an elector to each congressional district's winner. These are
// the only times a district went the other way from the state.
const SPLITS = { 2008: { NE: { R: 4, D: 1 } }, 2016: { ME: { D: 3, R: 1 } }, 2020: { NE: { R: 4, D: 1 }, ME: { D: 3, R: 1 } }, 2024: { NE: { R: 4, D: 1 }, ME: { D: 3, R: 1 } } };

function buildPresident(seatsByYear) {
  const rows = readCSV('1976-2024-president.csv');
  const years = {};
  for (const y of [...new Set(rows.map(r => +r.year))].sort()) {
    const ry = rows.filter(r => +r.year === y);
    const top = (party) => {
      const t = new Map();
      for (const r of ry) if (r.party_simplified === party && r.candidate && r.candidate !== 'OTHER') t.set(r.candidate, (t.get(r.candidate) || 0) + int(r.candidatevotes));
      return [...t].sort((a, b) => b[1] - a[1])[0][0];
    };
    const nomD = top('DEMOCRAT'), nomR = top('REPUBLICAN');
    const states = {}, others = new Map();
    let natD = 0, natR = 0, natT = 0;
    for (const st of [...new Set(ry.map(r => r.state_po))].sort()) {
      const rs = ry.filter(r => r.state_po === st);
      let D = 0, R = 0, T = 0;
      for (const r of rs) {
        if (NOT_A_VOTE.test(r.candidate || '')) continue;
        const v = int(r.candidatevotes);
        T += v;
        if (r.candidate === nomD) D += v; else if (r.candidate === nomR) R += v;
        else if (r.candidate && !LUMPED.test(r.candidate) && r.writein !== 'True') others.set(r.candidate, (others.get(r.candidate) || 0) + v);
      }
      states[st] = [T, D, R];
      natD += D; natR += R; natT += T;
    }
    // Electoral votes as pledged: every state's House seats plus two (D.C. three), to its winner, with the splits.
    const pledged = { D: 0, R: 0 };
    for (const [st, [, D, R]] of Object.entries(states)) {
      const ev = st === 'DC' ? 3 : (seatsByYear[y]?.[st] ?? NaN) + 2;
      const split = SPLITS[y]?.[st];
      if (split) { pledged.D += split.D || 0; pledged.R += split.R || 0; } else pledged[D > R ? 'D' : 'R'] += ev;
    }
    const off = EV_OFFICIAL[y];
    const ok = pledged.D === off.D + (off.back?.D || 0) && pledged.R === off.R + (off.back?.R || 0);
    log(`  ${y} president: ${NOMINEE[nomD]} ${pledged.D} – ${NOMINEE[nomR]} ${pledged.R} pledged electors; as cast ${off.D}–${off.R} ${ok ? 'ok' : 'MISMATCH'}`);
    if (!ok) throw new Error(`${y}: electoral votes from state results don't match the official count`);
    const third = [...others].filter(([, v]) => v / natT >= 0.01).sort((a, b) => b[1] - a[1])
      .map(([n, v]) => ({ name: n === 'PEROT, ROSS' ? 'Ross Perot' : n === 'ANDERSON, JOHN B.' ? 'John Anderson' : n === 'NADER, RALPH' ? 'Ralph Nader' : titleCase(n), votes: v }));
    years[y] = {
      D: NOMINEE[nomD] || titleCase(nomD), R: NOMINEE[nomR] || titleCase(nomR),
      ev: { D: off.D, R: off.R, other: off.other || null, note: off.note || null },
      votes: { D: natD, R: natR, total: natT }, others: third, states,
    };
  }
  return years;
}

// ------------------------------------------------------------------------------------------- Senate

// Louisiana Senate races that went to a December runoff. The file mixes the rounds (2002 adds them together, 2014's
// finalists are a million votes too high, 2016 puts runoff votes beside November ones), so the runoff comes from the
// official results as given on each race's Wikipedia page, and the November round is left out.
const SENATE_RUNOFFS = {
  '2002 LA': [['Mary Landrieu', 'D', 638654], ['Suzanne Haik Terrell', 'R', 596642]],
  '2014 LA': [['Bill Cassidy', 'R', 712379], ['Mary Landrieu', 'D', 561210]],
  '2016 LA': [['John Kennedy', 'R', 536191], ['Foster Campbell', 'D', 347816]],
};
// Races the file lacks, from the official results as given on each race's Wikipedia page. North Carolina in 1986
// held a regular and a special election the same day; the file has only the special. Illinois in 2010 did too; the
// file has its regular race, marked as the special.
const SENATE_ADDED = [
  { year: 1980, state: 'ND', special: false, total: 299272, cands: [['Mark Andrews', 'R', 210347], ['Kent Johanneson', 'D', 86658], ['Harley McLain', 'I', 1625], ['Don J. Klingensmith', 'I', 642]] },
  { year: 1986, state: 'NC', special: false, total: 1591330, cands: [['Terry Sanford', 'D', 823662], ['Jim Broyhill', 'R', 767668]] },
  { year: 2010, state: 'IL', special: true, total: 3544548, cands: [['Mark Kirk', 'R', 1677729], ['Alexi Giannoulias', 'D', 1641486], ['LeAlan Jones', 'G', 129571], ['Michael Labno', 'L', 95762]] },
  { year: 2022, state: 'CT', special: false, total: 1259887, cands: [['Richard Blumenthal', 'D', 723864], ['Leora Levy', 'R', 535943]] },
];
const SENATE_AS_REGULAR = new Set(['2010 IL']);
// Candidates the file lists without a party (Alaska's top-four ballot, write-ins and a few others).
const SENATE_PARTY = { '2010 AK murkowski': 'R', '2020 NE love': 'D', '2020 WY lummis': 'R', '2020 WY david': 'D', '2022 AK murkowski': 'R',
  '2022 AK tshibaka': 'R', '2022 AK chesbro': 'D', '2024 MS wicker': 'R', '2024 MS pinkins': 'D', '2024 NV rosen': 'D', '2024 NV brown': 'R' };
const surnameOf = (n) => n.replace(/,?\s+(Jr\.?|Sr\.?|II|III|IV)$/i, '').split(' ').pop().toLowerCase();

function buildSenate() {
  const rows = readCSV('1976-2024-senate-state.csv');
  const out = {};
  // Georgia's 2020 runoffs were held on January 5, 2021: they belong to the 2020 election.
  const cycle = (r) => (+r.year === 2021 ? 2020 : +r.year);
  const groups = new Map();
  for (const r of rows) {
    const special = isTrue(r.special) && !SENATE_AS_REGULAR.has(`${cycle(r)} ${r.state_po}`);
    const key = `${cycle(r)}|${r.state_po}|${special ? 1 : 0}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(r);
  }
  for (const [key, rs] of groups) {
    const [y, st, special] = key.split('|');
    const stage = (r) => { const s = r.stage.toLowerCase(); return s.includes('runoff') ? 'runoff' : s; };
    const stages = new Set(rs.map(stage));
    // Georgia 1992 and 2008: the November round is filed as 'pre' and the runoff as 'gen'.
    const finalStage = stages.has('runoff') ? 'runoff' : 'gen';
    const firstStage = stages.has('runoff') ? 'gen' : stages.has('pre') ? 'pre' : null;
    const labelled = (cs) => { for (const c of cs) { const p = SENATE_PARTY[`${y} ${st} ${surnameOf(c.name)}`]; if (p) c.party = p; } return cs; };
    const fin = labelled(candidates(rs.filter(r => stage(r) === finalStage), { simplified: true }));
    const first = firstStage ? labelled(candidates(rs.filter(r => stage(r) === firstStage), { simplified: true })) : null;
    const real = fin.filter(c => !c.lumped);
    const total = fin.reduce((s, c) => s + c.votes, 0);
    const race = { state: st, special: special === '1', total, cands: fin.slice(0, 4).map(c => [c.name, c.party, c.votes]) };
    if (real.length && real[0].votes <= 1) { race.unopposed = true; race.total = 0; race.cands = [[real[0].name, real[0].party, 0]]; }
    race.winner = real[0] ? { name: real[0].name, party: real[0].party } : null;
    if (first) race.first = { total: first.reduce((s, c) => s + c.votes, 0), cands: first.slice(0, 4).map(c => [c.name, c.party, c.votes]) };
    const fix = !race.special && SENATE_RUNOFFS[`${y} ${st}`];
    if (fix) {
      race.cands = fix; race.total = fix[0][2] + fix[1][2]; delete race.first; delete race.unopposed;
      race.winner = { name: fix[0][0], party: fix[0][1] }; race.decided = 'runoff';
      race.note = 'Decided in a December runoff between the top two finishers.';
    }
    if (first && !fix) race.decided = 'runoff';
    (out[y] ||= []).push(race);
  }
  for (const a of SENATE_ADDED) {
    if ((out[a.year] || []).some(r => r.state === a.state && r.special === a.special)) throw new Error(`${a.year} ${a.state} is on file now: drop it from SENATE_ADDED`);
    (out[a.year] ||= []).push({ state: a.state, special: a.special, total: a.total, cands: a.cands, winner: { name: a.cands[0][0], party: a.cands[0][1] } });
  }
  for (const y of Object.keys(out)) out[y].sort((a, b) => a.state.localeCompare(b.state) || a.special - b.special);
  return out;
}

// ------------------------------------------------------------------------------------------- House

// Seats the November returns don't settle: Louisiana's December runoffs, Maine's ranked-choice count, and a result
// that was never certified. Checked against the official seat totals below.
const HOUSE_FINAL = {
  '2004 LA-03': { name: 'Charlie Melancon', party: 'D', over: 'Tauzin', note: 'Won the December runoff.' },
  '2004 LA-07': { name: 'Charles Boustany', party: 'R', over: 'Mount', note: 'Won the December runoff.' },
  '2006 LA-02': { name: 'William Jefferson', party: 'D', over: 'Carter', note: 'Won the December runoff over Karen Carter.' },
  '2006 TX-23': { name: 'Ciro Rodriguez', party: 'D', over: 'Bonilla', note: 'Won a December runoff after a court-ordered redraw.' },
  '2012 LA-03': { name: 'Charles Boustany', party: 'R', over: 'Landry', note: 'Won the December runoff over Jeff Landry.' },
  '2014 LA-05': { name: 'Ralph Abraham', party: 'R', over: 'Mayo', note: 'Won the December runoff over Jamie Mayo.' },
  '2014 LA-06': { name: 'Garret Graves', party: 'R', over: 'Edwards', note: 'Won the December runoff over Edwin Edwards.' },
  '2016 LA-03': { name: 'Clay Higgins', party: 'R', over: 'Angelle', note: 'Won the December runoff over Scott Angelle.' },
  '2016 LA-04': { name: 'Mike Johnson', party: 'R', over: 'Jones', note: 'Won the December runoff over Marshall Jones.' },
  '2018 ME-02': { name: 'Jared Golden', party: 'D', note: 'Won after ranked-choice tabulation; Bruce Poliquin led on first choices.' },
  '2018 NC-09': { name: null, party: null, note: 'Not certified after an investigation into absentee ballot fraud; a new election was held in 2019.' },
  '2020 LA-05': { name: 'Luke Letlow', party: 'R', over: 'Harris', note: 'Won the December runoff over Lance Harris.' },
};
// Maine's ranked-choice races are filed as their final round, except 2022's 2nd district, which mixes in Tiffany
// Bond's first-round votes: keep the two finalists. Alaska's are filed as first choices.
const HOUSE_ROUNDS = {
  '2018 ME-02': 'Final round of the ranked-choice count.',
  '2022 ME-02': 'Final round of the ranked-choice count.',
  '2024 ME-02': 'Final round of the ranked-choice count.',
  '2022 AK-AL': 'First choices; Mary Peltola won after ranked-choice tabulation.',
  '2024 AK-AL': 'First choices; Nick Begich won after ranked-choice tabulation.',
};
const HOUSE_SEATS = {
  2024: { R: 220, D: 215 }, 2022: { R: 222, D: 213 }, 2020: { D: 222, R: 213 }, 2018: { D: 235, R: 199 }, 2016: { R: 241, D: 194 },
  2014: { R: 247, D: 188 }, 2012: { R: 234, D: 201 }, 2010: { R: 242, D: 193 }, 2008: { D: 257, R: 178 },
};

function buildHouse() {
  // The 50 states' general elections (D.C. and the territories elect non-voting delegates).
  const states = new Set(Object.values(FIPS).filter(s => s !== 'DC'));
  const rows = readCSV('1976-2024-house.tab').filter(r => states.has(r.state_po) && (r.stage === 'GEN' || (r.stage === 'PRI' && isTrue(r.special))));
  const groups = new Map();
  for (const r of rows) {
    const d = parseInt(r.district, 10);
    const id = `${r.state_po}-${d ? String(d).padStart(2, '0') : 'AL'}`;
    const key = `${r.year}|${id}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(r);
  }
  const out = {}, seatsByYear = {}, check = [];
  for (const [key, all] of groups) {
    // Special elections fill vacancies and are left out, except where a court-ordered redraw made the November
    // election itself a special one (Texas in 1996, filed as a primary, and 2006): then it is the seat's election.
    const [y, id] = key.split('|');
    const st = id.slice(0, 2);
    const runoff = all.filter(r => isTrue(r.runoff));
    const regular = all.filter(r => r.stage === 'GEN' && !isTrue(r.special) && !isTrue(r.runoff));
    const special = all.filter(r => isTrue(r.special) && !isTrue(r.runoff));
    const november = regular.length ? regular : special;
    const fin = candidates(runoff.length ? runoff : november);
    const first = runoff.length && november.length ? candidates(november) : null;
    const real = fin.filter(c => !c.lumped);
    const total = fin.reduce((s, c) => s + c.votes, 0);
    const race = { id, total, cands: fin.slice(0, 3).map(c => [c.name, c.party, c.votes]) };
    if (!real.length) continue;
    const rounds = HOUSE_ROUNDS[key.replace('|', ' ')];
    if (rounds) {
      race.note = rounds;
      if (key === '2022|ME-02') { race.cands = real.slice(0, 2).map(c => [c.name, c.party, c.votes]); race.total = real[0].votes + real[1].votes; }
    }
    if (real[0].votes <= 1 || total <= 1) { race.unopposed = true; race.total = 0; race.cands = [[real[0].name, real[0].party, 0]]; }
    race.winner = { name: real[0].name, party: real[0].party };
    if (first) race.first = { total: first.reduce((s, c) => s + c.votes, 0), cands: first.slice(0, 3).map(c => [c.name, c.party, c.votes]) };
    if (runoff.length) race.decided = 'runoff';
    const fix = HOUSE_FINAL[`${y} ${id}`];
    if (fix) {
      // Winner and runoff opponent must be candidates on file (matched by surname: the file has middle initials).
      const surname = (n) => n.replace(/\s+(Jr\.?|Sr\.?|II|III|IV)$/i, '').split(' ').pop().toLowerCase();
      const find = (n) => real.find(c => surname(c.name) === surname(n));
      const won = fix.name && find(fix.name), lost = fix.over && find(fix.over);
      if ((fix.name && !won) || (fix.over && !lost)) throw new Error(`${key}: ${fix.name} or ${fix.over} is not among the candidates on file`);
      race.winner = won ? { name: won.name, party: fix.party } : null;
      race.note = fix.note;
      race.decided = won ? (fix.over ? 'runoff' : 'rcv') : 'void';
      // Louisiana's file mostly mixes the rounds (runoff votes for the finalists, November ones for the rest), so
      // a runoff seat keeps its numbers only where the file holds just the two finalists.
      if (fix.over && real.length > 2) { race.cands = [[won.name, won.party, null], [lost.name, lost.party, null]]; race.total = null; delete race.first; }
    }
    // Louisiana's open primaries (in November from 1998, except 2008 and 2010, which had party primaries) need a
    // majority; anything less went to a December runoff the file may not hold.
    if (st === 'LA' && !runoff.length && !fix && !race.unopposed && real[0].votes * 2 <= total && +y >= 1998 && +y !== 2008 && +y !== 2010) check.push(`${y} ${id} ${real[0].name} ${(100 * real[0].votes / total).toFixed(1)}%`);
    (out[y] ||= []).push(race);
    (seatsByYear[y] ||= {})[st] = (seatsByYear[y][st] || 0) + 1;
  }
  if (check.length) { log('  Louisiana races with no majority and no runoff on file:', check); throw new Error('add these runoffs to HOUSE_FINAL'); }
  for (const y of Object.keys(out)) {
    out[y].sort((a, b) => a.id.localeCompare(b.id));
    const seats = { D: 0, R: 0, O: 0 };
    for (const r of out[y]) if (r.winner) seats[r.winner.party === 'D' || r.winner.party === 'R' ? r.winner.party : 'O']++;
    const want = HOUSE_SEATS[y];
    const ok = !want || (want.D === seats.D && want.R === seats.R);
    log(`  ${y} House: ${out[y].length} seats, D ${seats.D} R ${seats.R} other ${seats.O}${want ? (ok ? '  ok' : `  MISMATCH (official D ${want.D} R ${want.R})`) : ''}`);
    if (!ok) throw new Error(`${y}: House seats don't match the official totals`);
  }
  return { races: out, seatsByYear };
}

// ------------------------------------------------------------------------------------------- counties

// County codes that changed since 2000, mapped onto today's: Kansas City, Missouri votes apart from its counties
// (it lies mostly in Jackson); Bedford city joined Bedford County, Virginia in 2013, and Clifton Forge joined
// Alleghany County in 2001; Shannon County, South Dakota became Oglala Lakota County in 2015.
const FIPS_NOW = { '2938000': '29095', '51515': '51019', '51560': '51005', '46113': '46102' };

const STATE_NAME = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'the District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana',
  IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

function buildCounties(geoIds, presYears) {
  const notes = {};
  const rows = readCSV('countypres_2000-2024.csv');
  const years = {};
  // Some states list votes by method, some add a "TOTAL" for each candidate, and 2024 has a "TOTAL VOTES CAST" row:
  // use a candidate's total where there is one, else add up the methods; drop exact duplicates.
  const cell = new Map();
  for (const r of rows) {
    if (/^TOTAL VOTES CAST$/i.test(r.candidate)) continue;
    // Kansas City is filed under 2938000, except in 2024, under 36000 (New York's state code).
    const f = r.state_po === 'MO' && /^KANSAS CITY$/i.test(r.county_name) ? '2938000' : (r.county_fips || '').trim();
    if (!/^\d+$/.test(f)) continue;                 // statewide write-ins, overseas ballots and the like
    const key = `${r.year}|${f}|${r.candidate}|${r.party}`;
    const c = cell.get(key) || { totals: new Set(), modes: new Map() };
    const mode = (r.mode || 'TOTAL').toUpperCase();
    const v = int(r.candidatevotes);
    if (mode === 'TOTAL') c.totals.add(v); else if (!c.modes.has(mode)) c.modes.set(mode, v);
    cell.set(key, c);
  }
  for (const [key, c] of cell) {
    const [y, raw, , party] = key.split('|');
    const f = FIPS_NOW[raw] || raw.padStart(5, '0');
    if (f.startsWith('02')) continue;               // Alaska reports by state House district, not borough
    const v = c.totals.size ? [...c.totals].reduce((s, x) => s + x, 0) : [...c.modes.values()].reduce((s, x) => s + x, 0);
    const yr = (years[y] ||= {});
    const t = (yr[f] ||= [0, 0, 0]);
    t[0] += v;
    if (party === 'DEMOCRAT') t[1] += v; else if (party === 'REPUBLICAN') t[2] += v;
  }
  for (const [y, counties] of Object.entries(years)) {
    // Connecticut's counties gave way to planning regions in 2022; only years that match today's map are kept.
    const unmatched = Object.keys(counties).filter(f => !geoIds.has(f));
    const ctOld = unmatched.filter(f => f.startsWith('09'));
    for (const f of unmatched) delete counties[f];
    const other = unmatched.filter(f => !f.startsWith('09'));
    if (other.length) log(`  ${y}: counties not on today's map, left out:`, other.join(' '));
    // Each state's counties against the state file.
    const pres = presYears[y];
    const sum = {};
    for (const [f, [T, D, R]] of Object.entries(counties)) { const s = (sum[FIPS[f.slice(0, 2)]] ||= [0, 0, 0]); s[0] += T; s[1] += D; s[2] += R; }
    const off = [];
    for (const [st, [T, D, R]] of Object.entries(sum)) {
      const ref = pres.states[st];
      const dm = (100 * (D - R)) / T - (100 * (ref[1] - ref[2])) / ref[0];
      if (Math.abs(dm) <= 0.3) continue;
      off.push(`${st} margin off by ${dm.toFixed(2)}`);
      // Said on the swing map, so a shift that comes from the data is not read as a shift in the vote.
      const lean = dm > 0 ? 'Democrats' : 'Republicans';
      const short = (T - ref[0]) / ref[0];
      const why = st === 'NY' && +y === 2012 ? 'count only the main Democratic and Republican lines, without the Working Families and Conservative votes'
        : short < -0.01 ? `add up to ${Math.round(-100 * short)}% fewer votes than the official state total`
        : short > 0.01 ? `count ${Math.round(100 * short)}% more votes than the official state total`
        : 'differ slightly from the official state total';
      (notes[y] ||= []).push({ st, text: `${STATE_NAME[st][0].toUpperCase() + STATE_NAME[st].slice(1)}’s county returns ${why}, so its counties read ${Math.abs(dm).toFixed(1)} points better for ${lean} than the state result.` });
    }
    log(`  ${y} counties: ${Object.keys(counties).length}${ctOld.length ? ', Connecticut by state (old counties)' : ''}${off.length ? `; noted: ${off.join(', ')}` : ', every state within 0.3 points of the state file'}`);
  }
  return { years, notes };
}

function buildCountyMap() {
  const shp = path.join(GEO_CACHE, 'counties', 'cb_2025_us_county_500k.shp');
  if (!fs.existsSync(shp)) throw new Error(`${shp} missing: run npm run geo first`);
  const tmp = path.join(SRC, 'counties-us.json');
  execFileSync(MS, ['-i', shp, '-filter', `${JSON.stringify(Object.keys(FIPS))}.includes(STATEFP)`, '-filter-fields', 'GEOID,NAMELSAD,STATEFP',
    '-simplify', '3%', 'keep-shapes', 'weighting=0.7', '-o', 'format=topojson', 'quantization=60000', tmp], { stdio: ['ignore', 'pipe', 'inherit'] });
  const t = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  const obj = Object.values(t.objects)[0];
  for (const g of obj.geometries) g.properties = { id: g.properties.GEOID, n: g.properties.NAMELSAD };   // "Cook County", "Baltimore city"
  t.objects = { counties: obj };
  fs.writeFileSync(path.join(ROOT, 'data', 'geo', 'counties-us.json'), JSON.stringify(t));
  return new Set(obj.geometries.map(g => g.properties.id));
}

// ------------------------------------------------------------------------------------------- before 1976

const EARLY = path.join(ROOT, 'pipeline', 'early');
// Each year's Democratic and Republican nominees, so the swing map's state view reaches back to 1856. Lincoln ran
// on the National Union ticket in 1864; the Democrats endorsed the Liberal Republican Horace Greeley in 1872.
const DR_NOMINEES = {
  1856: ['buchanan', 'fremont'], 1860: ['douglas', 'lincoln'], 1864: ['mcclellan', 'lincoln'], 1868: ['seymour', 'grant'],
  1872: ['greeley', 'grant'], 1876: ['tilden', 'hayes'], 1880: ['hancock', 'garfield'], 1884: ['cleveland', 'blaine'],
  1888: ['cleveland', 'harrison'], 1892: ['cleveland', 'harrison'], 1896: ['bryan', 'mckinley'], 1900: ['bryan', 'mckinley'],
  1904: ['parker', 'roosevelt'], 1908: ['bryan', 'taft'], 1912: ['wilson', 'taft'], 1916: ['wilson', 'hughes'],
  1920: ['cox', 'harding'], 1924: ['davis', 'coolidge'], 1928: ['smith', 'hoover'], 1932: ['roosevelt', 'hoover'],
  1936: ['roosevelt', 'landon'], 1940: ['roosevelt', 'willkie'], 1944: ['roosevelt', 'dewey'], 1948: ['truman', 'dewey'],
  1952: ['stevenson', 'eisenhower'], 1956: ['stevenson', 'eisenhower'], 1960: ['kennedy', 'nixon'], 1964: ['johnson', 'goldwater'],
  1968: ['humphrey', 'nixon'], 1972: ['mcgovern', 'nixon'],
};
// Electoral votes cast by electors chosen on another candidate's slate: Greeley's, who split their votes after he died in
// November 1872, and the unpledged Democratic slates whose electors voted for Harry Byrd in 1960. The map gives those
// states the slate's colour and takes the margin from its popular vote.
const SLATES = {
  1872: { greeley: { label: 'Horace Greeley’s electors', cast: ['hendricks', 'brown', 'jenkins', 'davis'] } },
  1960: { unpledged: { label: 'Harry F. Byrd (unpledged electors)', cast: ['byrd'] } },
};
// The two elections the House of Representatives decided: everywhere else the president is the one with the most
// electoral votes.
const HOUSE_CHOSE = { 1800: 'jefferson', 1824: 'adams' };
// Colour hints where a year's candidates share a party: in 1824 all four were Democratic-Republicans, but Jackson's and
// Adams's followers are the Jacksonians and Adams men of the Congress split on the same page (blue and gold).
const FAMILY_HINTS = { 1824: { jackson: 'D', adams: 'Y', crawford: 'T' } };
// States left out of the swing map although both nominees had votes there, because the margin between them means
// nothing: in 1860 the vote against Lincoln in New Jersey, New York and Pennsylvania went to fusion tickets (counted for
// Douglas or Breckinridge on the year page), Harrison's 1892 Louisiana slate was shared with the Populists, and Taft had
// only write-ins in California in 1912.
const SWING_SKIP = {
  1860: {
    PA: ['D', 'most of the vote against Lincoln went to a fusion ticket, not to Douglas'],
    NJ: ['D', 'the vote against Lincoln went to a fusion ticket, so Douglas’s figure there is the whole anti-Lincoln vote'],
    NY: ['D', 'the vote against Lincoln went to a fusion ticket, so Douglas’s figure there is the whole anti-Lincoln vote'],
  },
  1892: { LA: ['R', 'the Republicans shared their elector slate with the Populists, so Harrison’s figure includes Weaver’s vote'] },
  1912: { CA: ['R', 'Taft was not on the ballot, so his votes were write-ins'] },
};
const plainId = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * An early year's president for the index card: one entry per slate, most electoral votes first, as [name, party for
 * its colour, electoral votes, colour hint], and which entry won. A slate keeps the party of its first candidate, as the
 * year page colours it (archive-early.js earlyFamilies).
 */
function indexPresident(r) {
  const groupOf = Object.fromEntries(r.candidates.map(x => [x.id, x.id]));
  for (const [key, s] of Object.entries(r.slates || {})) for (const id of s.cast) groupOf[id] = key;
  const first = new Map();
  for (const x of r.candidates) if (!first.has(groupOf[x.id])) first.set(groupOf[x.id], x);
  const groups = [];
  for (const x of r.candidates.filter(x => x.ev > 0)) {
    const g = groupOf[x.id], prior = groups.find(q => q.g === g);
    if (prior) { prior.ev += x.ev; prior.many = true; } else groups.push({ g, ev: x.ev, x });
  }
  groups.sort((a, b) => b.ev - a.ev);
  const won = groups.findIndex(q => q.g === groupOf[r.winner]);
  const keep = groups.slice(0, 4);
  if (won >= 4) keep.push(groups[won]);
  return {
    cands: keep.map(q => { const lead = first.get(q.g); return [q.many ? r.slates[q.g].label : q.x.name, lead.party, q.ev, lead.family || null]; }),
    winner: keep.indexOf(groups[won]), popular: r.candidates.some(x => x.pv),
  };
}

function buildEarly() {
  const pres = JSON.parse(fs.readFileSync(path.join(EARLY, 'president.json'), 'utf8'));
  const cong = JSON.parse(fs.readFileSync(path.join(EARLY, 'congress.json'), 'utf8'));
  const byElection = Object.fromEntries(cong.congresses.map(c => [c.election, c]));
  const files = {}, index = [], compat = {};
  const problems = [];
  for (const c of cong.congresses) {
    const y = c.election;
    const r = pres.years[y] || null;
    if (r) {
      // A state's total is at least its candidates' votes (a few totals on the pages are typos, or a margin), and each
      // candidate's popular vote is the sum of the state returns, so the national shares add up. Where Wikipedia's national
      // table gives a different figure, the year's notes say so. The exception is a state marked overlap, where voters could
      // pick electors from more than one slate (Alabama, 1960): its total is the ballots cast, below the sum of the votes.
      for (const [code, st] of Object.entries(r.states)) {
        if (!st.votes) continue;
        const sum = Object.values(st.votes).reduce((t, v) => t + (v || 0), 0);
        if (st.overlap) { if (!(st.total > 0 && st.total < sum)) problems.push(`${y} ${code}: overlap, but its total isn't below its votes`); }
        else if (!(st.total >= sum)) st.total = sum;
      }
      for (const cand of r.candidates) {
        const sum = Object.values(r.states).reduce((t, st) => t + (st.votes?.[cand.id] || 0), 0);
        if (sum > 0) cand.pv = sum;
      }
      r.winner = HOUSE_CHOSE[y] || r.candidates[0].id;
      if (!r.candidates.some(cand => cand.id === r.winner)) problems.push(`${y}: no winner ${r.winner}`);
      for (const [id, fam] of Object.entries(FAMILY_HINTS[y] || {})) {
        const cand = r.candidates.find(x => x.id === id);
        if (cand) cand.family = fam; else problems.push(`${y}: no candidate ${id} for a colour hint`);
      }
      if (SLATES[y]) {
        r.slates = SLATES[y];
        for (const [key, s] of Object.entries(r.slates)) for (const id of [key, ...s.cast]) {
          if (!r.candidates.some(cand => cand.id === id)) problems.push(`${y}: slate ${key} names ${id}, not a candidate`);
        }
      }
      // Every candidate's electoral votes must add up across the states, and no state's to more than it had (before 1804
      // a state's ev is already the votes cast, two per elector).
      for (const cand of r.candidates) {
        const sum = Object.values(r.states).reduce((t, st) => t + (st.evs?.[cand.id] || 0), 0);
        if (sum !== cand.ev) problems.push(`${y} ${cand.name}: states add up to ${sum}, national ${cand.ev}`);
      }
      for (const [code, st] of Object.entries(r.states)) {
        const sum = Object.values(st.evs || {}).reduce((t, v) => t + v, 0);
        if (sum > st.ev) problems.push(`${y} ${code}: ${sum} electoral votes, more than its ${st.ev}`);
      }
      const pair = DR_NOMINEES[y];
      if (pair) {
        const find = (id) => r.candidates.find(cand => plainId(cand.id) === id);
        const D = find(pair[0]), R = find(pair[1]);
        if (!D || !R) problems.push(`${y}: no candidate ${!D ? pair[0] : pair[1]} for the swing map`);
        else {
          const states = {}, offBallot = {}, offNotes = {};
          let total = 0;
          for (const [code, st] of Object.entries(r.states)) {
            if (!st.votes || !(st.total > 0)) continue;   // electors chosen by the legislature: no popular vote
            total += st.total;
            // A margin between the two means nothing where one of them had no votes counted: off the ballot (Lincoln in
            // most of the South, Truman in Alabama) or folded into a fusion ticket (Douglas in New York). Left out.
            const d = st.votes[D.id] || 0, rv = st.votes[R.id] || 0;
            if (!d || !rv) { offBallot[code] = `${d ? '' : 'D'}${rv ? '' : 'R'}`; continue; }
            const skip = SWING_SKIP[y]?.[code];
            if (skip) { offBallot[code] = skip[0]; offNotes[code] = skip[1]; continue; }
            states[code] = [st.total, d, rv];
          }
          for (const code of Object.keys(SWING_SKIP[y] || {})) if (!offNotes[code]) problems.push(`${y} ${code}: in SWING_SKIP but has no popular vote for both`);
          compat[y] = {
            D: D.name, R: R.name, early: true,
            ev: { D: D.ev, R: R.ev, other: r.candidates.filter(x => x !== D && x !== R && x.ev > 0).map(x => [x.name, x.ev]), note: null },
            votes: { D: D.pv || 0, R: R.pv || 0, total }, others: [], states,
            ...(Object.keys(offBallot).length ? { offBallot } : {}), ...(Object.keys(offNotes).length ? { offNotes } : {}),
          };
        }
      }
    }
    const label = y === 1788 ? '1788–89' : String(y);
    const seats = (ch) => ch.seats.filter(([, n]) => n > 0).map(([party, n]) => [party, n]);
    index.push({
      year: y, label, early: true, presidential: !!r, counties: false,
      president: r ? indexPresident(r) : null,
      congress: { number: c.congress, house: seats(c.house), senate: seats(c.senate) },
    });
    // sourceNotes (how each figure was read) stay in the committed source; the page shows only the notes.
    const pub = r ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'sourceNotes')) : null;
    files[y] = { year: y, label, early: true, president: pub, congress: { number: c.congress, years: c.years, house: c.house, senate: c.senate },
      sources: [r ? { title: `Wikipedia, "${label} United States presidential election"`, url: r.url, rev: r.rev } : null,
        { title: `House Office of the Historian, "${cong.house.title}"`, url: cong.house.url },
        { title: `Senate Historical Office, "${cong.senate.title}"`, url: cong.senate.url }].filter(Boolean) };
  }
  for (const y of Object.keys(pres.years)) if (!byElection[y]) problems.push(`${y}: a presidential year with no Congress row`);
  log(`  ${index.length} elections from ${index[0].year} to ${index[index.length - 1].year}, ${Object.keys(pres.years).length} presidential; swing map from ${Math.min(...Object.keys(compat).map(Number))}`);
  if (problems.length) { log('  check:', problems); throw new Error('the early results do not add up'); }
  return { files, index, compat };
}

// ------------------------------------------------------------------------------------------- main

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  log('House');
  const house = buildHouse();
  log('President');
  const president = buildPresident(house.seatsByYear);
  log('Senate');
  const senate = buildSenate();
  log('Counties');
  const geoIds = buildCountyMap();
  const { years: counties, notes: countyNotes } = buildCounties(geoIds, president);
  log('Before 1976');
  const early = buildEarly();

  const index = [...early.index];
  for (const [y, f] of Object.entries(early.files)) fs.writeFileSync(path.join(OUT, `${y}.json`), JSON.stringify(f));
  Object.assign(president, early.compat);
  const years = [...new Set([...Object.keys(house.races), ...Object.keys(senate)])].map(Number).filter(y => y % 2 === 0).sort();
  for (const y of years) {
    const hr = house.races[y] || [], sr = senate[y] || [];
    const seats = { D: 0, R: 0, O: 0 }, hv = { D: 0, R: 0, total: 0 };
    for (const r of hr) {
      if (r.winner) seats[r.winner.party === 'D' || r.winner.party === 'R' ? r.winner.party : 'O']++;
      if (r.total === null) continue;   // runoff seats whose rounds are mixed in the file
      for (const [, p, v] of r.cands) if (p === 'D' || p === 'R') hv[p] += v;
      hv.total += r.total;
    }
    const sw = { D: 0, R: 0, O: 0 };
    for (const r of sr) if (r.winner) sw[r.winner.party === 'D' || r.winner.party === 'R' ? r.winner.party : 'O']++;
    const p = president[y];
    index.push({
      year: y, presidential: !!p, counties: !!counties[y], countyNotes: countyNotes[y] || null,
      president: p ? { D: p.D, R: p.R, ev: { D: p.ev.D, R: p.ev.R }, votes: p.votes } : null,
      senate: { races: sr.length, won: sw }, house: { seats, votes: hv },
    });
    fs.writeFileSync(path.join(OUT, `${y}.json`), JSON.stringify({ year: y, senate: sr, house: hr }));
    if (counties[y]) fs.writeFileSync(path.join(OUT, `counties-${y}.json`), JSON.stringify(counties[y]));
  }
  fs.writeFileSync(path.join(OUT, 'president.json'), JSON.stringify({ years: president }));
  index.sort((a, b) => a.year - b.year);
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
    source: 'MIT Election Data and Science Lab, Harvard Dataverse (CC0); before 1976, Wikipedia (CC BY-SA 4.0) and the House and Senate historians', built: new Date().toISOString().slice(0, 10), years: index,
  }));
  const kb = (f) => `${(fs.statSync(f).size / 1024).toFixed(0)} KB`;
  log('Wrote', fs.readdirSync(OUT).length, 'files to data/archive; counties-us.json', kb(path.join(ROOT, 'data', 'geo', 'counties-us.json')),
    '; 2024.json', kb(path.join(OUT, '2024.json')), '; counties-2024.json', kb(path.join(OUT, 'counties-2024.json')));
}

main();
