// Loads the precomputed data files and exposes merged race objects to the views.
import { ordinal } from './ui.js';

export const store = {
  base: null, forecast: null, polls: null, markets: null, history: null, geo: null,
  races: [], byId: {}, states: [], stateByCode: {}, byState: {},
  live: {
    markets: {}, control: {}, marketsAt: null,       // live Polymarket prices
    results: {}, resultsAt: {}, resultsOk: null,     // live vote counts by race id
    est: null, sim: null, swing: null, active: false, demo: false,
  },
  loadedAt: null,
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function notify(reason) { for (const fn of listeners) { try { fn(reason); } catch (e) { console.error(e); } } }

async function getJSON(path, bust = true) {
  const url = bust ? `${path}?v=${Math.floor(Date.now() / 60000)}` : path;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
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

function titleFor(r, stateName) {
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
  const [base, forecast, polls, markets, history] = await Promise.all([
    getJSON('data/races.json'), getJSON('data/forecast.json'), getJSON('data/polls.json'),
    getJSON('data/markets.json'), getJSON('data/history.json').catch(() => ({ points: [] })),
  ]);
  if (first) store.geo = await getJSON('data/geo/states-albers-10m.json', false);
  Object.assign(store, { base, forecast, polls, markets, history, loadedAt: new Date().toISOString() });
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
    url: `#/race/${r.id}`,
    p: f.pLeft ?? null, mu: f.mu ?? null, sd: f.sd ?? null, components: f.components || {}, settled: !!f.settled,
    market: store.markets.races[r.id] || null,
    pollData: store.polls.races[r.id] || null,
  };
}

/** Current view of a race: live estimate when votes are being counted, else the pre-election forecast. */
export function cur(race) {
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

/** Chamber summary in force right now: live simulation if results exist, else the pre-election forecast. */
export function chamber(type) {
  const live = store.live.sim && store.live.active ? store.live.sim[type] : null;
  return { ...(live || store.forecast.control[type]), live: !!live };
}

export function marketControl(type) {
  const live = store.live.control[type];
  const base = store.forecast.markets?.[type];
  if (live && live.pD !== null && live.pD !== undefined) return { ...base, ...live, live: true };
  return base || null;
}

export function racesOf(type) { return store.races.filter(r => r.type === type); }

export function leftWinsParty(race, p) {
  return p >= 0.5 ? race.leftParty : race.rightParty;
}
