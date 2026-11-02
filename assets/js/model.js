// Forecast model shared by the data pipeline (Node) and the browser (live election-night mode).
//
// Every race is reduced to one number: the expected margin of the "left" candidate (the Democrat, or an
// independent running as the main opposition to a Republican) over the "right" candidate, in points.
// Four signals estimate that margin and are combined by inverse-variance weighting:
//   fundamentals  2 x Cook PVI + national environment (generic ballot) + incumbency
//   polls         recency / sample-size weighted average of public polls (VoteHub)
//   ratings       average of published forecaster ratings, mapped to a probability, then to a margin
//   markets       Polymarket win probability, mapped to a margin
// Chamber control comes from Monte Carlo simulations with correlated national, regional and state errors.
// On election night, reported votes replace the prior in proportion to the share of the expected vote counted.

export const MODEL = {
  version: '2026.1',
  sims: 20000,
  convSd: 6,                 // points of margin per probit unit when turning probabilities into margins
  natSd: 2.6,                // shared national polling/environment error
  regSd: 1.5,                // Census-region error
  stateSd: 1.6,              // error shared by every race in a state
  floorSd: { senate: 5.0, gov: 5.2, house: 5.6, other: 6.0 },
  inflate: 1.9,              // signals are correlated, so their combined precision is overstated
  fundSd: { senate: 10, gov: 12, house: 7.5, other: 10 },
  incumbency: { senate: 2, gov: 4, house: 3, other: 2.5 },
  ratingP: [[0, 0.5], [0.5, 0.6], [1, 0.72], [2, 0.88], [3, 0.985]],
  pollHalfLife: 12,          // days
  genericHalfLife: 10,
};

// ----------------------------------------------------------------------------------------------- math

export function normCdf(x) {
  // Abramowitz-Stegun 7.1.26 via erf
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
    Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export function normInv(p) {
  // Acklam's rational approximation
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function rng(seed = 2026) {
  let s = seed >>> 0;
  const uni = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u, v, w;
    do { u = uni() * 2 - 1; v = uni() * 2 - 1; w = u * u + v * v; } while (w >= 1 || w === 0);
    const m = Math.sqrt(-2 * Math.log(w) / w);
    spare = v * m;
    return u * m;
  };
  return { uni, normal };
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const kind = (type) => (type === 'senate' || type === 'gov' || type === 'house') ? type : 'other';

// ----------------------------------------------------------------------------------------------- names

export function normName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|sen|rep|gov|dr)\b\.?/g, '').replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function samePerson(a, b) {
  const pa = normName(a).split(' ').filter(Boolean);
  const pb = normName(b).split(' ').filter(Boolean);
  if (!pa.length || !pb.length) return false;
  const la = pa[pa.length - 1], lb = pb[pb.length - 1];
  if (la !== lb) {
    // hyphenated / compound surnames: 'Kamlager-Dove' vs 'Kamlager Dove', 'Debbie Wasserman Schultz'
    const ja = pa.slice(1).join(' '), jb = pb.slice(1).join(' ');
    if (!(ja && jb && (ja.endsWith(lb) || jb.endsWith(la) || ja.replace(/-/g, ' ') === jb.replace(/-/g, ' ')))) return false;
  }
  return pa[0][0] === pb[0][0] || pa.length === 1 || pb.length === 1;
}

// ----------------------------------------------------------------------------------------------- polls

function pollWeight(p, now, halfLife) {
  const end = new Date(p.end_date + 'T12:00:00Z');
  const days = Math.max(0, (now - end) / 864e5);
  const recency = Math.pow(0.5, days / halfLife);
  const n = p.sample_size || 500;
  const size = Math.sqrt(clamp(n, 150, 2500) / 600);
  const pop = { lv: 1, rv: 0.85, v: 0.9, a: 0.6 }[String(p.population || '').toLowerCase()] ?? 0.8;
  const partisan = (p.internal || p.partisan) ? 0.5 : 1;
  return recency * size * pop * partisan;
}

/** Weighted margin (left - right) from polls that include both named candidates. */
export function pollAverage(polls, left, right, now = Date.now(), halfLife = MODEL.pollHalfLife) {
  const rows = [];
  for (const p of polls) {
    let l = null, r = null;
    for (const a of p.answers || []) {
      if (l === null && samePerson(a.choice, left)) l = a.pct;
      else if (r === null && samePerson(a.choice, right)) r = a.pct;
    }
    if (l === null || r === null) continue;
    rows.push({ p, margin: l - r, l, r, w: pollWeight(p, now, halfLife) });
  }
  return summarize(rows);
}

/** Generic ballot / approval style polls: choices are fixed labels. */
export function labelAverage(polls, a, b, now = Date.now(), halfLife = MODEL.genericHalfLife) {
  const rows = [];
  for (const p of polls) {
    const x = (p.answers || []).find(v => v.choice === a);
    const y = (p.answers || []).find(v => v.choice === b);
    if (!x || !y) continue;
    rows.push({ p, margin: x.pct - y.pct, l: x.pct, r: y.pct, w: pollWeight(p, now, halfLife) });
  }
  return summarize(rows);
}

function summarize(rows) {
  if (!rows.length) return null;
  // Repeated polls from one pollster: newest counts fully, each older one half as much as the next.
  rows.sort((x, y) => (y.p.end_date || '').localeCompare(x.p.end_date || ''));
  const seen = {};
  for (const r of rows) {
    const k = r.p.pollster || '?';
    seen[k] = (seen[k] || 0) + 1;
    r.w *= Math.pow(0.5, seen[k] - 1);
  }
  const W = rows.reduce((s, r) => s + r.w, 0);
  if (W <= 0) return null;
  const margin = rows.reduce((s, r) => s + r.w * r.margin, 0) / W;
  const l = rows.reduce((s, r) => s + r.w * r.l, 0) / W;
  const r = rows.reduce((s, r2) => s + r2.w * r2.r, 0) / W;
  return { margin, left: l, right: r, neff: W, n: rows.length, latest: rows[0].p.end_date };
}

// ----------------------------------------------------------------------------------------------- signals

export function ratingProb(score) {
  const s = Math.abs(score);
  const pts = MODEL.ratingP;
  let p = pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    if (s <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      p = y0 + (y1 - y0) * (s - x0) / (x1 - x0);
      break;
    }
  }
  return score >= 0 ? p : 1 - p;
}

/** Ratings use D-positive scores; flip the sign when an independent is the left candidate and is rated as 'I'. */
function ratingScoreFor(race) {
  const rs = Object.values(race.ratings || {});
  if (!rs.length) return null;
  const vals = rs.map(r => {
    if (r.side === 'R') return r.score;
    if (r.side === 'D') return race.leftParty === 'D' || !race.leftParty ? r.score : (race.rightParty === 'D' ? -r.score : r.score);
    if (r.side === 'I') return race.leftParty === 'I' ? Math.abs(r.score) : race.rightParty === 'I' ? -Math.abs(r.score) : 0;
    return r.score; // toss-up (0)
  });
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Pre-election estimate for one race.
 * inputs: { poll: pollAverage() | null, market: { pLeft, volume } | null }
 * env:    { generic: national environment, D-minus-R points }
 */
export function estimateRace(race, inputs, env) {
  const k = kind(race.type);
  const out = { id: race.id, components: {} };

  // Uncontested or same-party general: the outcome for the party is settled.
  if (!race.left || !race.right) {
    const p = race.left ? 1 : 0;
    return { ...out, mu: race.left ? 40 : -40, sd: 1, pLeft: p, settled: true };
  }

  const comps = [];
  const lean = race.pvi ?? 0;
  const dVsR = race.leftParty === 'D' && race.rightParty === 'R';
  let fund = 2 * lean + env.generic;
  if (!dVsR) {
    if (race.leftParty === 'D') fund = 2 * lean + env.generic - 3;              // Democrat vs. independent
    else if (race.rightParty === 'R') fund = 2 * lean + 0.5 * env.generic + 4;  // independent vs. Republican
    else fund = 0;
  }
  const inc = (race.candidates || []).find(c => c.incumbent);
  if (inc) fund += (inc.name === race.left ? 1 : inc.name === race.right ? -1 : 0) * MODEL.incumbency[k];
  comps.push({ key: 'fundamentals', m: fund, sd: dVsR ? MODEL.fundSd[k] : 14 });

  const poll = inputs.poll;
  if (poll && poll.neff > 0.15) {
    const sd = Math.sqrt(25 / poll.neff + 12);
    comps.push({ key: 'polls', m: poll.margin, sd, n: poll.n, neff: poll.neff });
  }

  const rScore = ratingScoreFor(race);
  if (rScore !== null) {
    const n = Object.keys(race.ratings || {}).length;
    const p = ratingProb(rScore);
    comps.push({ key: 'ratings', m: MODEL.convSd * normInv(clamp(p, 0.01, 0.99)), sd: n >= 3 ? 5 : 6.5, p, score: rScore, n });
  }

  const mk = inputs.market;
  if (mk && mk.pLeft !== null && mk.pLeft !== undefined && (mk.volume || 0) > 2000) {
    const p = clamp(mk.pLeft, 0.01, 0.99);
    const vol = Math.max(1, mk.volume || 1);
    const sd = 4.5 + 3.5 * clamp((6 - Math.log10(vol)) / 2, 0, 1);
    comps.push({ key: 'market', m: MODEL.convSd * normInv(p), sd, p: mk.pLeft, volume: mk.volume });
  }

  // Ratings and markets saturate near certainty ("Safe R", 99 cents), so they only say the margin is at
  // least that large. When they agree with the fundamentals, let the fundamentals set the size.
  for (const c of comps) {
    if ((c.key === 'ratings' || c.key === 'market') && (c.p >= 0.96 || c.p <= 0.04) && Math.sign(fund) === Math.sign(c.m)) {
      c.m = Math.sign(c.m) * Math.max(Math.abs(c.m), 0.8 * Math.abs(fund));
    }
  }

  let wsum = 0, msum = 0;
  for (const c of comps) {
    const w = 1 / (c.sd * c.sd);
    c.w = w;
    wsum += w;
    msum += w * c.m;
  }
  const mu = msum / wsum;
  const sd = Math.max(MODEL.floorSd[k], MODEL.inflate / Math.sqrt(wsum));
  for (const c of comps) {
    out.components[c.key] = { margin: round(c.m, 2), weight: round(c.w / wsum, 3),
      ...(c.p !== undefined ? { p: round(c.p, 4) } : {}), ...(c.n !== undefined ? { n: c.n } : {}),
      ...(c.volume !== undefined ? { volume: Math.round(c.volume) } : {}), ...(c.score !== undefined ? { score: round(c.score, 2) } : {}) };
  }
  return { ...out, mu: round(mu, 2), sd: round(sd, 2), pLeft: round(normCdf(mu / sd), 4) };
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

// ----------------------------------------------------------------------------------------------- live

/**
 * Blend reported votes into a race estimate. live: { eevp (0-100), left, right, total, called: 'left'|'right'|null }
 * swing: estimated national shift (points, left-positive) inferred from races that are mostly counted.
 */
export function liveEstimate(est, live, swing = 0, swingSd = MODEL.natSd) {
  if (!live || est.settled) return est;
  if (live.called === 'left' || live.called === 'right') {
    const p = live.called === 'left' ? 1 : 0;
    return { ...est, live: true, called: live.called, pLeft: p, mu: liveMargin(live) ?? est.mu, sd: 0.5, eevp: live.eevp };
  }
  const f = clamp((live.eevp || 0) / 100, 0, 1);
  if (!live.total || f <= 0) {
    const mu = est.mu + swing;
    const sd = Math.sqrt(Math.max(0, est.sd ** 2 - MODEL.natSd ** 2) + swingSd ** 2);
    return { ...est, live: true, mu: round(mu, 2), sd: round(sd, 2), pLeft: round(normCdf(mu / sd), 4), eevp: 0 };
  }
  const cur = liveMargin(live);
  const remMu = est.mu + swing;
  const remSd = Math.sqrt(Math.max(0, est.sd ** 2 - MODEL.natSd ** 2) + swingSd ** 2 + 36); // late ballots skew
  const mu = f * cur + (1 - f) * remMu;
  const sd = Math.sqrt(((1 - f) * remSd) ** 2 + (1.5 * (1 - f)) ** 2 + 0.3 ** 2);
  return { ...est, live: true, mu: round(mu, 2), sd: round(sd, 2), pLeft: round(normCdf(mu / sd), 4), eevp: live.eevp, current: round(cur, 2) };
}

export function liveMargin(live) {
  if (!live || !live.total) return null;
  return 100 * (live.left - live.right) / live.total;
}

/** National swing vs. prior from races with most of their vote in (weighted median, shrunk toward 0). */
export function estimateSwing(pairs) {
  const rows = pairs.filter(x => x.live && x.live.total > 0 && x.live.eevp >= 60 && !x.est.settled)
    .map(x => ({ s: liveMargin(x.live) - x.est.mu, w: x.live.eevp / 100 }));
  if (rows.length < 3) return { swing: 0, sd: MODEL.natSd, n: rows.length };
  rows.sort((a, b) => a.s - b.s);
  const W = rows.reduce((t, r) => t + r.w, 0);
  let acc = 0, med = rows[0].s;
  for (const r of rows) { acc += r.w; if (acc >= W / 2) { med = r.s; break; } }
  const shrink = rows.length / (rows.length + 6);
  return { swing: round(med * shrink, 2), sd: round(Math.max(0.8, MODEL.natSd / Math.sqrt(1 + rows.length / 4)), 2), n: rows.length };
}

// ----------------------------------------------------------------------------------------------- simulation

/**
 * races: [{ id, type, state, region, holder, leftParty, rightParty, caucusLeft?, caucusRight? }]
 * ests:  { id: { mu, sd, pLeft, settled, called } }
 * chambers: races.json chambers block
 */
export function simulate(races, ests, chambers, opts = {}) {
  const N = opts.sims || MODEL.sims;
  const natSd = opts.natSd ?? MODEL.natSd;
  const natMu = opts.natMu ?? 0;
  const withTipping = opts.tipping !== false;
  const R = rng(opts.seed || 2026);
  const groups = { senate: [], house: [], gov: [] };
  for (const r of races) if (groups[r.type] && ests[r.id]) groups[r.type].push(r);

  const all = [...groups.senate, ...groups.house, ...groups.gov];
  const n = all.length;
  const regions = [...new Set(all.map(r => r.region))];
  const states = [...new Set(all.map(r => r.state))];
  const regIdx = Object.fromEntries(regions.map((r, i) => [r, i]));
  const stIdx = Object.fromEntries(states.map((s, i) => [s, i]));
  const shared = natSd ** 2 + MODEL.regSd ** 2 + MODEL.stateSd ** 2;

  const mu = new Float64Array(n), resid = new Float64Array(n), wShared = new Float64Array(n);
  const rg = new Int32Array(n), st = new Int32Array(n), typ = new Int8Array(n);
  const fixed = new Int8Array(n); // 1 left wins, -1 right wins, 0 simulate
  const leftSeat = [], rightSeat = [], holder = [];
  all.forEach((r, i) => {
    const e = ests[r.id];
    mu[i] = e.mu;
    // Live races: the counted vote no longer moves with the national error, only the uncounted share does.
    const w = e.live ? Math.max(0, 1 - (e.eevp || 0) / 100) : 1;
    wShared[i] = w;
    resid[i] = Math.sqrt(Math.max(0.25, e.sd ** 2 - w * w * shared));
    rg[i] = regIdx[r.region];
    st[i] = stIdx[r.state];
    typ[i] = r.type === 'senate' ? 0 : r.type === 'house' ? 1 : 2;
    if (e.settled || e.called) fixed[i] = e.pLeft >= 0.5 ? 1 : -1;
    leftSeat.push(r.caucusLeft || r.leftParty);
    rightSeat.push(r.caucusRight || r.rightParty);
    holder.push(r.holder);
  });
  const senIdx = groups.senate.map(r => all.indexOf(r));
  const houseIdx = groups.house.map(r => all.indexOf(r));

  const tally = {
    senate: { D: new Int32Array(101), control: { D: 0, R: 0 }, tip: {} },
    house: { D: new Int32Array(436), control: { D: 0, R: 0 }, tip: {} },
    gov: { D: new Int32Array(51), control: { D: 0, R: 0 } },
  };
  const wins = new Float64Array(n);
  const margins = new Float64Array(n);
  const flips = { senate: new Int32Array(N), house: new Int32Array(N), gov: new Int32Array(N) };
  const regErr = new Float64Array(regions.length), stErr = new Float64Array(states.length);
  const dGovBase = Object.values(chambers.governors.notUp || {}).filter(v => v === 'D').length;

  for (let s = 0; s < N; s++) {
    const nat = natMu + natSd * R.normal();
    for (let j = 0; j < regions.length; j++) regErr[j] = MODEL.regSd * R.normal();
    for (let j = 0; j < states.length; j++) stErr[j] = MODEL.stateSd * R.normal();
    let dSen = chambers.senate.notUp.D, rSen = chambers.senate.notUp.R, dHouse = 0, rHouse = 0, dGov = dGovBase;
    let fSen = 0, fHouse = 0, fGov = 0;
    for (let i = 0; i < n; i++) {
      let leftWins;
      if (fixed[i]) {
        leftWins = fixed[i] > 0;
        margins[i] = leftWins ? Math.max(mu[i], 0.01) : Math.min(mu[i], -0.01);
      } else {
        const m = mu[i] + wShared[i] * (nat + regErr[rg[i]] + stErr[st[i]]) + resid[i] * R.normal();
        margins[i] = m;
        leftWins = m > 0;
      }
      if (leftWins) wins[i]++;
      const party = leftWins ? leftSeat[i] : rightSeat[i];
      const flipped = holder[i] && party !== holder[i];
      if (typ[i] === 0) { if (party === 'D') dSen++; else if (party === 'R') rSen++; if (flipped) fSen++; }
      else if (typ[i] === 1) { if (party === 'D') dHouse++; else if (party === 'R') rHouse++; if (flipped) fHouse++; }
      else { if (party === 'D') dGov++; if (flipped) fGov++; }
    }
    tally.senate.D[Math.min(100, dSen)]++;
    tally.house.D[Math.min(435, dHouse)]++;
    tally.gov.D[Math.min(50, dGov)]++;
    // Senate: Democrats need 51 (the Republican vice president breaks ties). House: 218.
    if (dSen >= 51) tally.senate.control.D++; else if (rSen >= 50) tally.senate.control.R++;
    if (dHouse >= 218) tally.house.control.D++; else if (rHouse >= 218) tally.house.control.R++;
    if (dGov >= 26) tally.gov.control.D++; else tally.gov.control.R++;
    flips.senate[s] = fSen; flips.house[s] = fHouse; flips.gov[s] = fGov;
    if (withTipping) {
      tippingPoint(senIdx, all, margins, leftSeat, rightSeat, tally.senate.tip, chambers.senate.notUp.D, 51, chambers.senate.notUp.R, 50, dSen >= 51, rSen >= 50);
      tippingPoint(houseIdx, all, margins, leftSeat, rightSeat, tally.house.tip, 0, 218, 0, 218, dHouse >= 218, rHouse >= 218);
    }
  }

  const raceProb = {};
  all.forEach((r, i) => { raceProb[r.id] = round(wins[i] / N, 4); });
  const summary = (t, size) => {
    const hist = Array.from(t.D);
    return {
      pD: round(t.control.D / N, 4), pR: round(t.control.R / N, 4),
      pNeither: round(1 - (t.control.D + t.control.R) / N, 4),
      dSeats: { mean: round(meanHist(hist), 2), median: quantHist(hist, 0.5), p10: quantHist(hist, 0.1), p90: quantHist(hist, 0.9), p025: quantHist(hist, 0.025), p975: quantHist(hist, 0.975) },
      hist: trimHist(hist), size,
      tipping: withTipping && t.tip ? Object.fromEntries(Object.entries(t.tip).map(([k, v]) => [k, round(v / N, 4)]).sort((a, b) => b[1] - a[1]).slice(0, 25)) : undefined,
    };
  };
  return {
    sims: N,
    senate: summary(tally.senate, 100),
    house: summary(tally.house, 435),
    gov: summary(tally.gov, 50),
    flips: { senate: flipStats(flips.senate), house: flipStats(flips.house), gov: flipStats(flips.gov) },
    raceProb,
  };
}

/** The race that delivers the majority when races are lined up from most left-leaning to most right-leaning. */
function tippingPoint(idx, all, margins, leftSeat, rightSeat, tip, dBase, dNeed, rBase, rNeed, dCtl, rCtl) {
  if (!idx.length || (!dCtl && !rCtl)) return;
  const order = idx.slice().sort((a, b) => margins[b] - margins[a]);
  if (dCtl) {
    let d = dBase;
    for (const i of order) {
      if (margins[i] > 0 ? leftSeat[i] === 'D' : rightSeat[i] === 'D') d++;
      if (d >= dNeed) { tip[all[i].id] = (tip[all[i].id] || 0) + 1; return; }
    }
  } else {
    let r = rBase;
    for (let k = order.length - 1; k >= 0; k--) {
      const i = order[k];
      if (margins[i] > 0 ? leftSeat[i] === 'R' : rightSeat[i] === 'R') r++;
      if (r >= rNeed) { tip[all[i].id] = (tip[all[i].id] || 0) + 1; return; }
    }
  }
}

function meanHist(h) { let s = 0, n = 0; h.forEach((c, i) => { s += c * i; n += c; }); return n ? s / n : 0; }
function quantHist(h, q) {
  const n = h.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < h.length; i++) { acc += h[i]; if (acc >= q * n) return i; }
  return h.length - 1;
}
function trimHist(h) {
  let lo = 0, hi = h.length - 1;
  while (lo < hi && h[lo] === 0) lo++;
  while (hi > lo && h[hi] === 0) hi--;
  const n = h.reduce((a, b) => a + b, 0) || 1;
  return { start: lo, p: h.slice(lo, hi + 1).map(c => round(c / n, 5)) };
}
function flipStats(arr) {
  const s = Array.from(arr).sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { median: q(0.5), p10: q(0.1), p90: q(0.9) };
}

/**
 * One correlated draw of every race's final margin, with the same error structure as simulate().
 * nat: fix the national polling error (left-positive points) instead of drawing it.
 */
export function drawMargins(races, ests, R, { nat = null } = {}) {
  const natErr = nat !== null && nat !== undefined ? nat : MODEL.natSd * R.normal();
  const reg = {}, st = {};
  const shared = MODEL.natSd ** 2 + MODEL.regSd ** 2 + MODEL.stateSd ** 2;
  const margins = {};
  for (const r of races) {
    const e = ests[r.id];
    if (!e) continue;
    if (e.settled) { margins[r.id] = e.mu; continue; }
    if (reg[r.region] === undefined) reg[r.region] = MODEL.regSd * R.normal();
    if (st[r.state] === undefined) st[r.state] = MODEL.stateSd * R.normal();
    const resid = Math.sqrt(Math.max(0.25, e.sd ** 2 - shared));
    margins[r.id] = e.mu + natErr + reg[r.region] + st[r.state] + resid * R.normal();
  }
  return { margins, nat: natErr };
}

// ----------------------------------------------------------------------------------------------- display helpers

export const RATING_BANDS = [
  { min: 0.99, key: 'solid' }, { min: 0.85, key: 'likely' }, { min: 0.65, key: 'lean' }, { min: 0.0, key: 'tossup' },
];

/** Probability for left side -> { side: 'left'|'right'|null, band: 'solid'|'likely'|'lean'|'tossup' } */
export function band(pLeft) {
  const p = Math.max(pLeft, 1 - pLeft);
  const side = pLeft === 0.5 ? null : pLeft > 0.5 ? 'left' : 'right';
  if (p >= 0.97) return { side, band: 'solid' };
  if (p >= 0.85) return { side, band: 'likely' };
  if (p >= 0.65) return { side, band: 'lean' };
  return { side, band: 'tossup' };
}
