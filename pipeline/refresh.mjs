#!/usr/bin/env node
// Refresh polls (VoteHub) and prediction markets (Polymarket), run the forecast, write data/*.json.
// No dependencies: Node 20+ (global fetch). Usage: node pipeline/refresh.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateRace, simulate, pollAverage, labelAverage, samePerson, MODEL } from '../assets/js/model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const UA = 'Midterms2026Site/1.0 (static election site; data pipeline)';
const NOW = Date.now();

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function getJSON(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw new Error(`${url}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(path.join(DATA, file), 'utf8')); } catch { return fallback; }
}

async function writeJSON(file, obj) {
  const tmp = path.join(DATA, file + '.tmp');
  await fs.writeFile(tmp, JSON.stringify(obj));
  await fs.rename(tmp, path.join(DATA, file));
}

// --------------------------------------------------------------------------------------------- polls

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

function slimPoll(p, race) {
  const ans = p.answers || [];
  const l = ans.find(a => samePerson(a.choice, race.left));
  const r = ans.find(a => samePerson(a.choice, race.right));
  return {
    pollster: p.pollster, sponsors: p.sponsors?.length ? p.sponsors : undefined, start: p.start_date, end: p.end_date,
    n: p.sample_size || null, pop: p.population, url: p.url, partisan: p.internal || p.partisan ? (p.partisan || 'internal') : undefined,
    left: l ? l.pct : null, right: r ? r.pct : null,
    others: ans.filter(a => a !== l && a !== r).map(a => ({ name: a.choice, pct: a.pct })),
  };
}

// --------------------------------------------------------------------------------------------- markets

const PM_QUERIES = [
  'senate election winner', 'governor election winner', 'house election winner',
  'attorney general election winner', 'secretary of state election winner', 'lieutenant governor election winner',
  'state senate 2026', 'which party will win the house', 'which party will win the senate',
  'republican senate seats after the 2026', 'republican house seats after the 2026', 'balance of power 2026',
  'how many republican governors', 'house popular vote margin',
];

async function polymarketEvents() {
  const seen = new Map();
  for (const q of PM_QUERIES) {
    for (let page = 1; page <= 15; page++) {
      const u = 'https://gamma-api.polymarket.com/public-search?' +
        new URLSearchParams({ q, limit_per_type: '50', events_status: 'active', page: String(page) });
      let d;
      try { d = await getJSON(u); } catch (e) { log('polymarket search failed', q, e.message); break; }
      for (const e of d.events || []) if (!seen.has(e.slug)) seen.set(e.slug, e);
      if (!d.pagination?.hasMore) break;
    }
  }
  return [...seen.values()];
}

const PLACEHOLDER = /^(person|option|party|candidate)\s+[a-z]$|^other$|^[a-z]$/i;

function parseOutcome(title) {
  const t = String(title || '').trim();
  let m = t.match(/^(.*?)\s*\((D|R|I|L|G|DFL|Ind\.?|Dem\.?|Rep\.?)\)\s*$/i);
  if (m) {
    const p = m[2].toUpperCase();
    return { name: m[1].replace(/^(Sen|Rep|Gov|Dr)\.\s+/i, '').trim(), party: p.startsWith('D') ? 'D' : p.startsWith('R') ? 'R' : p.startsWith('I') ? 'I' : p[0] };
  }
  if (/^democrat(ic)?( party)?$/i.test(t)) return { name: null, party: 'D' };
  if (/^republican( party)?$/i.test(t)) return { name: null, party: 'R' };
  if (/^independent$/i.test(t)) return { name: null, party: 'I' };
  if (/^coalition$/i.test(t)) return { name: null, party: 'C' };
  return { name: t.replace(/^(Sen|Rep|Gov|Dr)\.\s+/i, '').trim(), party: null };
}

function eventOutcomes(e) {
  const outs = [];
  for (const m of e.markets || []) {
    if (m.closed && !m.active) continue;
    const label = m.groupItemTitle || m.question;
    let price = null;
    try { price = parseFloat(JSON.parse(m.outcomePrices || 'null')?.[0]); } catch { price = null; }
    const bid = parseFloat(m.bestBid), ask = parseFloat(m.bestAsk);
    if (Number.isFinite(bid) && Number.isFinite(ask) && ask > 0 && ask - bid <= 0.1) price = (bid + ask) / 2;
    if (price === null || !Number.isFinite(price)) continue;
    if (PLACEHOLDER.test(String(label).trim())) continue;   // unlisted 'Person A' / 'Other' slots
    let token = null;
    try { token = JSON.parse(m.clobTokenIds || 'null')?.[0] || null; } catch { token = null; }
    outs.push({ label, ...parseOutcome(label), p: price, volume: Math.round(parseFloat(m.volume) || 0), token });
  }
  const total = outs.reduce((s, o) => s + o.p, 0);
  if (total > 0) for (const o of outs) o.p = Math.round((o.p / total) * 10000) / 10000;
  return outs.sort((a, b) => b.p - a.p);
}

function mapEvent(e, byName) {
  const t = e.title.trim().replace(/\s+/g, ' ');
  let m;
  if ((m = t.match(/^(.+?) Senate Election Winner$/)) && byName[m[1]]) return { kind: 'race', id: `${byName[m[1]]}-SEN` };
  if ((m = t.match(/^(.+?) Governor Election Winner$/)) && byName[m[1]]) return { kind: 'race', id: `${byName[m[1]]}-GOV` };
  if ((m = t.match(/^(.+?) Attorney General Election Winner$/)) && byName[m[1]]) return { kind: 'race', id: `${byName[m[1]]}-AG` };
  if ((m = t.match(/^(.+?) Secretary of State Election Winner$/)) && byName[m[1]]) return { kind: 'race', id: `${byName[m[1]]}-SOS` };
  if ((m = t.match(/^(.+?) Lieutenant Governor Election Winner$/)) && byName[m[1]]) return { kind: 'race', id: `${byName[m[1]]}-LTGOV` };
  if ((m = t.match(/^([A-Z]{2})-(\d{2}|AL) House Election Winner$/))) {
    return { kind: 'race', id: AT_LARGE.has(m[1]) || m[2] === 'AL' ? `${m[1]}-AL` : `${m[1]}-${m[2]}` };
  }
  if ((m = t.match(/^Which party will win the (.+?) State Senate in 2026\?$/)) && byName[m[1]]) return { kind: 'legis', id: `${byName[m[1]]}-UPPER` };
  if ((m = t.match(/^(.+?) State Senate Winner 2026\??$/)) && byName[m[1]]) return { kind: 'legis', id: `${byName[m[1]]}-UPPER` };
  if ((m = t.match(/^Which party will win the (.+?) State (House|Assembly) in 2026\?$/)) && byName[m[1]]) return { kind: 'legis', id: `${byName[m[1]]}-LOWER` };
  if (t === 'Which party will win the Senate in 2026?') return { kind: 'control', id: 'senate' };
  if (t === 'Which party will win the House in 2026?') return { kind: 'control', id: 'house' };
  if (/^Republican Senate seats after the 2026 midterm elections\?$/.test(t)) return { kind: 'brackets', id: 'senateR' };
  if (/^Republican House seats after the 2026 midterm elections\?$/.test(t)) return { kind: 'brackets', id: 'houseR' };
  if (/^How many Republican Governors after the 2026 midterm/.test(t)) return { kind: 'brackets', id: 'govR' };
  if (/^Balance of Power: 2026 Midterms$/.test(t)) return { kind: 'brackets', id: 'balance' };
  if (/House Popular Vote Margin/.test(t)) return { kind: 'brackets', id: 'popularVote' };
  return null;
}

function sideProbs(race, outs) {
  let left = null, right = null;
  for (const o of outs) {
    const nameHit = (n) => o.name && n && samePerson(o.name, n);
    if (left === null && (nameHit(race.left) || (!o.name && o.party && o.party === race.leftParty))) { left = o; continue; }
    if (right === null && (nameHit(race.right) || (!o.name && o.party && o.party === race.rightParty))) { right = o; continue; }
  }
  // Fall back to party labels on named outcomes when names differ (nicknames etc.)
  if (!left) left = outs.find(o => o !== right && o.party && o.party === race.leftParty && outs.filter(x => x.party === race.leftParty).length === 1) || null;
  if (!right) right = outs.find(o => o !== left && o.party && o.party === race.rightParty && outs.filter(x => x.party === race.rightParty).length === 1) || null;
  return { left, right };
}

/** Candidate matching a name; when two share it (Alaska's two Dan Sullivans) prefer the incumbent / current pick. */
function pickPerson(cands, name, race) {
  const hits = cands.filter(x => samePerson(x.name, name));
  if (hits.length <= 1) return hits[0] || null;
  return hits.find(x => x.incumbent) || hits.find(x => x.name === race.left || x.name === race.right) || hits[0];
}

/** Pick the two leading candidates from market prices (preferred) or poll shares; null if no change. */
function chooseSides(race, ps, m) {
  const cands = (race.candidates || []).filter(c => !c.writeIn);
  if (cands.length < 2) return null;
  const score = new Map(cands.map(c => [c, { mk: 0, mkSeen: false, poll: 0, pollN: 0 }]));
  if (m && m.volume > 5000) {
    for (const o of m.outcomes) {
      let c = o.name ? pickPerson(cands, o.name, race) : null;
      if (!c && o.party) {
        const same = cands.filter(x => x.party === o.party);
        c = same.length === 1 ? same[0] : same.find(x => x.name === race.left || x.name === race.right) || null;
      }
      if (c) { const s = score.get(c); s.mk += o.p; s.mkSeen = true; }
    }
  }
  for (const p of ps) {
    for (const a of p.answers || []) {
      const c = pickPerson(cands, a.choice, race);
      if (c) { const s = score.get(c); s.poll += a.pct; s.pollN++; }
    }
  }
  const useMarket = [...score.values()].some(s => s.mkSeen);
  const ranked = cands.map(c => {
    const s = score.get(c);
    return { c, v: useMarket ? s.mk : (s.pollN ? s.poll / s.pollN : 0), polled: s.pollN };
  }).filter(x => useMarket ? x.v > 0 : x.polled >= 2).sort((a, b) => b.v - a.v);
  if (ranked.length < 2 || (!useMarket && ps.length < 2)) return null;
  const [a, b] = [ranked[0].c, ranked[1].c];
  if ((a.name === race.left || a.name === race.right) && (b.name === race.left || b.name === race.right)) return null;
  // Second place must be a real contender, not a 1-cent long shot.
  if (useMarket && ranked[1].v < 0.03 && (race.left && race.right)) return null;
  let left, right;
  if (a.party === 'R' && b.party !== 'R') { right = a; left = b; }
  else if (b.party === 'R' && a.party !== 'R') { right = b; left = a; }
  else if (a.party === 'D' && b.party !== 'D') { left = a; right = b; }
  else if (b.party === 'D' && a.party !== 'D') { left = b; right = a; }
  else return null; // same party or two independents: keep the parsed default
  return { left: left.name, right: right.name, leftParty: left.party, rightParty: right.party };
}

// --------------------------------------------------------------------------------------------- main

// Once polls close, markets react to returns; feeding them back into the prior would double count the votes.
// The pre-election forecast is frozen from here on and the browser's live model takes over.
const FREEZE_AT = Date.parse('2026-11-03T23:00:00Z');

async function main() {
  if (NOW >= FREEZE_AT && !process.env.FORCE) {
    log('polls have started closing: pre-election forecast is frozen (set FORCE=1 to override)');
    return;
  }
  const base = JSON.parse(await fs.readFile(path.join(DATA, 'races.json'), 'utf8'));
  const byName = Object.fromEntries(base.states.map(s => [s.name, s.code]));
  const region = Object.fromEntries(base.states.map(s => [s.code, s.region]));
  const races = base.races.map(r => ({ ...r, region: region[r.state] }));
  const raceById = Object.fromEntries(races.map(r => [r.id, r]));

  // Polls ------------------------------------------------------------------
  log('fetching VoteHub polls');
  let polls = [];
  try { polls = await getJSON('https://api.votehub.com/polls'); } catch (e) { log('VoteHub failed:', e.message); }
  const prevPolls = await readJSON('polls.json', null);
  const pollsByRace = {};
  const generic = [], approval = [];
  for (const p of polls) {
    if (p.poll_type === 'generic-ballot' && String(p.subject).startsWith('2026')) { generic.push(p); continue; }
    if (p.poll_type === 'approval' && p.subject === 'Donald Trump') { approval.push(p); continue; }
    const id = pollRaceId(p, byName);
    if (id && raceById[id]) (pollsByRace[id] ||= []).push(p);
  }
  const recent = (ps, days) => ps.filter(p => (NOW - new Date(p.end_date + 'T12:00:00Z')) / 864e5 <= days);
  const genericAvg = labelAverage(recent(generic, 120), 'Dem', 'Rep', NOW);
  const approvalAvg = labelAverage(recent(approval, 60), 'Approve', 'Disapprove', NOW);
  const pollOut = {
    updated: new Date(NOW).toISOString(), source: 'VoteHub (https://votehub.com/polls), CC BY 4.0',
    generic: genericAvg ? { ...genericAvg, polls: recent(generic, 60).sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 40)
      .map(p => ({ pollster: p.pollster, end: p.end_date, n: p.sample_size, pop: p.population, url: p.url, d: p.answers.find(a => a.choice === 'Dem')?.pct, r: p.answers.find(a => a.choice === 'Rep')?.pct })) } : prevPolls?.generic || null,
    approval: approvalAvg ? { approve: approvalAvg.left, disapprove: approvalAvg.right, net: approvalAvg.margin, n: approvalAvg.n } : prevPolls?.approval || null,
    races: {},
  };
  // National environment: the generic-ballot aggregators Wikipedia tracks (DDHQ, FiftyPlusOne, RCP, Silver
  // Bulletin...) are steadier than VoteHub alone, which logs few national polls; fall back to VoteHub.
  const aggs = (base.national?.generic || []).filter(a => !/average/i.test(a.source));
  const appr = (base.national?.approval || []).filter(a => !/average/i.test(a.source));
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const env = {
    generic: aggs.length >= 2 ? mean(aggs.map(a => a.margin)) : genericAvg ? genericAvg.margin : (prevPolls?.generic?.margin ?? 5),
    genericSource: aggs.length >= 2 ? `average of ${aggs.length} polling aggregates` : 'VoteHub poll average',
  };
  if (appr.length >= 2) {
    pollOut.approval = { approve: mean(appr.map(a => a.approve)), disapprove: mean(appr.map(a => a.disapprove)), n: appr.length, source: `average of ${appr.length} aggregates` };
    pollOut.approval.net = pollOut.approval.approve - pollOut.approval.disapprove;
  }
  pollOut.genericAggregates = aggs;
  if (!polls.length && prevPolls) Object.assign(pollOut, { races: prevPolls.races, stale: true });
  log(`polls: ${polls.length} total, ${Object.keys(pollOut.races).length} races with polls, generic D${env.generic >= 0 ? '+' : ''}${env.generic.toFixed(1)}`);

  // Markets ----------------------------------------------------------------
  log('fetching Polymarket events');
  let events = [];
  try { events = await polymarketEvents(); } catch (e) { log('Polymarket failed:', e.message); }
  const prevMarkets = await readJSON('markets.json', null);
  const mk = { updated: new Date(NOW).toISOString(), source: 'Polymarket (https://polymarket.com)', control: {}, races: {}, legislatures: {}, brackets: {} };
  for (const e of events) {
    const map = mapEvent(e, byName);
    if (!map) continue;
    const outs = eventOutcomes(e);
    if (!outs.length) continue;
    const entry = { slug: e.slug, title: e.title.trim(), volume: Math.round(e.volume || 0), liquidity: Math.round(e.liquidity || 0),
      outcomes: outs.map(o => ({ label: o.label, name: o.name, party: o.party, p: o.p, token: o.token })) };
    if (map.kind === 'race') {
      const race = raceById[map.id];
      if (!race) continue;
      // Several events can map to one race (e.g. re-listed markets): keep the most traded.
      if (mk.races[map.id] && mk.races[map.id].volume >= entry.volume) continue;
      mk.races[map.id] = entry;
    } else if (map.kind === 'legis') {
      if (mk.legislatures[map.id] && mk.legislatures[map.id].volume >= entry.volume) continue;
      mk.legislatures[map.id] = entry;
    } else if (map.kind === 'control') {
      mk.control[map.id] = { ...entry, pD: outs.find(o => o.party === 'D')?.p ?? null, pR: outs.find(o => o.party === 'R')?.p ?? null };
    } else {
      if (mk.brackets[map.id] && mk.brackets[map.id].volume >= entry.volume) continue;
      mk.brackets[map.id] = entry;
    }
  }
  if (!events.length && prevMarkets) Object.assign(mk, { control: prevMarkets.control, races: prevMarkets.races, legislatures: prevMarkets.legislatures, brackets: prevMarkets.brackets, stale: true });
  log(`markets: ${events.length} events scanned, ${Object.keys(mk.races).length} races, ${Object.keys(mk.legislatures).length} chambers`);

  // Main contenders ---------------------------------------------------------
  // Wikipedia lists every ballot-qualified candidate; markets and polls tell us who the real top two are
  // (e.g. an independent who replaced the Democrat as the main challenger in a top-four or fusion race).
  const sideChanges = [];
  for (const race of races) {
    const ch = chooseSides(race, recent(pollsByRace[race.id] || [], 120), mk.races[race.id]);
    if (ch) { sideChanges.push(`${race.id}: ${race.left}/${race.right} -> ${ch.left}/${ch.right}`); Object.assign(race, ch); }
  }
  if (sideChanges.length) log('main contenders adjusted:', sideChanges.join('; '));
  for (const [id, entry] of Object.entries(mk.races)) {
    const { left, right } = sideProbs(raceById[id], entry.outcomes);
    entry.pLeft = left ? left.p : right ? round(1 - right.p, 4) : null;
    entry.pRight = right ? right.p : left ? round(1 - left.p, 4) : null;
  }

  for (const [id, ps] of Object.entries(pollsByRace)) {
    const race = raceById[id];
    if (!race.left || !race.right) continue;
    const avg = pollAverage(recent(ps, 150), race.left, race.right, NOW);
    const matched = ps.filter(p => (p.answers || []).some(a => samePerson(a.choice, race.left)) && (p.answers || []).some(a => samePerson(a.choice, race.right)));
    if (!matched.length) continue;
    pollOut.races[id] = {
      avg: avg ? { margin: round(avg.margin, 2), left: round(avg.left, 1), right: round(avg.right, 1), n: avg.n, neff: round(avg.neff, 2), latest: avg.latest } : null,
      polls: matched.sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 60).map(p => slimPoll(p, race)),
    };
  }

  // Forecast ---------------------------------------------------------------
  const ests = {};
  for (const r of races) {
    const poll = pollOut.races[r.id]?.avg ? { margin: pollOut.races[r.id].avg.margin, neff: pollOut.races[r.id].avg.neff, n: pollOut.races[r.id].avg.n } : null;
    const m = mk.races[r.id];
    const market = m && m.pLeft !== null && m.pLeft !== undefined ? { pLeft: m.pLeft, volume: m.volume } : null;
    ests[r.id] = estimateRace(r, { poll, market }, env);
  }
  log('simulating');
  const t0 = Date.now();
  const sim = simulate(races, ests, base.chambers, { sims: MODEL.sims });
  log(`simulated ${sim.sims} elections in ${Date.now() - t0} ms: Senate D ${(sim.senate.pD * 100).toFixed(1)}%, House D ${(sim.house.pD * 100).toFixed(1)}%`);

  const forecast = {
    updated: new Date(NOW).toISOString(), model: MODEL.version, env: { generic: round(env.generic, 2), genericSource: env.genericSource, approval: pollOut.approval },
    control: { senate: sim.senate, house: sim.house, gov: sim.gov }, flips: sim.flips, sims: sim.sims,
    markets: {
      senate: mk.control.senate ? { pD: mk.control.senate.pD, pR: mk.control.senate.pR, volume: mk.control.senate.volume, slug: mk.control.senate.slug } : null,
      house: mk.control.house ? { pD: mk.control.house.pD, pR: mk.control.house.pR, volume: mk.control.house.volume, slug: mk.control.house.slug } : null,
    },
    races: Object.fromEntries(Object.entries(ests).map(([id, e]) => [id, {
      mu: e.mu, sd: e.sd, pLeft: sim.raceProb[id] ?? e.pLeft, settled: e.settled || undefined, components: e.components,
      left: raceById[id].left, right: raceById[id].right, leftParty: raceById[id].leftParty, rightParty: raceById[id].rightParty,
    }])),
  };

  // History of the topline, one point per run (thinned to every 3 hours once older than 2 days).
  const hist = await readJSON('history.json', { points: [] });
  hist.points.push({
    t: new Date(NOW).toISOString(), sen: sim.senate.pD, house: sim.house.pD, gov: round(sim.gov.dSeats.mean, 1),
    senSeats: sim.senate.dSeats.mean, houseSeats: sim.house.dSeats.mean,
    mSen: forecast.markets.senate?.pD ?? null, mHouse: forecast.markets.house?.pD ?? null, generic: round(env.generic, 2),
  });
  // Daily Polymarket history for the control markets gives the chart a longer back-story than our own runs.
  hist.market = hist.market || {};
  for (const ch of ['senate', 'house']) {
    const tok = mk.control[ch]?.outcomes?.find(o => o.party === 'D')?.token;
    if (!tok) continue;
    try {
      const ph = await getJSON(`https://clob.polymarket.com/prices-history?market=${tok}&interval=max&fidelity=720`);
      const since = NOW - 150 * 864e5;
      hist.market[ch] = (ph.history || []).filter(x => x.t * 1000 >= since).map(x => [new Date(x.t * 1000).toISOString(), round(x.p, 4)]);
    } catch (e) { log('price history failed', ch, e.message); }
  }
  const cutoff = NOW - 2 * 864e5;
  let lastKept = 0;
  hist.points = hist.points.filter(p => {
    const t = Date.parse(p.t);
    if (t >= cutoff) return true;
    if (t - lastKept >= 3 * 3600e3) { lastKept = t; return true; }
    return false;
  }).slice(-3000);

  await writeJSON('polls.json', pollOut);
  await writeJSON('markets.json', mk);
  await writeJSON('forecast.json', forecast);
  await writeJSON('history.json', hist);
  log('wrote data/forecast.json, polls.json, markets.json, history.json');
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

main().catch(e => { console.error(e); process.exit(1); });
