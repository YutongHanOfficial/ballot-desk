// Loads the precomputed data files and exposes merged race objects to the views.
import { ordinal, marginFill, pct, num, lastName } from './ui.js';
import { CONFIG, pollCloseDate } from './config.js';
import { samePerson } from './model.js';

export const store = {
  base: null, forecast: null, polls: null, markets: null, history: null, geo: null,
  races: [], byId: {}, states: [], stateByCode: {}, byState: {},
  live: {
    markets: {}, control: {}, marketsAt: null,       // live Polymarket prices
    results: {}, resultsAt: {}, resultsOk: null,     // live vote counts by race id
    est: null, sim: null, swing: null, active: false, demo: false,
    counties: {},                                    // live county results by race id (election night)
    houseVote: null,                                 // national House popular vote from the results feed
  },
  loadedAt: null,
  dataStamp: null,    // Last-Modified of the forecast.json we have, to spot a newer deploy (live.js)
  sim: null,          // a running election-night simulation (sim.js)
  // Set by the router while a forecast page is on screen (the forecast, Senate, House, Governors): our numbers,
  // colours and maps there stay at the final pre-election forecast, whatever the results do. Polymarket's prices
  // are someone else's and stay live.
  frozen: false,
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function notify(reason) { for (const fn of listeners) { try { fn(reason); } catch (e) { console.error(e); } } }

async function getJSON(path, bust = true, meta = null) {
  const url = bust ? `${path}?v=${Math.floor(Date.now() / 60000)}` : path;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  if (meta) meta.stamp = res.headers.get('last-modified');
  return res.json();
}

export const OFFICE = {
  senate: { label: 'Senate', plural: 'Senate races', order: 0 },
  gov: { label: 'Governor', plural: 'Governor races', order: 1 },
  house: { label: 'House', plural: 'House races', order: 2 },
  ltgov: { label: 'Lt. Governor', plural: 'Lieutenant governor races', order: 3 },
  ag: { label: 'Attorney General', plural: 'Attorney general races', order: 4 },
  sos: { label: 'Secretary of State', plural: 'Secretary of state races', order: 5 },
};

export function titleFor(r, stateName) {
  switch (r.type) {
    case 'senate': return `${stateName} Senate${r.special ? ' (special)' : ''}`;
    case 'house': return r.district ? `${stateName}'s ${ordinal(r.district)} District` : `${stateName} At-Large District`;
    case 'gov': return `${stateName} Governor`;
    default: return `${stateName} ${OFFICE[r.type]?.label || r.type}`;
  }
}

function shortFor(r) {
  switch (r.type) {
    case 'house': return r.district ? `${r.state}-${String(r.district).padStart(2, '0')}` : `${r.state}-AL`;
    case 'senate': return `${r.state} Sen.${r.special ? ' (S)' : ''}`;
    case 'gov': return `${r.state} Gov.`;
    case 'ltgov': return `${r.state} Lt. Gov.`;
    case 'ag': return `${r.state} AG`;
    case 'sos': return `${r.state} SoS`;
    default: return r.id;
  }
}

export async function loadData({ first = false } = {}) {
  const meta = {};
  const [base, forecast, polls, markets, history, backcast] = await Promise.all([
    getJSON('/data/races.json'), getJSON('/data/forecast.json', true, meta), getJSON('/data/polls.json'),
    getJSON('/data/markets.json'), getJSON('/data/history.json').catch(() => ({ points: [] })),
    getJSON('/data/backcast.json').catch(() => null),   // the model re-run on earlier days (pipeline/backcast.mjs)
  ]);
  if (first) store.geo = await getJSON('/data/geo/states-albers-10m.json', false);
  Object.assign(store, { base, forecast, polls, markets, history, backcast, loadedAt: new Date().toISOString(), dataStamp: meta.stamp || null });
  store.states = base.states;
  store.stateByCode = Object.fromEntries(base.states.map(s => [s.code, s]));
  store.races = base.races.map(r => buildRace(r));
  store.byId = Object.fromEntries(store.races.map(r => [r.id, r]));
  store.byState = {};
  for (const r of store.races) (store.byState[r.state] ||= []).push(r);
  for (const list of Object.values(store.byState)) list.sort((a, b) => (OFFICE[a.type].order - OFFICE[b.type].order) || ((a.district || 0) - (b.district || 0)));
  return store;
}

function buildRace(r) {
  const st = store.stateByCode[r.state] || { name: r.state };
  const f = store.forecast.races[r.id] || {};
  const left = f.left ?? r.left, right = f.right ?? r.right;
  const leftParty = f.leftParty ?? r.leftParty, rightParty = f.rightParty ?? r.rightParty;
  const find = (name) => (r.candidates || []).find(c => c.name === name) || (name ? { name, party: null } : null);
  return {
    ...r, left, right, leftParty, rightParty,
    leftCand: find(left), rightCand: find(right),
    stateName: st.name, region: st.region,
    title: titleFor(r, st.name), short: shortFor(r), office: OFFICE[r.type]?.label || r.type,
    url: `/race/${r.id}`,
    p: f.pLeft ?? null, mu: f.mu ?? null, sd: f.sd ?? null, components: f.components || {}, settled: !!f.settled,
    duel: f.duel || null,   // same-party general: { a, b, party, pA, mu, sd, source, marketA, volume }
    market: store.markets.races[r.id] || null,
    pollData: store.polls.races[r.id] || null,
  };
}

/** Current view of a race: live estimate when votes are being counted, else the pre-election forecast. */
export function cur(race) {
  if (store.frozen) return forecastOf(race);
  const L = store.live;
  const est = L.est && L.est[race.id];
  const res = L.results[race.id] || null;
  const mk = L.markets[race.id] || null;
  const marketP = mk ? mk.pLeft : race.market?.pLeft ?? null;
  if (est && est.live) {
    return { p: est.pLeft, mu: est.mu, sd: est.sd, live: true, called: est.called || null, result: res, eevp: est.eevp ?? res?.eevp ?? 0, marketP };
  }
  return { p: race.p, mu: race.mu, sd: race.sd, live: false, called: null, result: res, eevp: res?.eevp ?? 0, marketP };
}

/** A race's final pre-election forecast, shaped like cur() but never moved by results. The market price is live. */
export function forecastOf(race) {
  const marketP = store.live.markets[race.id]?.pLeft ?? race.market?.pLeft ?? null;
  return { p: race.p, mu: race.mu, sd: race.sd, live: false, called: null, result: null, eevp: 0, marketP };
}

/** Chamber summary in force right now: live simulation if results exist, else the pre-election forecast. */
export function chamber(type) {
  const live = !store.frozen && store.live.sim && store.live.active ? store.live.sim[type] : null;
  return { ...(live || store.forecast.control[type]), live: !!live };
}

/**
 * Same-party race (California's top two): A's chance against B right now. Called results win, then the live
 * model once votes are counted, then the forecast. final (the default on forecast pages): the pre-election
 * forecast alone. marketA, Polymarket's price for A, is live either way.
 */
export function duelNow(r, { final = store.frozen } = {}) {
  const d = r.duel;
  if (!d) return null;
  const res = store.live.results[r.id]?.duel || null;
  const est = store.live.est?.[r.id]?.duel;
  const mk = store.live.markets[r.id] || r.market;
  const price = (name) => mk?.outcomes?.find(o => o.name && samePerson(o.name, name))?.p ?? null;
  const pa = price(d.a), pb = price(d.b);
  const marketA = pa !== null && pb !== null && pa + pb > 0 ? pa / (pa + pb) : d.marketA ?? null;
  if (final) return { ...d, live: false, called: null, result: null, marketA };
  if (res?.won) return { ...d, pA: res.won === 'a' ? 1 : 0, live: true, called: res.won, result: res, marketA };
  if (est && est.live && res && res.total > 0) return { ...d, pA: est.pLeft, mu: est.mu, sd: est.sd, live: true, called: null, result: res, marketA };
  return { ...d, live: false, called: null, result: res, marketA };
}

/** Polymarket's price for control of a chamber: live, or as of the last data refresh when it can't be reached. */
export function marketControl(type) {
  const live = store.live.control[type];
  const base = store.forecast.markets?.[type];
  if (live && live.pD !== null && live.pD !== undefined) return { ...base, ...live, live: true };
  return base || null;
}

export function racesOf(type) { return store.races.filter(r => r.type === type); }

/** Election night (real or simulated) with results flowing: maps switch from forecast to results colours. */
export const nightMode = () => !store.frozen && (!!store.sim || store.live.active);

/** The pre-election forecast stops re-running when the first polls close (pipeline/refresh.mjs): its last run is final. */
export const forecastFinal = () => Date.now() >= Date.parse(CONFIG.firstPollsClose);

const settledParty = (r) => (r.left ? r.leftParty : r.rightParty) || r.samePartyGeneral;

/**
 * What a race's colour on every map comes from: { party, margin } for the side ahead (points, >= 0), or { none }
 * with the grey to use instead. Before results, and on forecast pages, it is the final forecast's projected margin;
 * once votes are counted, the margin in the count. Settled seats (one major party, or two of the same) count as safe.
 */
export function shade(r) {
  if (!r) return { none: 'var(--none)' };
  if (nightMode() && awaiting(r)) return { none: 'var(--await)' };
  if (!r.left || !r.right) return { party: settledParty(r), margin: 100 };
  if (nightMode()) {
    const res = store.live.results[r.id];
    if (res && res.total > 0) {
      const m = (100 * (res.left - res.right)) / res.total;
      return { party: m >= 0 ? r.leftParty : r.rightParty, margin: Math.abs(m) };
    }
    if (res && (res.called === 'left' || res.called === 'right')) return { party: res.called === 'left' ? r.leftParty : r.rightParty, margin: 100 };
    return { none: 'var(--novotes)' };
  }
  if (r.mu === null || r.mu === undefined) return { none: 'var(--none)' };
  return { party: r.mu >= 0 ? r.leftParty : r.rightParty, margin: Math.abs(r.mu) };
}
/** Map colour for a race: its margin band (ui.js marginFill), or the grey shade() gives. */
export function raceFill(r) {
  const s = shade(r);
  return s.none || marginFill(s.party, s.margin);
}
/** The same scale by the live projection's expected final margin (the forecast's until votes are counted). */
export function projectionFill(r) {
  if (!r) return 'var(--none)';
  if (!r.left || !r.right) return marginFill(settledParty(r), 100);
  const mu = cur(r).mu;
  return mu === null || mu === undefined ? 'var(--none)' : marginFill(mu >= 0 ? r.leftParty : r.rightParty, mu);
}
/** On election night: votes are in but no call yet. Maps stripe these races. */
export function counting(r) {
  if (!r || !nightMode()) return false;
  const res = store.live.results[r.id];
  return !!res && res.total > 0 && !res.called && !res.duel?.won;
}

// "410,000": an estimate shown to two significant figures (to the ten below 1,000, exact below 100).
const roughly = (n) => { if (n < 100) return Math.round(n); const m = 10 ** (Math.floor(Math.log10(n)) - 1); return Math.round(n / m) * m; };
const NOT_A_CANDIDATE = /^(others?|write-ins?)$/i;

/**
 * What the votes still to be counted would have to do to change a race that is being counted and not yet called.
 * left: AP's estimate of the votes to come, its expected total less the count (from the share counted when the
 * feed has no total). Usually it is the share of them the runner-up needs to draw level, with the other
 * candidates keeping their share so far; out means even every vote left would not be enough. Where a winner
 * needs a majority (Georgia's and Louisiana's runoffs, Vermont), it is the share the leader needs to finish above
 * 50%. side: which of the race's two candidates that is about ('left' / 'right', or 'a' / 'b' in a same-party race).
 * Null when nothing is left to count or it can't be estimated.
 */
export function catchUp(r) {
  const res = r && !store.frozen && store.live.results[r.id];
  if (!res || !(res.total > 0) || res.called || res.runoff || res.duel?.won) return null;
  const V = res.total;
  const left = res.expected ? res.expected - V : res.eevp > 0 && res.eevp < 100 ? (V * (100 - res.eevp)) / res.eevp : 0;
  if (!(left >= 1)) return null;
  const [a, b] = (res.cands || []).filter(c => !NOT_A_CANDIDATE.test(c.name || ''));
  if (!a || !b) return null;
  const gap = a.votes - b.votes;
  const sideOf = (name) => r.duel ? (samePerson(name, r.duel.a) ? 'a' : samePerson(name, r.duel.b) ? 'b' : null)
    : samePerson(name, r.left) ? 'left' : samePerson(name, r.right) ? 'right' : null;
  if (res.rule === 'majority') {
    return { kind: 'majority', name: a.name, side: sideOf(a.name), rival: b.name, left, gap, runoffs: !!res.runoffs, share: (0.5 * (V + left) - a.votes) / left };
  }
  const others = Math.max(0, V - a.votes - b.votes) / V;
  return { kind: res.rule === 'rcv' ? 'rcv' : 'plurality', name: b.name, side: sideOf(b.name), rival: a.name, left, gap,
    share: (gap / left + 1 - others) / 2, out: gap >= left };
}

/**
 * catchUp() in words. The full sentence for a race page; short: a few words for cards and tooltips ("Paxton needs
 * 58.2% of votes left"); bare: the same without the name, for a line under that candidate ("Needs 58.2% of votes left").
 */
export function catchUpText(k, { short = false, bare = false } = {}) {
  if (!k) return null;
  const share = pct(Math.min(1, Math.max(0, k.share)));
  const ballots = k.kind === 'rcv' ? 'ballots' : 'votes';
  if (!short && !bare) {
    const left = num(roughly(k.left));
    if (k.kind === 'majority') {
      if (k.share <= 0) return `${k.name} already has more than half of the votes expected${k.runoffs ? ', enough to avoid a runoff' : ''}.`;
      if (k.share >= 1) return `No one can reach 50% with the estimated ${left} votes left${k.runoffs ? ', so the race looks headed for a runoff' : ''}.`;
      return `${k.name} needs ${share} of the estimated ${left} votes left to finish above 50%${k.runoffs ? ' and avoid a runoff' : ''}.`;
    }
    const rcv = k.kind === 'rcv' ? ' If no one wins a majority, ranked choices decide.' : '';
    if (k.out) return `${k.rival}’s lead of ${num(k.gap)} ${k.kind === 'rcv' ? 'first-choice votes' : 'votes'} is bigger than the estimated ${left} ${ballots} left to count.${rcv}`;
    return `${k.name} needs ${share} of the estimated ${left} ${ballots} left to ${k.kind === 'rcv' ? `pass ${k.rival} on first choices` : `overtake ${k.rival}`}.${rcv}`;
  }
  const said = (rest) => bare ? rest[0].toUpperCase() + rest.slice(1) : `${lastName(k.name)} ${rest}`;
  if (k.kind === 'majority') {
    if (k.share <= 0) return said('has a majority of the expected vote');
    if (k.share >= 1) return bare ? 'Can’t reach 50% with the votes left' : 'No one can reach 50%';
    return said(`needs ${share} of votes left to finish over 50%`);
  }
  if (k.out) return bare ? `Needs more ${ballots} than are left` : `${lastName(k.rival)}’s lead is bigger than the ${ballots} left`;
  return said(`needs ${share} of ${ballots} left`);
}

/** On election night, true once a race is projected (maps draw a check mark on it). */
export function projected(r) {
  if (!r || !nightMode()) return false;
  const c = store.live.results[r.id]?.called;
  return c === 'left' || c === 'right' || c === 'other';
}

/** On election night (real or simulated), true for races whose polls have not closed yet. */
export function awaiting(r) {
  if (store.frozen) return false;
  if (store.sim) return !store.live.results[r.id];
  if (!store.live.active) return false;
  const d = pollCloseDate(r.state);
  return d ? Date.now() < d : false;
}

export function leftWinsParty(race, p) {
  return p >= 0.5 ? race.leftParty : race.rightParty;
}
