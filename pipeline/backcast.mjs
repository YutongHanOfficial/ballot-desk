#!/usr/bin/env node
// Reconstruct the forecast's topline for the days before it first ran. The same model (assets/js/model.js)
// is re-run once a day on the inputs as they stood that day, never on anything published later:
//   ratings, generic ballot  Wikipedia as of each date (weekly snapshots from pipeline/backcast_inputs.py)
//   polls                    VoteHub polls logged (created_at) by the end of that day
//   markets                  each race market's Polymarket price at the end of that day (CLOB price history)
// Each day is taken as of its end (23:59 UTC), so it holds every poll logged that day and nothing later.
// Taken from hindsight: the race list itself (today's nominees and main contenders), and each market's
// total volume, which sets how much weight its price gets.
// Writes data/backcast.json, which the history chart draws before the live line, up to "Forecast went live".
// Usage: python3 pipeline/backcast_inputs.py && node pipeline/backcast.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateRace, simulate, pollAverage, labelAverage, samePerson, MODEL } from '../assets/js/model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(ROOT, 'pipeline', '.cache', 'backcast');
const UA = 'BallotDesk/1.0 (https://ballotdesk.org; https://github.com/YutongHanOfficial/ballot-desk)';
const DAY = 864e5;
// Simulations per re-run day. The forecast's own MODEL.sims (a million) would take well over an hour for ~150 days,
// and the chart this feeds reads to the whole point. SIMS=1000000 node pipeline/backcast.mjs for the full count.
const SIMS = Number(process.env.SIMS) || 100000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const read = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));

async function getJSON(url, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

// Mirrors of refresh.mjs's helpers (kept out of the live pipeline's file on purpose).
const AT_LARGE = new Set(['AK', 'DE', 'ND', 'SD', 'VT', 'WY']);
function pollRaceId(p, byName) {
  const subj = String(p.subject || '').trim();
  const m = subj.match(/^2026\s+(.+)$/);
  switch (p.poll_type) {
    case 'us-senator': return m && byName[m[1]] ? `${byName[m[1]]}-SEN` : null;
    case 'governor': return m && byName[m[1]] ? `${byName[m[1]]}-GOV` : null;
    case 'attorney-general': return m && byName[m[1]] ? `${byName[m[1]]}-AG` : null;
    case 'us-representative': {
      const s = String(p.seat_name || subj.replace(/^2026\s+/, '')).match(/^([A-Z]{2})-(\d+)$/);
      if (!s) return null;
      const d = parseInt(s[2], 10);
      return AT_LARGE.has(s[1]) || d === 0 ? `${s[1]}-AL` : `${s[1]}-${String(d).padStart(2, '0')}`;
    }
    default: return null;
  }
}
function sideProbs(race, outs) {
  let left = null, right = null;
  for (const o of outs) {
    const nameHit = (n) => o.name && n && samePerson(o.name, n);
    if (left === null && (nameHit(race.left) || (!o.name && o.party && o.party === race.leftParty))) { left = o; continue; }
    if (right === null && (nameHit(race.right) || (!o.name && o.party && o.party === race.rightParty))) { right = o; continue; }
  }
  if (!left) left = outs.find(o => o !== right && o.party && o.party === race.leftParty && outs.filter(x => x.party === race.leftParty).length === 1) || null;
  if (!right) right = outs.find(o => o !== left && o.party && o.party === race.rightParty && outs.filter(x => x.party === race.rightParty).length === 1) || null;
  return { left, right };
}

/** One outcome token's price history at a given resolution (minutes), cached: [[ms, price], ...] oldest first. */
async function fetchHistory(token, fidelity) {
  const file = path.join(CACHE, 'prices', fidelity === 1440 ? `${token}.json` : `${token}-${fidelity}.json`);
  try { return await read(file); } catch { /* not cached yet */ }
  const ph = await getJSON(`https://clob.polymarket.com/prices-history?market=${token}&interval=max&fidelity=${fidelity}`);
  const out = (ph.history || []).map(x => [x.t * 1000, x.p]).sort((a, b) => a[0] - b[0]);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(out));
  await new Promise(r => setTimeout(r, 150));
  return out;
}
/** The CLOB serves 6-hourly history only for the last few weeks: daily points before that, 6-hourly after. */
async function priceHistory(token) {
  const daily = await fetchHistory(token, 1440), fine = await fetchHistory(token, 360);
  const cut = fine.length ? fine[0][0] : Infinity;
  return daily.filter(([t]) => t < cut).concat(fine);
}
const priceAt = (hist, t) => { let p = null; for (const [ts, v] of hist) { if (ts > t) break; p = v; } return p; };

async function main() {
  const base = await read(path.join(DATA, 'races.json'));
  const forecast = await read(path.join(DATA, 'forecast.json'));
  const markets = await read(path.join(DATA, 'markets.json'));
  const history = await read(path.join(DATA, 'history.json'));
  const byName = Object.fromEntries(base.states.map(s => [s.name, s.code]));
  const region = Object.fromEntries(base.states.map(s => [s.code, s.region]));
  // Today's race list and main contenders, as the live forecast has them.
  const races = base.races.map(r => {
    const f = forecast.races[r.id] || {};
    return { ...r, region: region[r.state], left: f.left ?? r.left, right: f.right ?? r.right, leftParty: f.leftParty ?? r.leftParty, rightParty: f.rightParty ?? r.rightParty };
  });

  log('fetching VoteHub polls');
  const polls = await getJSON('https://api.votehub.com/polls');
  const pollsByRace = {}, generic = [];
  for (const p of polls) {
    if (p.poll_type === 'generic-ballot' && String(p.subject).startsWith('2026')) { generic.push(p); continue; }
    const id = pollRaceId(p, byName);
    if (id) (pollsByRace[id] ||= []).push(p);
  }
  // A poll counts once VoteHub has logged it (created_at is a date: from the start of that day).
  const known = (ps, t, days) => ps.filter(p => p.created_at && Date.parse(`${p.created_at}T00:00:00Z`) <= t
    && (t - Date.parse(`${p.end_date}T12:00:00Z`)) / DAY <= days);

  // Race markets the model would weigh (it ignores those under $2,000 traded): the left side's price each day.
  const mkt = {};
  const wanted = races.filter(r => markets.races[r.id] && (markets.races[r.id].volume || 0) > 2000 && r.left && r.right);
  log(`price history for ${wanted.length} race markets`);
  for (const r of wanted) {
    const m = markets.races[r.id];
    const { left, right } = sideProbs(r, m.outcomes);
    const side = left?.token ? { token: left.token, flip: false } : right?.token ? { token: right.token, flip: true } : null;
    if (!side) continue;
    try { mkt[r.id] = { ...side, hist: await priceHistory(side.token), volume: m.volume }; } catch (e) { log('no history for', r.id, e.message); }
  }

  // Coverage: how many of these markets had a price on a few dates (a gap here would silently drop the market signal).
  const cover = ['2026-06-06', '2026-08-01', '2026-10-01', '2026-11-01'].map(d => {
    const t = Date.parse(`${d}T23:59:59Z`);
    return `${d} ${Object.values(mkt).filter(m => priceAt(m.hist, t) !== null).length}`;
  });
  log(`markets with a price: ${cover.join(', ')} (of ${Object.keys(mkt).length})`);

  let snapshots;
  try { ({ snapshots } = await read(path.join(CACHE, 'snapshots.json'))); } catch {
    log('no ratings snapshots yet: run python3 pipeline/backcast_inputs.py first (prices are cached now)');
    return;
  }

  // A week whose page the parser could not read keeps the week before's ratings rather than dropping them all.
  for (let i = 1; i < snapshots.length; i++) {
    const s = snapshots[i], prev = snapshots[i - 1];
    if ((s.errors || []).some(e => /^(senate|house):/.test(e))) { s.ratings = { ...prev.ratings, ...s.ratings }; log(`snapshot ${s.at}: ${s.errors.join('; ')} (kept the week before's ratings)`); }
    if (!(s.generic || []).length) s.generic = prev.generic;
  }

  // National environment the way refresh.mjs sets it: the aggregators' average, else VoteHub's own.
  const envFor = (t, snap) => {
    const aggs = (snap.generic || []).filter(a => !/average/i.test(a.source));
    if (aggs.length >= 2) return { generic: aggs.reduce((a, b) => a + b.margin, 0) / aggs.length, genericSource: `average of ${aggs.length} polling aggregates` };
    const g = labelAverage(known(generic, t, 120), 'Dem', 'Rep', t);
    return g ? { generic: g.margin, genericSource: 'VoteHub poll average' } : { generic: 5, genericSource: 'default' };
  };
  const run = (t, snap) => {
    const env = envFor(t, snap);
    const ests = {};
    const asOf = races.map(r => (r.type === 'senate' || r.type === 'house') ? { ...r, ratings: snap.ratings[r.id] || {} } : r);
    for (const r of asOf) {
      const avg = r.left && r.right ? pollAverage(known(pollsByRace[r.id] || [], t, 150), r.left, r.right, t) : null;
      const poll = avg ? { margin: avg.margin, neff: avg.neff, n: avg.n } : null;
      const m = mkt[r.id];
      const p = m ? priceAt(m.hist, t) : null;
      const market = p === null ? null : { pLeft: m.flip ? 1 - p : p, volume: m.volume };
      ests[r.id] = estimateRace(r, { poll, market }, env);
    }
    const sim = simulate(asOf, ests, base.chambers, { sims: SIMS });
    return { sen: round(sim.senate.pD, 4), house: round(sim.house.pD, 4), senSeats: round(sim.senate.dSeats.mean, 2), houseSeats: round(sim.house.dSeats.mean, 2), generic: round(env.generic, 2) };
  };
  const snapFor = (t) => snapshots.filter(s => Date.parse(s.at) <= t).pop() || snapshots[0];

  // Check the method against the model's own early runs before trusting it for the months before: the first
  // live run that read the same Wikipedia data (the very first one used a race list built hours earlier).
  const t1 = Date.parse(history.points[0].t);
  const firstSnap = snapFor(t1 + 6 * 3600e3);
  const snapGeneric = round(envFor(t1, firstSnap).generic, 2);
  const first = history.points.find(p => Date.parse(p.t) >= Date.parse(firstSnap.at) && Math.abs((p.generic ?? 99) - snapGeneric) < 0.05) || history.points[0];
  const check = run(Date.parse(first.t), snapFor(Date.parse(first.t)));
  log(`check at ${first.t}: reconstructed Senate ${(check.sen * 100).toFixed(1)}% / House ${(check.house * 100).toFixed(1)}%, the live run said ${(first.sen * 100).toFixed(1)}% / ${(first.house * 100).toFixed(1)}%`);

  const points = [];
  const start = Date.parse(`${snapshots[0].at.slice(0, 10)}T23:59:59Z`);
  for (let t = start; t < t1; t += DAY) {
    points.push({ t: new Date(t).toISOString(), ...run(t, snapFor(t)) });
    if (points.length % 30 === 0) log(`${points.at(-1).t.slice(0, 10)}: Senate ${(points.at(-1).sen * 100).toFixed(0)}%, House ${(points.at(-1).house * 100).toFixed(0)}%`);
  }
  const out = {
    generated: new Date().toISOString(), model: MODEL.version,
    method: 'The forecast model re-run once a day on the ratings, polls, generic ballot and Polymarket prices published by that day. Uses this fall’s nominees throughout.',
    check: { t: first.t, sen: check.sen, house: check.house, liveSen: first.sen, liveHouse: first.house },
    points,
  };
  await fs.writeFile(path.join(DATA, 'backcast.json'), JSON.stringify(out));
  log(`wrote data/backcast.json: ${points.length} days, ${points[0].t.slice(0, 10)} to ${points.at(-1).t.slice(0, 10)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
