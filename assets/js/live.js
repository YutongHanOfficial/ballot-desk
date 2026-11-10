// Live layer: Polymarket prices every minute, vote counts on election night, and the live projection model.
import { CONFIG, pollCloseDate } from './config.js';
import { store, notify, loadData, seatCount, racesOf } from './store.js';
import { liveEstimate, estimateSwing, simulate, samePerson, normName } from './model.js';
import { makeScenario, startNight, registerSimHooks, ensureSimData } from './sim.js';

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

/** From late afternoon on Election Day until the counting is done, the live dashboard is the front page. */
export const liveFrontPage = () => resultsEnabled();

// How long after the page opens a slow results feed can hold the placeholders before the page gives up on it.
const LOADING_MAX_MS = 12000;
const OFFICE = { senate: 'senate', gov: 'gov', house: 'house' };

/**
 * True from the moment the page opens until the results files have each answered once (or 12 seconds have passed):
 * the live views draw placeholder shapes instead of the pre-results screen, whose forecast numbers and "waiting
 * for results" text would otherwise flash up first. With a race type, only that office's file counts.
 */
export function resultsLoading(type) {
  if (!resultsEnabled() || isDemo() || store.sim || performance.now() > LOADING_MAX_MS) return false;
  const offices = type ? [OFFICE[type]].filter(Boolean) : Object.values(OFFICE);
  return offices.some(o => !store.live.resultsTried[o]);
}

export function startLive() {
  stopLive();
  store.live.demo = isDemo();
  if (CONFIG.markets.enabled && !isDemo()) {
    refreshMarkets();
    const sec = resultsEnabled() ? CONFIG.markets.nightRefreshSec : CONFIG.markets.refreshSec;
    timers.push(setInterval(() => visible() && refreshMarkets(), sec * 1000));
  }
  registerSimHooks({
    recompute: () => recomputeNow({ sims: 2500 }),
    onStop: () => { recomputeNow(); if (resultsEnabled() && !isDemo()) ['senate', 'gov', 'house'].forEach(refreshResults); },
  });
  if (isDemo()) {
    // ?speed=10 plays a rehearsal faster (1x = 2 simulated minutes per second)
    ensureSimData().then(() => startNight(makeScenario(), { speed: Math.min(60, Math.max(1, +params.get('speed') || 3)) }));
  } else if (resultsEnabled()) {
    // If a file never answers, the placeholders give way at the deadline (nothing else would redraw the page).
    if (resultsLoading()) timers.push(setTimeout(() => notify('results'), LOADING_MAX_MS - performance.now() + 50));
    for (const office of ['senate', 'gov', 'house']) {
      refreshResults(office);
      timers.push(setInterval(() => visible() && !store.sim && refreshResults(office), CONFIG.results.refreshSec[office] * 1000));
    }
  }
  timers.push(setInterval(checkData, CONFIG.dataCheckSec * 1000));
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', onVisible);
  window.addEventListener('online', onVisible);
}

// Browsers skip or pause timers while a page is hidden (another tab, or another app's window over it), so
// catch up the moment it is back in view.
function onVisible() {
  if (!visible()) return;
  if (CONFIG.markets.enabled && !isDemo() && (!store.live.marketsAt || Date.now() - Date.parse(store.live.marketsAt) > 45e3)) refreshMarkets();
  checkData();
}

export function stopLive() {
  while (timers.length) clearInterval(timers.pop());
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('pageshow', onVisible);
  window.removeEventListener('online', onVisible);
}
const visible = () => document.visibilityState !== 'hidden';

// ------------------------------------------------------------------------------------------- data files

let checking = false, lastCheck = 0;

/** Reload the data files when a newer deploy is live: its forecast.json has a new Last-Modified date. */
async function checkData() {
  if (checking || !visible() || Date.now() - lastCheck < 15e3) return;
  checking = true;
  lastCheck = Date.now();
  try {
    let stamp = null;
    try {
      const res = await fetch(`/data/forecast.json?v=${Math.floor(Date.now() / 60000)}`, { method: 'HEAD', cache: 'no-store' });
      if (res.ok) stamp = res.headers.get('last-modified');
    } catch { /* offline or blocked: fall back to the data's age */ }
    const stale = stamp && store.dataStamp ? stamp !== store.dataStamp
      : Date.now() - Date.parse(store.loadedAt) > CONFIG.dataRefreshSec * 1000;
    if (stale) { await loadData(); recompute(); notify('data'); }
  } catch (e) {
    console.warn('data refresh failed', e);
  } finally {
    checking = false;
  }
}

// ------------------------------------------------------------------------------------------- markets

// The last trade of each outcome whose order book is gone. Polymarket stops trading a market when it resolves, so
// these never change: each is looked up once.
const lastTrade = new Map();

async function postTokens(url, tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 250) {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tokens.slice(i, i + 250).map(t => ({ token_id: t }))),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    out.push(await res.json());
  }
  return out;
}

/**
 * Settle a market some of whose outcomes have stopped trading (each carries `last`, its last trade). The outcome that
 * last traded near 1 won, and every other one is then worth 0, whatever its own book still says (an empty book reads
 * 0.5). With every book closed, the highest last trade won. Otherwise the closed outcomes lost and the rest still
 * trade. Returns true when the market is settled.
 */
function settle(outs) {
  const shut = outs.filter(o => o.last !== undefined);
  if (!shut.length) return false;
  const top = shut.reduce((a, b) => (b.last > a.last ? b : a));
  const all = outs.every(o => o.last !== undefined || !o.token);
  if (top.last >= 0.9 || (all && top.last >= 0.5)) {
    for (const o of outs) o.p = o === top ? 1 : 0;
    return true;
  }
  if (!all) for (const o of shut) o.p = 0;
  return false;   // every book closed and none near 1: keep the last prices we published
}

async function refreshMarkets() {
  const tokenOwners = new Map();
  const add = (tok, key) => { if (tok) tokenOwners.set(tok, key); };
  for (const [id, m] of Object.entries(store.markets.races || {})) for (const o of m.outcomes) add(o.token, { kind: 'race', id, o });
  for (const [id, m] of Object.entries(store.markets.control || {})) for (const o of m.outcomes) add(o.token, { kind: 'control', id, o });
  const tokens = [...tokenOwners.keys()];
  if (!tokens.length) return;
  const mids = {};
  try {
    for (const part of await postTokens('https://clob.polymarket.com/midpoints', tokens)) Object.assign(mids, part);
  } catch (e) {
    console.warn('Polymarket live prices unavailable:', e.message);
    return;
  }
  // No midpoint means no order book: the market has closed (resolved, by election night). Its last trade says how.
  const gone = tokens.filter(t => mids[t] === undefined && !lastTrade.has(t));
  if (gone.length) {
    try {
      for (const part of await postTokens('https://clob.polymarket.com/last-trades-prices', gone)) {
        for (const x of Array.isArray(part) ? part : []) if (x?.token_id && x.price !== undefined && !Number.isNaN(parseFloat(x.price))) lastTrade.set(x.token_id, parseFloat(x.price));
      }
      for (const t of gone) if (!lastTrade.has(t)) lastTrade.set(t, null);   // never traded: don't ask again
    } catch (e) {
      console.warn('Polymarket closing prices unavailable:', e.message);
    }
  }
  const raceOut = {}, control = {};
  const group = (src, kind) => {
    for (const [id, m] of Object.entries(src || {})) {
      // Live midpoint where the book is open; for a closed one, its last trade (settle() decides what it means).
      // Neither: the price in markets.json.
      const outs = m.outcomes.map(o => mids[o.token] !== undefined ? { ...o, p: parseFloat(mids[o.token]) }
        : lastTrade.get(o.token) != null ? { ...o, last: lastTrade.get(o.token) } : { ...o });
      const closed = settle(outs);
      const tot = outs.reduce((s, o) => s + (o.p || 0), 0) || 1;
      outs.forEach(o => { o.p = (o.p || 0) / tot; delete o.last; });
      if (kind === 'race') {
        const race = store.byId[id];
        if (!race) continue;
        const left = outs.find(o => (o.name && samePerson(o.name, race.left)) || (!o.name && o.party === race.leftParty));
        const right = outs.find(o => o !== left && ((o.name && samePerson(o.name, race.right)) || (!o.name && o.party === race.rightParty)));
        raceOut[id] = { pLeft: left ? left.p : right ? 1 - right.p : null, outcomes: outs.sort((a, b) => b.p - a.p), closed };
      } else {
        control[id] = { pD: outs.find(o => o.party === 'D')?.p ?? null, pR: outs.find(o => o.party === 'R')?.p ?? null, closed };
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

/** Our two main candidates in an NYT race: { cands, L, R }, matched by name, then by unique party. */
function nytSides(race, nr) {
  const meta = nr.candidate_metadata || {};
  const cands = Object.values(meta).map(m => {
    const pid = m.party?.nyt_id;
    const party = pid === 'DEM' ? 'D' : pid === 'GOP' || pid === 'REP' ? 'R' : pid === 'IND' ? 'I' : pid === 'LIB' ? 'L' : pid === 'GRN' ? 'G' : 'O';
    return { id: m.nyt_id, name: [m.first_name, m.last_name].filter(Boolean).join(' '), party, incumbent: !!m.incumbent };
  });
  const findSide = (name, party) => {
    const exact = cands.find(c => c.name.toLowerCase() === String(name || '').toLowerCase());
    if (exact) return exact;
    const hits = cands.filter(c => samePerson(c.name, name));
    if (hits.length > 1) return hits.find(c => c.incumbent) || hits[0];
    if (hits[0]) return hits[0];
    // A name the matcher can't pair: the party's one candidate with that surname, else its only one, not
    // counting write-ins (Maine's governor race has a Republican write-in beside Bobby Charles).
    const ofParty = cands.filter(c => c.party === party && !/write-?in/i.test(c.name));
    const surname = (n) => normName(n).split(' ').filter(Boolean).pop();
    const sur = ofParty.filter(c => surname(c.name) === surname(name));
    return sur.length === 1 ? sur[0] : ofParty.length === 1 ? ofParty[0] : undefined;
  };
  return { cands, L: findSide(race.left, race.leftParty), R: findSide(race.right, race.rightParty) };
}

function normalizeNyt(race, nr) {
  const tru = nr.top_reporting_unit || {};
  const { cands: meta, L: Lm, R: Rm } = nytSides(race, nr);
  const byId = Object.fromEntries(meta.map(c => [c.id, c]));
  const cands = (tru.candidates || []).map(c => ({ ...(byId[c.nyt_id] || { id: c.nyt_id, name: c.nyt_id, party: 'O' }), id: c.nyt_id, votes: c.votes?.total || 0 }));
  const total = tru.total_votes || cands.reduce((s, c) => s + c.votes, 0);
  const won = new Set((nr.outcome?.won || []).map(String));
  cands.forEach(c => { c.pct = total ? c.votes / total : 0; c.winner = won.has(c.id); });
  cands.sort((a, b) => b.votes - a.votes || (a.name > b.name ? 1 : -1));
  const L = Lm && cands.find(c => c.id === Lm.id), R = Rm && cands.find(c => c.id === Rm.id);
  let called = null;
  // In a same-party race the seat goes to that party whoever wins; who won is kept in `duel`.
  if (won.size) called = race.samePartyGeneral ? (race.left ? 'left' : 'right') : L && won.has(L.id) ? 'left' : R && won.has(R.id) ? 'right' : 'other';
  let duel = null;
  if (race.duel) {
    const find = (name) => cands.find(c => c.name.toLowerCase() === name.toLowerCase()) || cands.find(c => samePerson(c.name, name));
    const A = find(race.duel.a), B = find(race.duel.b);
    if (A || B) duel = { a: A ? A.votes : 0, b: B ? B.votes : 0, total, eevp: tru.eevp || 0, won: A && won.has(A.id) ? 'a' : B && won.has(B.id) ? 'b' : null };
  }
  const runoff = (nr.outcome?.advanced_to_runoff || []).length > 0;
  // How the race is won: most votes, a majority (Georgia and Louisiana hold runoffs; Vermont's legislature decides),
  // or ranked choices (Alaska, Maine).
  const rule = nr.tabulation_method === 'ranked-choice' ? 'rcv' : nr.win_threshold >= 50 ? 'majority' : 'plurality';
  // Louisiana's House races are all-party primaries ('Nonpartisan Election'), with several candidates of each party
  // and the top two going to a runoff: each party's combined vote says more about the seat than the leaders' shares.
  const allParty = nr.race_type_id === 'L' || /nonpartisan/i.test(nr.type || '');
  const byParty = {};
  for (const c of cands) byParty[c.party] = (byParty[c.party] || 0) + c.votes;
  return {
    eevp: tru.eevp || 0, total, cands, left: L ? L.votes : 0, right: R ? R.votes : 0, called, runoff, duel,
    expected: tru.total_expected_vote || 0, rule, runoffs: !!nr.max_runoff,   // expected: AP's estimate of the total vote
    allParty, byParty: allParty ? byParty : null,
    status: nr.race_call_status, updated: tru.provider_updated_at || nr.updated_at, precincts: [tru.precincts_reporting, tru.precincts_total],
    calledAt: (nr.outcome?.winner_accepted_at || [])[0] || null,
    slug: String(nr.url || '').split('/').pop().replace(/\.html$/, '') || null,
  };
}

// The House file also carries AP's national popular-vote tally ('US-G-H-…'), with candidates named by party.
function nationalVote(nr) {
  const tru = nr.top_reporting_unit || {};
  const v = Object.fromEntries((tru.candidates || []).map(c => [c.nyt_id, c.votes?.total || 0]));
  const D = v.democrat || 0, R = v.republican || 0, O = v.other || 0;
  return { D, R, O, total: tru.total_votes || D + R + O, eevp: tru.eevp || 0 };
}

/** National House vote so far: AP's tally on the real night, the sum of the districts in a simulation. */
export function houseVote() {
  if (!store.sim && store.live.houseVote?.total) return store.live.houseVote;
  let D = 0, R = 0, O = 0, eevp = 0, n = 0;
  for (const r of store.races) {
    if (r.type !== 'house') continue;
    n++;
    const res = store.live.results[r.id];
    if (!res) continue;
    eevp += res.eevp || 0;
    for (const c of res.cands || []) { if (c.party === 'D') D += c.votes; else if (c.party === 'R') R += c.votes; else O += c.votes; }
  }
  const total = D + R + O;
  return total ? { D, R, O, total, eevp: n ? eevp / n : 0 } : null;
}

// ------------------------------------------------------------------------------------------- county results

// County-level results live in each race's own NYT file. They are fetched only for races someone is looking
// at (a race page, the election-night battleground maps), at most every 90 seconds.
const countyWanted = new Map();   // race id -> { seen: last time a view asked, fetched: last fetch, wait: backoff }
let countyTimer = null;

// New England's town table (ne-towns.js, built by pipeline/build_geo.mjs), loaded the first time a race reported by
// town is read, plus Connecticut's towns -> planning region. A browser remembers a module that failed to load (a
// GitHub Pages 503 during a deploy, a dropped connection) and fails every later import of that address without
// asking the server again, so a retry asks for a new one.
let neTowns = null, neTries = 0;
const loadNeTowns = () => (neTowns ||= import(neTries ? `./ne-towns.js?retry=${neTries}` : './ne-towns.js').then(m => ({ ...m,
  CT_TOWN: Object.fromEntries(Object.entries(m.CT_REGIONS).flatMap(([region, towns]) => towns.split(' ').map(t => [t, region]))),
})).catch(e => { neTowns = null; neTries++; throw e; }));

/**
 * The map areas a reporting unit's votes go to, { county, town }, or null to skip it. Most states report by county.
 * New England reports by town (byTown): each town goes on the town map and into its county (Connecticut's into the
 * planning regions its county map shows). Wards and other parts of towns are skipped, as their town already counts
 * them, and so are Maine's unorganized townships, which the feed also counts in their unorganized territory. Alaska
 * reports by state House district, and its map shows those (ids 02H01 to 02H40, as built by pipeline/build_geo.mjs).
 */
function unitAreas(u, byTown, NE) {
  if (byTown) {
    if (u.level !== 'township' || !u.fips_county) return null;
    const st = u.fips_state, ex = NE.TOWNS[st];
    const code = ex && u.fips_suffix in ex ? ex[u.fips_suffix] : NE.SAME_CODES.includes(st) ? u.fips_suffix : null;
    if (!code) return null;
    return { town: `${st}${code}`, county: st === '09' ? NE.CT_TOWN[code] || null : `${st}${u.fips_county}` };
  }
  if (u.level === 'county' && u.fips_county) return { county: `${u.fips_state}${u.fips_county}` };
  if (u.level === 'state_house_district' && u.fips_state === '02' && u.fips_suffix) return { county: `02H${String(parseInt(u.fips_suffix, 10)).padStart(2, '0')}` };
  return null;
}

/** A unit's 2024 presidential vote, from the comparison the feed carries: [total, Harris, Trump], or null. */
function unit2024(u) {
  const h = Object.entries(u.historical_comparison_race_data || {}).find(([k]) => /-G-P-2024-11-05$/.test(k))?.[1];
  return h && h.votes > 0 ? [h.votes, (h.votes * (h.pct_dem || 0)) / 100, (h.votes * (h.pct_rep || 0)) / 100] : null;
}

/**
 * A race's map results from its NYT file. counties: { area: [share counted, left votes, right votes, all votes,
 * expected, all precincts in] }; for races reported by town, also towns (the same, by town) and towns2024 (each
 * town's 2024 presidential vote, [total, Harris, Trump], for the shift view). NE is the town table, loaded for those
 * races. "All precincts in" lets the maps tell an area that reported no votes (some of Maine's unorganized
 * territories, whose few voters vote elsewhere) from one that hasn't reported yet.
 */
function countyEntries(nr, L, R, NE) {
  const units = nr.reporting_units || [];
  const byTown = !units.some(u => u.level === 'county') && units.some(u => u.level === 'township');
  const sums = { county: {}, town: {} };   // area -> [counted share × weight, weight, left, right, votes, expected, precincts in, precincts]
  const base = {};
  const add24 = (town, v) => { if (!v) return; const b = base[town] ||= [0, 0, 0]; b[0] += v[0]; b[1] += v[1]; b[2] += v[2]; };
  for (const u of units) {
    const areas = unitAreas(u, byTown, NE);
    if (!areas) {
      // A skipped Maine township that is its territory's only polling place hands its 2024 vote to the territory.
      const into = byTown && u.level === 'township' && NE.TOWN_2024_INTO[u.fips_state]?.[u.fips_suffix];
      if (into) add24(`${u.fips_state}${into}`, unit2024(u));
      continue;
    }
    const votes = (cid) => (u.candidates || []).find(c => c.nyt_id === cid)?.votes?.total || 0;
    const tot = u.total_votes || 0, exp = u.total_expected_vote || 0, w = exp || tot;
    for (const level of ['county', 'town']) {
      const key = areas[level];
      if (!key) continue;
      const a = sums[level][key] ||= [0, 0, 0, 0, 0, 0, 0, 0];
      a[0] += ((u.eevp || 0) / 100) * w; a[1] += w;
      a[2] += L ? votes(L.id) : 0; a[3] += R ? votes(R.id) : 0;
      a[4] += tot; a[5] += exp;
      a[6] += u.precincts_reporting || 0; a[7] += u.precincts_total || 0;
    }
    if (areas.town) add24(areas.town, unit2024(u));
  }
  // The share counted is the AP's per unit (eevp), weighted by expected vote where an area is made of several units.
  const done = (sum) => Object.fromEntries(Object.entries(sum).map(([k, a]) => [k, [a[1] ? a[0] / a[1] : 0, a[2], a[3], a[4], a[5], a[7] > 0 && a[6] >= a[7]]]));
  return {
    counties: done(sums.county),
    towns: byTown ? done(sums.town) : null,
    towns2024: byTown ? Object.fromEntries(Object.entries(base).map(([k, b]) => [k, b.map(Math.round)])) : null,
  };
}

/** Notes whether a race's county results are missing (its file failed or has none), as opposed to still loading. */
function countyMissing(id, missing) {
  if (!!store.live.countyMissing?.[id] === missing) return;
  store.live.countyMissing = { ...(store.live.countyMissing || {}), [id]: missing };
  notify('counties');
}

export function wantCounties(ids) {
  if (store.sim || !resultsEnabled() || isDemo()) return;
  const now = Date.now();
  for (const id of ids) {
    const w = countyWanted.get(id) || { fetched: 0, wait: 0 };
    w.seen = now;
    countyWanted.set(id, w);
  }
  if (!countyTimer) { countyTimer = setInterval(refreshCounties, 15000); }
  setTimeout(refreshCounties, 50);
}

async function refreshCounties() {
  if (store.sim || !visible()) return;
  const now = Date.now();
  for (const [id, w] of countyWanted) {
    if (now - w.seen > 180e3) continue;                      // nobody is looking any more
    if (now - w.fetched < 90e3 || now < w.wait) continue;
    const race = store.byId[id];
    const res = store.live.results[id];
    const close = race && pollCloseDate(race.state);
    if (!race || (close && now < close)) continue;
    if (!res?.slug) { if (res?.total > 0) countyMissing(id, true); continue; }
    w.fetched = now;
    try {
      const r = await fetch(`https://static01.nyt.com/elections-assets/pages/data/2026-11-03/${res.slug}.json?t=${Math.floor(now / 60000)}`, { cache: 'no-store' });
      if (!r.ok) { w.wait = now + 300e3; countyMissing(id, true); continue; }   // race files go up on election night
      const data = await r.json();
      const nr = (data.races || []).find(x => nytRaceId(x.nyt_id) === id) || (data.races || [])[0];
      if (!nr) { countyMissing(id, true); continue; }
      const { L, R } = nytSides(race, nr);
      const NE = (nr.reporting_units || []).some(u => u.level === 'township') ? await loadNeTowns() : null;
      const { counties, towns, towns2024 } = countyEntries(nr, L, R, NE);
      if (Object.keys(counties).length) {
        store.live.counties = { ...(store.live.counties || {}), [id]: counties };
        if (towns) {
          store.live.towns = { ...(store.live.towns || {}), [id]: towns };
          store.live.towns2024 = { ...(store.live.towns2024 || {}), [id]: towns2024 };
        }
        countyMissing(id, false);
        notify('counties');
      } else countyMissing(id, true);
    } catch (e) {
      w.wait = now + 120e3;
      countyMissing(id, true);
    }
  }
}

async function refreshResults(office) {
  try {
    const res = await fetch(`${CONFIG.results.urls[office]}?t=${Math.floor(Date.now() / 15000)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    store.live.resultsTried[office] = true;
    if (store.sim) return;   // a simulation owns the results while it runs
    for (const nr of data.races || []) {
      if (nr.coverage === 'national') { if (office === 'house') store.live.houseVote = nationalVote(nr); continue; }
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
    // The first failure ends the placeholders, so the page can say the feed isn't answering.
    if (!store.live.resultsTried[office]) { store.live.resultsTried[office] = true; notify('results'); }
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
  const pairs = simRaces.map(r => ({ r, est: { mu: r.mu, sd: r.sd, pLeft: r.p, settled: r.settled }, live: seatCount(r, results[r.id]) }));
  const sw = estimateSwing(pairs.map(x => ({ est: x.est, live: x.live })));
  const est = {};
  for (const x of pairs) est[x.r.id] = liveEstimate(x.est, x.live, sw.swing, sw.sd);
  const sim = simulate(simRaces, est, store.base.chambers, { sims, natSd: sw.sd, natMu: 0, tipping: false, seed: 7 });
  for (const r of simRaces) if (est[r.id] && !est[r.id].settled && !est[r.id].called) est[r.id].pLeft = sim.raceProb[r.id];
  // Same-party races: A against B from the votes counted so far (the national swing says nothing here).
  for (const r of simRaces) {
    const d = r.duel, v = results[r.id]?.duel;
    if (!d || !v || !est[r.id]) continue;
    const called = v.won === 'a' ? 'left' : v.won === 'b' ? 'right' : null;
    est[r.id] = { ...est[r.id], duel: liveEstimate({ mu: d.mu, sd: d.sd, pLeft: d.pA }, { eevp: v.eevp, total: v.total, left: v.a, right: v.b, called }, 0, 0) };
  }
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

/**
 * Races not yet called where a party leads the count, by party: the lighter shades in the live seat bars. Louisiana's
 * all-party races go by each party's combined vote (seatCount); a race with no votes yet, or a tie, counts for no one.
 */
export function leadingSeats(type) {
  const out = { D: 0, R: 0, O: 0 };
  for (const r of racesOf(type)) {
    if (!r.left || !r.right) continue;
    const res = seatCount(r, store.live.results[r.id]);
    if (!res || res.called || !res.total || res.left === res.right) continue;
    const p = res.left > res.right ? r.leftParty : r.rightParty;
    out[p === 'D' || p === 'R' ? p : 'O']++;
  }
  return out;
}
