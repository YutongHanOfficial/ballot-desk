// Election simulator: one-click outcomes, and a replay of an entire election night.
//
// A scenario is one correlated draw of every race's final margin from the forecast (drawMargins). For
// election night each race also gets a turnout, a time its polls close, a counting curve and an
// "early-vote skew" (ballots counted first often lean one way), so leads can shrink or flip as the count
// goes on. Races are projected once the same live model the site uses on the real night is sure of the
// winner. Everything is a pure function of (scenario, time), so the timeline can be scrubbed.
import { store, notify } from './store.js';
import { MODEL, rng, drawMargins, liveEstimate } from './model.js';
import { POLL_CLOSE_ET, pollCloseDate } from './config.js';
import { PARTY_NAME, marginFill } from './ui.js';
import { countyBaseline, loadCountyBaseline } from './geo.js';

/** County data the replay needs; resolve this before makeScenario() for county-by-county counting. */
export const ensureSimData = () => loadCountyBaseline().catch(() => null);

const SIX_PM = Date.UTC(2026, 10, 3, 23, 0);   // Nov 3, 6 p.m. Eastern
export const START = -10;                       // minutes after 6 p.m.
export const NIGHT_END = 600;                   // 4 a.m.
export const END = 900;                         // then four compressed days of late counting

// Counting by state: [share of ballots counted by 4 a.m., minutes to count half of that, early-vote skew].
// Skew is in points of margin, left-positive: +4 means the first ballots counted run 4 points more
// Democratic than the final result (a "blue mirage"); -5 means a "red mirage" that later shifts blue.
const COUNT = {
  FL: [0.98, 45, 4], NC: [0.97, 55, 5], GA: [0.97, 60, 4], TX: [0.96, 75, 3], OH: [0.96, 60, 3], IN: [0.97, 50, 2],
  KY: [0.98, 45, 3], VA: [0.95, 70, 4], SC: [0.97, 60, 2], NH: [0.95, 80, 0], VT: [0.95, 70, 0], WV: [0.97, 55, 1],
  AL: [0.97, 60, 1], MS: [0.95, 70, 1], TN: [0.97, 50, 2], AR: [0.97, 55, 1], LA: [0.97, 60, 1], OK: [0.98, 45, 1],
  KS: [0.96, 60, 1], NE: [0.95, 70, 0], SD: [0.97, 50, 0], ND: [0.97, 50, 0], MO: [0.97, 55, 1], IA: [0.96, 60, 1],
  MN: [0.95, 75, -2], WI: [0.94, 110, -5], MI: [0.92, 120, -3], IL: [0.9, 90, -1], PA: [0.9, 130, -5], NY: [0.88, 90, -2],
  NJ: [0.88, 90, -1], CT: [0.93, 80, -1], RI: [0.95, 60, -1], MA: [0.95, 70, -1], ME: [0.9, 90, 0], MD: [0.75, 70, -3],
  DE: [0.95, 60, 0], CO: [0.85, 60, -1], NM: [0.93, 70, 0], AZ: [0.7, 60, -3], NV: [0.75, 80, -4], UT: [0.75, 70, -2],
  ID: [0.95, 60, 0], MT: [0.94, 70, 0], WY: [0.97, 45, 0], CA: [0.58, 50, -4], OR: [0.68, 50, -2], WA: [0.62, 50, -3],
  AK: [0.6, 90, 0], HI: [0.85, 60, 0],
};
const VOTES_PER_DISTRICT = 265000;

export function clock(t) { return new Date(SIX_PM + t * 60000); }
export function clockLabel(t, { short = false } = {}) {
  if (t <= NIGHT_END) {
    const s = clock(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    return short ? s : `${s} ET`;
  }
  const day = Math.min(4, Math.ceil((t - NIGHT_END) / ((END - NIGHT_END) / 4)));
  const d = new Date(Date.UTC(2026, 10, 4 + day - 1, 17));
  return d.toLocaleDateString('en-US', { weekday: short ? 'short' : 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}
const iso = (t) => (t <= NIGHT_END ? clock(t) : new Date(SIX_PM + NIGHT_END * 60000 + (t - NIGHT_END) / (END - NIGHT_END) * 4 * 864e5)).toISOString();

function closeMinutes(state) {
  const d = pollCloseDate(state);
  return d ? Math.round((d - SIX_PM) / 60000) : 120;
}

export function randomSeed() { return Math.floor(Math.random() * 1e9); }

const simRaces = () => store.races.filter(r => r.left || r.right);

// ------------------------------------------------------------------------------------------- scenario

export function makeScenario({ seed = randomSeed(), nat = null } = {}) {
  const R = rng(seed);
  const races = simRaces();
  const ests = {};
  for (const r of races) if (r.mu !== null && r.mu !== undefined) ests[r.id] = { mu: r.mu, sd: r.sd, settled: r.settled || !r.left || !r.right };
  const { margins, nat: natErr } = drawMargins(races, ests, R, { nat });
  const nDist = {};
  for (const r of store.races) if (r.type === 'house') nDist[r.state] = (nDist[r.state] || 0) + 1;
  const stateMood = {};
  const per = {};
  for (const r of races) {
    const c = COUNT[r.state] || [0.9, 70, 0];
    const sm = stateMood[r.state] || (stateMood[r.state] = {
      speed: 0.85 + R.uni() * 0.3, skew: c[2] * (0.6 + R.uni() * 0.8) + (R.uni() - 0.5) * 2, turnout: 0.85 + R.uni() * 0.3,
      finish: c[0] >= 0.95 ? 0.25 + R.uni() * 0.2 : c[0] >= 0.85 ? 0.45 + R.uni() * 0.3 : 0.8 + R.uni() * 0.2,
    });
    const close = closeMinutes(r.state);
    const statewide = r.type !== 'house';
    const contested = !!(r.left && r.right);
    per[r.id] = {
      margin: contested ? (margins[r.id] ?? r.mu ?? 0) : (r.left ? 60 : -60),
      total: Math.round((statewide ? (nDist[r.state] || 1) : 1) * VOTES_PER_DISTRICT * sm.turnout * (0.94 + R.uni() * 0.12)),
      close, start: close + 3 + R.uni() * 14,
      night: Math.min(0.995, c[0] * (0.96 + R.uni() * 0.05)), half: c[1] * sm.speed * (0.8 + R.uni() * 0.4),
      finish: sm.finish, skew: sm.skew * (0.7 + R.uni() * 0.6), other: contested ? 0.012 + R.uni() * 0.022 : 0,
      contested,
    };
  }
  // Statewide races are counted county by county (separate random stream, so the race-level draws above
  // are identical with or without county data).
  const base = countyBaseline();
  if (base) {
    const byState = countiesByState(base);
    const RC = rng((seed ^ 0x5bd1e995) >>> 0);
    for (const r of races) {
      const p = per[r.id];
      if (r.type === 'house' || !p.contested || !byState[r.state]) continue;
      p.counties = countyParams(RC, p, byState[r.state]);
      p.total = p.counties.reduce((t, c) => t + c.total, 0);
    }
  }
  // Same-party races: which of the two wins (own stream, so every other draw is unchanged).
  const RD = rng((seed ^ 0x2c1b3c6d) >>> 0);
  for (const r of races) if (r.duel && per[r.id]) per[r.id].duel = { margin: r.duel.mu + r.duel.sd * RD.normal() };
  const sc = { seed, nat: natErr, natFixed: nat !== null && nat !== undefined, races: per };
  scheduleCalls(sc);
  sc.events = buildEvents(sc);
  sc.outcome = outcome(sc);
  return sc;
}

// ------------------------------------------------------------------------------------------- counties

let byStateMemo = null;
function countiesByState(base) {
  if (byStateMemo && byStateMemo.base === base) return byStateMemo.out;
  const codeOf = Object.fromEntries(store.states.map(s => [s.fips, s.code]));
  const out = {};
  for (const [fips, [total, dem, gop]] of Object.entries(base)) {
    const st = codeOf[fips.slice(0, 2)];
    if (!st || !total) continue;
    (out[st] ||= []).push({ fips, total, m24: 100 * (dem - gop) / total });
  }
  byStateMemo = { base, out };
  return out;
}

/** Shift each county's 2024 lean to this scenario's statewide result, then give it its own count. */
function countyParams(R, p, list) {
  const tot = list.reduce((s, c) => s + c.total, 0);
  let cs = list.map(c => ({ fips: c.fips, w: (c.total / tot) * (0.92 + R.uni() * 0.16), m24: c.m24 }));
  const wsum = cs.reduce((s, c) => s + c.w, 0);
  cs.forEach(c => { c.w /= wsum; });
  const m24 = cs.reduce((s, c) => s + c.w * c.m24, 0);
  cs.forEach(c => { c.margin = c.m24 + (p.margin - m24) + 2.5 * R.normal(); });
  for (let i = 0; i < 4; i++) {          // re-centre so the counties add up to the statewide margin
    const d = p.margin - cs.reduce((s, c) => s + c.w * c.margin, 0);
    cs.forEach(c => { c.margin = Math.max(-96, Math.min(96, c.margin + d)); });
  }
  const order = cs.slice().sort((a, b) => a.w - b.w);
  order.forEach((c, i) => { c.size = order.length > 1 ? i / (order.length - 1) : 0.5; });
  return cs.map(c => ({
    fips: c.fips, margin: c.margin, total: Math.max(50, Math.round(p.total * c.w)),
    start: p.start + R.uni() * 16,
    half: p.half * (0.6 + 0.9 * c.size) * (0.85 + R.uni() * 0.3),               // big counties count slower
    night: Math.min(0.998, p.night * (c.size > 0.85 ? 0.9 + R.uni() * 0.08 : 0.98 + R.uni() * 0.03)),
    finish: p.finish, skew: p.skew * (0.5 + R.uni()), other: p.other,
  }));
}

// ------------------------------------------------------------------------------------------- counting

function fracAt(p, t) {
  if (t < p.start) return 0;
  const tau = p.half / Math.pow(Math.LN2, 1 / 1.6);
  const nightAt = (x) => p.night * (1 - Math.exp(-Math.pow(Math.max(0, x - p.start) / tau, 1.6)));
  if (t <= NIGHT_END) return nightAt(t);
  const base = nightAt(NIGHT_END);
  const done = Math.min(1, (t - NIGHT_END) / ((END - NIGHT_END) * p.finish));
  return base + (1 - base) * done;
}

function votesAt(p, t) {
  if (p.counties) {
    let counted = 0, left = 0, right = 0, others = 0;
    for (const c of p.counties) { const v = oneCount(c, t); counted += v.counted; left += v.left; right += v.right; others += v.others; }
    return { f: p.total ? counted / p.total : 0, counted, left, right, others };
  }
  return oneCount(p, t);
}

function oneCount(p, t) {
  const f = fracAt(p, t);
  const counted = Math.round(p.total * f);
  const m = Math.max(-98, Math.min(98, p.margin + p.skew * Math.pow(1 - f, 1.3)));
  const others = Math.round(counted * p.other);
  const two = counted - others;
  const left = Math.round(two * (0.5 + m / 200));
  return { f, counted, left, right: two - left, others, m };
}

const winnerShare = (p) => (1 - p.other) * (0.5 + Math.abs(p.margin) / 200);

/** When each race gets projected: at poll close for safe seats, otherwise once the live model is sure. */
function scheduleCalls(sc) {
  for (const [id, p] of Object.entries(sc.races)) {
    const r = store.byId[id];
    p.side = p.margin > 0 ? 'left' : 'right';
    if (!p.contested) { p.callT = p.close; if (p.duel) p.duel.callT = duelCallT(r, p); continue; }
    const prior = { mu: r.mu, sd: r.sd, pLeft: r.p };
    const favoredWins = (r.p >= 0.5) === (p.margin > 0);
    if (favoredWins && Math.max(r.p, 1 - r.p) >= 0.995 && Math.abs(p.margin) > 8) { p.callT = p.close; continue; }
    if (Math.abs(p.margin) < 0.5) { p.callT = END; p.recount = true; continue; }
    p.callT = END;
    for (let t = Math.ceil(p.start); t <= END; t += 3) {
      const v = votesAt(p, t);
      if (v.f < 0.12) continue;
      const est = liveEstimate(prior, { eevp: v.f * 100, total: v.counted, left: v.left, right: v.right }, 0, MODEL.natSd);
      if ((p.side === 'left' && est.pLeft >= 0.997) || (p.side === 'right' && est.pLeft <= 0.003)) { p.callT = t; break; }
    }
    const rcv = r.state === 'AK' || (r.state === 'ME' && (r.type === 'senate' || r.type === 'house'));
    if (rcv && winnerShare(p) < 0.5) { p.callT = Math.max(p.callT, NIGHT_END + 180); p.rcv = true; }
    if (r.state === 'GA' && (r.type === 'senate' || r.type === 'gov') && winnerShare(p) < 0.5) { p.runoff = true; p.callT = Infinity; }
  }
}

/** Same-party race: called once the live model is sure which of the two is ahead. */
function duelCallT(r, p) {
  const d = r.duel, m = p.duel.margin;
  if (Math.abs(m) < 0.5) return END;
  for (let t = Math.ceil(p.start); t <= END; t += 3) {
    const v = votesAt(p, t);
    if (v.f < 0.12) continue;
    const a = Math.round(v.counted * (0.5 + m / 200));
    const est = liveEstimate({ mu: d.mu, sd: d.sd, pLeft: d.pA }, { eevp: v.f * 100, total: v.counted, left: a, right: v.counted - a }, 0, 0);
    if ((m > 0 && est.pLeft >= 0.997) || (m < 0 && est.pLeft <= 0.003)) return t;
  }
  return END;
}

export function resultsAt(sc, t) {
  const out = {};
  for (const [id, p] of Object.entries(sc.races)) {
    if (t < p.close) continue;
    const r = store.byId[id];
    const v = votesAt(p, t);
    const called = t >= p.callT ? p.side : null;
    const runoff = p.runoff && t >= NIGHT_END;
    const cands = [];
    if (r.left) cands.push({ name: r.left, party: r.leftParty, votes: p.contested ? v.left : v.counted, winner: called === 'left' });
    if (r.right) cands.push({ name: r.right, party: r.rightParty, votes: p.contested ? v.right : v.counted, winner: called === 'right' });
    if (v.others) cands.push({ name: 'Others', party: 'O', votes: v.others, winner: false });
    let duel;
    if (p.duel) {
      const m = p.duel.margin, a = Math.round(v.counted * (0.5 + m / 200));
      const won = t >= p.duel.callT ? (m > 0 ? 'a' : 'b') : null;
      duel = { a, b: v.counted - a, total: v.counted, eevp: Math.round(v.f * 1000) / 10, won };
      cands.length = 0;
      cands.push({ name: r.duel.a, party: r.duel.party, votes: a, winner: won === 'a' }, { name: r.duel.b, party: r.duel.party, votes: v.counted - a, winner: won === 'b' });
    }
    const total = v.counted;
    cands.forEach(c => { c.pct = total ? c.votes / total : 0; });
    cands.sort((a, b) => b.votes - a.votes);
    let counties;
    if (p.counties) {
      counties = {};
      for (const c of p.counties) { const cv = oneCount(c, t); counties[c.fips] = [cv.f, cv.left, cv.right, cv.counted]; }
    }
    out[id] = {
      counties,
      eevp: Math.round(v.f * 1000) / 10, total, left: p.contested ? v.left : (r.left ? v.counted : 0), right: p.contested ? v.right : (r.right ? v.counted : 0),
      called, calledAt: called ? iso(p.callT) : null, runoff, status: called ? 'called' : runoff ? 'runoff' : total ? 'counting' : 'too_early',
      cands, duel, updated: iso(t), demo: true,
    };
  }
  return out;
}

// ------------------------------------------------------------------------------------------- outcome

const NAMES = { senate: 'Senate', house: 'House', gov: 'governor' };

function winnerParty(r, p) { return p.margin > 0 ? r.leftParty : r.rightParty; }

export function outcome(sc) {
  const seats = {
    senate: { ...store.base.chambers.senate.notUp, I: 0 },
    house: { D: 0, R: 0, I: 0 },
    gov: Object.values(store.base.chambers.governors.notUp).reduce((a, p) => { a[p] = (a[p] || 0) + 1; return a; }, { D: 0, R: 0, I: 0 }),
  };
  const flips = [], upsets = [], close = [];
  for (const [id, p] of Object.entries(sc.races)) {
    const r = store.byId[id];
    const party = winnerParty(r, p);
    if (seats[r.type]) seats[r.type][party === 'D' || party === 'R' ? party : 'I']++;
    if (r.holder && party !== r.holder && p.contested) flips.push({ r, party, margin: p.margin });
    const pWin = p.margin > 0 ? r.p : 1 - r.p;
    if (p.contested && pWin !== null && pWin < 0.3) upsets.push({ r, party, margin: p.margin, pWin });
    if (p.contested) close.push({ r, party, margin: p.margin });
  }
  close.sort((a, b) => Math.abs(a.margin) - Math.abs(b.margin));
  upsets.sort((a, b) => a.pWin - b.pWin);
  const control = {
    senate: seats.senate.D >= 51 ? 'D' : seats.senate.R >= 50 ? 'R' : 'split',
    house: seats.house.D >= 218 ? 'D' : seats.house.R >= 218 ? 'R' : 'split',
    gov: seats.gov.D >= 26 ? 'D' : seats.gov.R >= 26 ? 'R' : 'split',
  };
  return { seats, control, flips, upsets, close };
}

/** Margin colour for a simulated result: party colour, darker for bigger wins. */
/** A simulated race on the site-wide margin scale (ui.js MARGIN_BANDS). */
export function simFill(sc, r) {
  const p = sc.races[r.id];
  return p ? marginFill(winnerParty(r, p), Math.abs(p.margin)) : 'var(--none)';
}

// ------------------------------------------------------------------------------------------- events

function buildEvents(sc) {
  const ev = [];
  const byClose = {};
  for (const st of Object.keys(POLL_CLOSE_ET)) {
    if (!store.stateByCode[st]) continue;
    const t = closeMinutes(st);
    (byClose[t] ||= []).push(st);
  }
  for (const [t, sts] of Object.entries(byClose)) {
    const names = sts.map(s => store.stateByCode[s].name).sort();
    ev.push({ t: +t, kind: 'close', text: `Polls close in ${listText(names)}.`, states: sts });
  }
  // Projections: competitive races get their own line; safe seats are grouped by minute.
  const downBallot = (r) => r.type === 'ltgov' || r.type === 'ag' || r.type === 'sos';
  const calls = Object.entries(sc.races).filter(([, p]) => Number.isFinite(p.callT)).map(([id, p]) => ({ id, p, r: store.byId[id] }))
    .filter(x => !downBallot(x.r) || (x.p.contested && Math.abs(x.r.p - 0.5) < 0.45));
  const grouped = {};
  for (const c of calls) {
    const competitive = c.p.contested && Math.abs((c.r.p ?? 0.5) - 0.5) < 0.47;
    const party = winnerParty(c.r, c.p);
    const name = c.p.side === 'left' ? c.r.left : c.r.right;
    if (competitive) {
      const flip = c.r.holder && party !== c.r.holder;
      ev.push({
        t: c.p.callT, kind: 'call', party, id: c.id, big: c.r.type === 'senate' || c.r.type === 'gov',
        text: `${name} (${party}) wins ${c.r.title}${flip ? `, a ${party === 'D' ? 'Democratic' : party === 'R' ? 'Republican' : 'independent'} pickup` : ''}${c.p.rcv ? ' after ranked-choice tabulation' : ''}.`,
        flip,
      });
    } else {
      const key = `${c.p.callT}`;
      (grouped[key] ||= { t: c.p.callT, D: 0, R: 0, O: 0, n: 0 });
      grouped[key][party === 'D' || party === 'R' ? party : 'O']++;
      grouped[key].n++;
    }
  }
  for (const g of Object.values(grouped)) {
    ev.push({ t: g.t, kind: 'batch', text: `${g.n} uncompetitive race${g.n === 1 ? '' : 's'} projected (${g.D} D, ${g.R} R${g.O ? `, ${g.O} other` : ''}).` });
  }
  for (const [id, p] of Object.entries(sc.races)) {
    const r = store.byId[id];
    if (p.runoff) ev.push({ t: NIGHT_END, kind: 'info', id, text: `${r.title} heads to a Dec. 1 runoff: no candidate cleared 50%.` });
    if (p.recount) ev.push({ t: END, kind: 'info', id, text: `${r.title} is within half a point: ${p.side === 'left' ? r.left : r.right} leads, and a recount is likely.` });
  }
  for (const [id, p] of Object.entries(sc.races)) {
    if (!p.duel || !Number.isFinite(p.duel.callT)) continue;
    const r = store.byId[id];
    const [w, l] = p.duel.margin > 0 ? [r.duel.a, r.duel.b] : [r.duel.b, r.duel.a];
    ev.push({ t: p.duel.callT, kind: 'call', party: r.duel.party, id, text: `${w} defeats ${l} in ${r.title}, a race between two ${PARTY_NAME[r.duel.party]}s.` });
  }
  // Chamber control, replayed from the order of projections.
  const tally = { senate: { ...store.base.chambers.senate.notUp }, house: { D: 0, R: 0 }, gov: Object.values(store.base.chambers.governors.notUp).reduce((a, p) => { a[p] = (a[p] || 0) + 1; return a; }, { D: 0, R: 0 }) };
  const need = { senate: { D: 51, R: 50 }, house: { D: 218, R: 218 }, gov: { D: 26, R: 25 } };
  const done = {};
  const seq = Object.entries(sc.races).filter(([, p]) => Number.isFinite(p.callT)).map(([id, p]) => ({ r: store.byId[id], p }))
    .filter(x => tally[x.r.type]).sort((a, b) => a.p.callT - b.p.callT);
  for (const { r, p } of seq) {
    const party = winnerParty(r, p);
    if (party !== 'D' && party !== 'R') continue;
    tally[r.type][party] = (tally[r.type][party] || 0) + 1;
    for (const side of ['D', 'R']) {
      if (!done[r.type] && tally[r.type][side] >= need[r.type][side] && r.type !== 'gov') {
        done[r.type] = true;
        // Republicans hold both chambers going in.
        const who = side === 'D' ? 'Democrats' : 'Republicans';
        ev.push({ t: p.callT, kind: 'control', party: side, text: `${who} ${side === 'R' ? 'keep' : 'win'} control of the ${NAMES[r.type]}.` });
      }
    }
  }
  const lateStates = [...new Set(Object.entries(sc.races).filter(([, p]) => fracAt(p, NIGHT_END) < 0.85).map(([id]) => store.byId[id].state))];
  if (lateStates.length) ev.push({ t: NIGHT_END, kind: 'info', text: `Counting continues in ${listText(lateStates.map(s => store.stateByCode[s].name).sort())}. Late mail ballots can take days.` });
  const o = sc.outcome || outcome(sc);
  ev.push({ t: END, kind: 'final', text: `Final: Senate ${o.seats.senate.D}–${o.seats.senate.R}${o.seats.senate.I ? `–${o.seats.senate.I}` : ''}, House ${o.seats.house.D}–${o.seats.house.R}, governors ${o.seats.gov.D}–${o.seats.gov.R} (D–R).` });
  const order = { close: 0, batch: 1, call: 2, info: 3, control: 4, final: 5 };
  return ev.sort((a, b) => a.t - b.t || order[a.kind] - order[b.kind]);
}

function listText(xs) {
  if (xs.length <= 1) return xs.join('');
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

// ------------------------------------------------------------------------------------------- playback

let timer = null;
let lastTick = 0;
let lastModel = 0;
let hooks = { recompute: () => {}, onStop: () => {} };

/** live.js registers how to re-run the live model and how to restore real results afterwards. */
export function registerSimHooks(h) { hooks = { ...hooks, ...h }; }

export function simActive() { return !!store.sim; }

export function startNight(sc, { speed = 3, t = START } = {}) {
  stopTimer();
  store.sim = { sc, t, speed, playing: true };
  store.live.demo = true;
  apply(true);
  lastTick = performance.now();
  timer = setInterval(tick, 200);
}

function tick() {
  const s = store.sim;
  if (!s) return stopTimer();
  const now = performance.now();
  const dt = Math.min(1000, now - lastTick) / 1000;
  lastTick = now;
  if (!s.playing) return;
  s.t = Math.min(END, s.t + s.speed * 2 * dt);   // 1x = 2 simulated minutes per second
  if (s.t >= END) s.playing = false;
  apply(false);
}

function apply(force) {
  const s = store.sim;
  store.live.results = resultsAt(s.sc, s.t);
  const stamp = iso(Math.max(0, s.t));
  store.live.resultsAt = { senate: stamp, house: stamp, gov: stamp };
  store.live.resultsOk = true;
  const now = performance.now();
  if (force || now - lastModel > 900 || !s.playing) { lastModel = now; hooks.recompute(); }
  notify('sim');
}

export function setSpeed(x) { if (store.sim) { store.sim.speed = x; notify('sim'); } }
export function togglePlay() {
  const s = store.sim;
  if (!s) return;
  if (s.t >= END) s.t = START;
  s.playing = !s.playing;
  lastTick = performance.now();
  apply(true);
}
export function seek(t) { const s = store.sim; if (!s) return; s.t = Math.max(START, Math.min(END, t)); apply(true); }

export function stopSim() {
  stopTimer();
  store.sim = null;
  store.live.demo = false;
  store.live.results = {};
  store.live.resultsAt = {};
  store.live.resultsOk = null;
  hooks.onStop();
  notify('sim');
}

function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

/** Events that have happened by the current simulated time, newest first. */
export function eventsSoFar() {
  const s = store.sim;
  if (!s) return [];
  return s.sc.events.filter(e => e.t <= s.t).reverse();
}
