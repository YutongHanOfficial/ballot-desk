// Live layer: Polymarket prices every minute, vote counts on election night, and the live projection model.
import { CONFIG, pollCloseDate } from './config.js';
import { store, notify, loadData } from './store.js';
import { liveEstimate, estimateSwing, simulate, samePerson } from './model.js';
import { makeScenario, startNight, registerSimHooks } from './sim.js';

const AT_LARGE = new Set(['AK', 'DE', 'ND', 'SD', 'VT', 'WY']);
const params = new URLSearchParams(location.search);
const timers = [];

export function resultsEnabled() {
  if (params.get('demo') === 'live') return true;
  const flag = params.get('results');
  if (flag === 'off') return false;
  if (CONFIG.results.provider === 'none') return flag === 'on';
  if (flag === 'on') return true;
  const now = Date.now();
  return now >= Date.parse(CONFIG.results.window.start) && now <= Date.parse(CONFIG.results.window.end);
}

export function isDemo() { return params.get('demo') === 'live'; }

export function startLive() {
  stopLive();
  store.live.demo = isDemo();
  if (CONFIG.markets.enabled && !isDemo()) {
    refreshMarkets();
    timers.push(setInterval(() => visible() && refreshMarkets(), CONFIG.markets.refreshSec * 1000));
  }
  registerSimHooks({
    recompute: () => recomputeNow({ sims: 2500 }),
    onStop: () => { recomputeNow(); if (resultsEnabled() && !isDemo()) ['senate', 'gov', 'house'].forEach(refreshResults); },
  });
  if (isDemo()) {
    startNight(makeScenario(), { speed: 3 });
  } else if (resultsEnabled()) {
    for (const office of ['senate', 'gov', 'house']) {
      refreshResults(office);
      timers.push(setInterval(() => visible() && !store.sim && refreshResults(office), CONFIG.results.refreshSec[office] * 1000));
    }
  }
  timers.push(setInterval(async () => {
    if (!visible()) return;
    try { await loadData(); recompute(); notify('data'); } catch (e) { console.warn('data refresh failed', e); }
  }, CONFIG.dataRefreshSec * 1000));
  document.addEventListener('visibilitychange', onVisible);
}

function onVisible() {
  if (!visible()) return;
  if (CONFIG.markets.enabled && !isDemo() && (!store.live.marketsAt || Date.now() - Date.parse(store.live.marketsAt) > 45e3)) refreshMarkets();
}

export function stopLive() { while (timers.length) clearInterval(timers.pop()); document.removeEventListener('visibilitychange', onVisible); }
const visible = () => document.visibilityState !== 'hidden';

// ------------------------------------------------------------------------------------------- markets

async function refreshMarkets() {
  const tokenOwners = new Map();
  const add = (tok, key) => { if (tok) tokenOwners.set(tok, key); };
  for (const [id, m] of Object.entries(store.markets.races || {})) for (const o of m.outcomes) add(o.token, { kind: 'race', id, o });
  for (const [id, m] of Object.entries(store.markets.control || {})) for (const o of m.outcomes) add(o.token, { kind: 'control', id, o });
  const tokens = [...tokenOwners.keys()];
  if (!tokens.length) return;
  const mids = {};
  try {
    for (let i = 0; i < tokens.length; i += 250) {
      const chunk = tokens.slice(i, i + 250);
      const res = await fetch('https://clob.polymarket.com/midpoints', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chunk.map(t => ({ token_id: t }))),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      Object.assign(mids, await res.json());
    }
  } catch (e) {
    console.warn('Polymarket live prices unavailable:', e.message);
    return;
  }
  const raceOut = {}, control = {};
  const group = (src, kind) => {
    for (const [id, m] of Object.entries(src || {})) {
      const outs = m.outcomes.map(o => ({ ...o, p: mids[o.token] !== undefined ? parseFloat(mids[o.token]) : o.p }));
      const tot = outs.reduce((s, o) => s + (o.p || 0), 0) || 1;
      outs.forEach(o => { o.p = o.p / tot; });
      if (kind === 'race') {
        const race = store.byId[id];
        if (!race) continue;
        const left = outs.find(o => (o.name && samePerson(o.name, race.left)) || (!o.name && o.party === race.leftParty));
        const right = outs.find(o => o !== left && ((o.name && samePerson(o.name, race.right)) || (!o.name && o.party === race.rightParty)));
        raceOut[id] = { pLeft: left ? left.p : right ? 1 - right.p : null, outcomes: outs.sort((a, b) => b.p - a.p) };
      } else {
        control[id] = { pD: outs.find(o => o.party === 'D')?.p ?? null, pR: outs.find(o => o.party === 'R')?.p ?? null };
      }
    }
  };
  group(store.markets.races, 'race');
  group(store.markets.control, 'control');
  store.live.markets = raceOut;
  store.live.control = control;
  store.live.marketsAt = new Date().toISOString();
  notify('markets');
}

// ------------------------------------------------------------------------------------------- results

function nytRaceId(nytId) {
  // 'PA-G-S-2026-11-03', 'OH-S_W-S-2026-11-03' (special), 'PA-G-H-7-2026-11-03', 'PA-G-G-2026-11-03'
  const m = nytId.match(/^([A-Z]{2})-[A-Z_]+-([SHG])(?:-(\d+))?-2026/);
  if (!m) return null;
  const [, st, off, d] = m;
  if (off === 'S') return `${st}-SEN`;
  if (off === 'G') return `${st}-GOV`;
  const n = parseInt(d || '0', 10);
  return AT_LARGE.has(st) || n === 0 ? `${st}-AL` : `${st}-${String(n).padStart(2, '0')}`;
}

function normalizeNyt(race, nr) {
  const tru = nr.top_reporting_unit || {};
  const meta = nr.candidate_metadata || {};
  const cands = (tru.candidates || []).map(c => {
    const m = meta[c.nyt_id] || {};
    const name = [m.first_name, m.last_name].filter(Boolean).join(' ');
    const pid = m.party?.nyt_id;
    const party = pid === 'DEM' ? 'D' : pid === 'GOP' || pid === 'REP' ? 'R' : pid === 'IND' ? 'I' : pid === 'LIB' ? 'L' : pid === 'GRN' ? 'G' : 'O';
    return { id: c.nyt_id, name, party, votes: c.votes?.total || 0, incumbent: !!m.incumbent };
  });
  const total = tru.total_votes || cands.reduce((s, c) => s + c.votes, 0);
  const won = new Set((nr.outcome?.won || []).map(String));
  cands.forEach(c => { c.pct = total ? c.votes / total : 0; c.winner = won.has(c.id); });
  cands.sort((a, b) => b.votes - a.votes || (a.name > b.name ? 1 : -1));
  const findSide = (name, party) => {
    const exact = cands.find(c => c.name.toLowerCase() === String(name || '').toLowerCase());
    if (exact) return exact;
    const hits = cands.filter(c => samePerson(c.name, name));
    if (hits.length > 1) return hits.find(c => c.incumbent) || hits[0];
    return hits[0] || cands.find(c => c.party === party && cands.filter(x => x.party === party).length === 1);
  };
  const L = findSide(race.left, race.leftParty), R = findSide(race.right, race.rightParty);
  let called = null;
  if (won.size) called = L && won.has(L.id) ? 'left' : R && won.has(R.id) ? 'right' : 'other';
  const runoff = (nr.outcome?.advanced_to_runoff || []).length > 0;
  return {
    eevp: tru.eevp || 0, total, cands, left: L ? L.votes : 0, right: R ? R.votes : 0, called, runoff,
    status: nr.race_call_status, updated: tru.provider_updated_at || nr.updated_at, precincts: [tru.precincts_reporting, tru.precincts_total],
    calledAt: (nr.outcome?.winner_accepted_at || [])[0] || null,
  };
}

async function refreshResults(office) {
  try {
    const res = await fetch(`${CONFIG.results.urls[office]}?t=${Math.floor(Date.now() / 15000)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (store.sim) return;   // a simulation owns the results while it runs
    for (const nr of data.races || []) {
      const id = nytRaceId(nr.nyt_id);
      const race = id && store.byId[id];
      if (!race) continue;
      store.live.results[id] = normalizeNyt(race, nr);
    }
    store.live.resultsAt[office] = new Date().toISOString();
    store.live.resultsOk = true;
  } catch (e) {
    console.warn(`results feed (${office}) unavailable:`, e.message);
    store.live.resultsOk = store.live.resultsOk === true ? true : false;
    return;
  }
  recompute();
  notify('results');
}

// ------------------------------------------------------------------------------------------- live model

let recomputeTimer = null;
export function recompute() {
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(recomputeNow, 50);
}

export function recomputeNow({ sims = CONFIG.liveSims } = {}) {
  const results = store.live.results;
  const anyVotes = Object.values(results).some(r => r.total > 0 || r.called);
  store.live.active = anyVotes;
  if (!anyVotes) { store.live.est = null; store.live.sim = null; store.live.swing = null; return; }
  const simRaces = store.races.filter(r => r.type === 'senate' || r.type === 'house' || r.type === 'gov');
  const pairs = simRaces.map(r => ({ r, est: { mu: r.mu, sd: r.sd, pLeft: r.p, settled: r.settled }, live: results[r.id] }));
  const sw = estimateSwing(pairs.map(x => ({ est: x.est, live: x.live })));
  const est = {};
  for (const x of pairs) est[x.r.id] = liveEstimate(x.est, x.live, sw.swing, sw.sd);
  const sim = simulate(simRaces, est, store.base.chambers, { sims, natSd: sw.sd, natMu: 0, tipping: false, seed: 7 });
  for (const r of simRaces) if (est[r.id] && !est[r.id].settled && !est[r.id].called) est[r.id].pLeft = sim.raceProb[r.id];
  store.live.est = est;
  store.live.sim = sim;
  store.live.swing = sw;
  notify('model');
}

/** Seats already called (AP calls via the feed) per party, including seats not up. */
export function calledSeats(type) {
  const base = type === 'senate' ? { ...store.base.chambers.senate.notUp } : type === 'gov'
    ? Object.values(store.base.chambers.governors.notUp).reduce((a, p) => { a[p] = (a[p] || 0) + 1; return a; }, {}) : {};
  const out = { D: base.D || 0, R: base.R || 0, O: 0 };
  for (const r of store.races) {
    if (r.type !== type) continue;
    const res = store.live.results[r.id];
    let party = null;
    // Uncontested seats count once their polls have closed (simulations call them at poll close).
    if (r.settled && (store.sim ? res && res.called : Date.now() >= (pollCloseDate(r.state) || 0))) party = r.left ? r.leftParty : r.rightParty;
    if (res && res.called === 'left') party = r.leftParty;
    else if (res && res.called === 'right') party = r.rightParty;
    else if (res && res.called === 'other') party = 'O';
    if (!party) continue;
    if (party === 'D' || party === 'R') out[party]++; else out.O++;
  }
  return out;
}
