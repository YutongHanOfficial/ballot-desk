// SVG charts (D3 is loaded globally from assets/vendor).
import { h, s, pct, partyVar, probColor, tooltip, esc, lastName, marginText, fmtDate, compact, PARTY_NAME } from './ui.js';
import { store, cur, awaiting, raceFill, nightMode, duelNow, leadFill } from './store.js';
import { pollCloseDate } from './config.js';

const d3 = window.d3;
const topojson = window.topojson;

/** Two-sided bar of control probabilities. */
export function splitBar(pD, pR, { pO = 0, height = 12 } = {}) {
  return h('div', { class: 'split-bar', style: { height: `${height}px` } },
    h('span', { style: { width: `${pD * 100}%`, background: 'var(--dem)' } }),
    pO > 0.001 ? h('span', { style: { width: `${pO * 100}%`, background: 'var(--oth)' } }) : null,
    h('span', { style: { width: `${pR * 100}%`, background: 'var(--rep)', marginLeft: 'auto' } }));
}

/** Compact probability bar for tables: left side fills from the left, right side from the right. */
export function probMini(pLeft, race) {
  const p = pLeft ?? 0.5;
  const el = h('span', { class: 'pbar', 'aria-hidden': 'true' });
  if (p >= 0.5) el.appendChild(h('i', { style: { left: 0, width: `${p * 100}%`, background: partyVar(race.leftParty) } }));
  else el.appendChild(h('i', { style: { right: 0, width: `${(1 - p) * 100}%`, background: partyVar(race.rightParty) } }));
  return el;
}

export function probCell(race, c = cur(race)) {
  if (race.duel) {
    const d = duelNow(race);
    const q = d.called ? 1 : Math.min(0.999, Math.max(d.pA, 1 - d.pA));
    return h('div', { class: 'prob-cell' },
      h('span', { class: 'pbar', 'aria-hidden': 'true' }, h('i', { style: { left: 0, width: `${q * 100}%`, background: partyVar(d.party) } })),
      h('span', { class: 'v', style: { color: partyVar(d.party) } }, `${lastName(d.pA >= 0.5 ? d.a : d.b)} ${pct(q)}`));
  }
  const p = c.p;
  if (p === null || p === undefined) return h('span', { class: 'muted' }, '—');
  const fav = p >= 0.5 ? race.leftParty : race.rightParty;
  const favName = p >= 0.5 ? race.left : race.right;
  const v = c.called ? 1 : Math.min(0.999, Math.max(p, 1 - p));
  const label = fav === 'D' || fav === 'R' ? fav : lastName(favName);
  return h('div', { class: 'prob-cell' },
    probMini(p, race),
    h('span', { class: 'v', style: { color: partyVar(fav) } }, `${label} ${pct(v)}`));
}

// ------------------------------------------------------------------------------------- histogram

/** Seat distribution. hist = { start, p: [...] } of Democratic seats; threshold = seats for a D majority. */
export function histogram(hist, { threshold, total, width = 640, height = 220, xLabel = 'Democratic seats', mark = null, markLabel = 'This simulation' } = {}) {
  const tip = tooltip();
  const xs = hist.p.map((_, i) => hist.start + i);
  const lo = Math.max(0, Math.min(xs[0], threshold - 3)), hi = Math.min(total, Math.max(xs[xs.length - 1], threshold + 3));
  const m = { t: 18, r: 10, b: 34, l: 10 };
  const x = d3.scaleBand().domain(d3.range(lo, hi + 1)).range([m.l, width - m.r]).paddingInner(0.12);
  const ymax = d3.max(hist.p) || 0.01;
  const y = d3.scaleLinear().domain([0, ymax * 1.08]).range([height - m.b, m.t]);
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${xLabel} distribution` });
  for (let v = lo; v <= hi; v++) {
    const p = hist.p[v - hist.start] || 0;
    if (!p) continue;
    const dem = v >= threshold;
    const rect = s('rect', { x: x(v), y: y(p), width: Math.max(1, x.bandwidth()), height: Math.max(0.5, y(0) - y(p)), rx: x.bandwidth() > 6 ? 1.5 : 0,
      fill: dem ? 'var(--dem)' : 'var(--rep)', opacity: 0.88 });
    rect.addEventListener('mousemove', (e) => tip.show(`<div class="tt-title">${v} Democratic seats</div><div class="tt-row"><span>Chance</span><b>${pct(p, { digits: 1 })}</b></div><div class="tt-row"><span>Republican seats</span><b>${total - v}</b></div>`, e));
    rect.addEventListener('mouseleave', () => tip.hide());
    svg.appendChild(rect);
  }
  // majority line
  const tx = x(threshold) - x.step() * x.paddingInner() / 2;
  svg.appendChild(s('line', { x1: tx, x2: tx, y1: m.t - 8, y2: height - m.b + 4, stroke: 'var(--ink)', 'stroke-width': 1.5, 'stroke-dasharray': '3 3' }));
  svg.appendChild(s('text', { x: tx + 5, y: m.t - 2, class: 'label-strong' }, `${threshold} for majority`));
  // axis ticks
  const step = (hi - lo) > 60 ? 10 : (hi - lo) > 24 ? 5 : 2;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    svg.appendChild(s('text', { x: x(v) + x.bandwidth() / 2, y: height - m.b + 16, 'text-anchor': 'middle' }, v));
  }
  svg.appendChild(s('line', { x1: m.l, x2: width - m.r, y1: y(0), y2: y(0), stroke: 'var(--line-2)' }));
  svg.appendChild(s('text', { x: width / 2, y: height - 4, 'text-anchor': 'middle' }, xLabel));
  if (mark !== null && mark >= lo && mark <= hi) {
    const mx = x(mark) + x.bandwidth() / 2;
    svg.appendChild(s('line', { x1: mx, x2: mx, y1: m.t + 10, y2: y(0), stroke: 'var(--gold)', 'stroke-width': 3 }));
    svg.appendChild(s('circle', { cx: mx, cy: m.t + 10, r: 4.5, fill: 'var(--gold)' }));
    const leftSide = mark < threshold;   // keep clear of the majority label, which sits right of its line
    svg.appendChild(s('text', { x: mx + (leftSide ? -8 : 8), y: m.t + 14, 'text-anchor': leftSide ? 'end' : 'start', style: 'fill:var(--gold);font-weight:700' }, markLabel));
  }
  return h('div', { class: 'chart' }, svg);
}

// ------------------------------------------------------------------------------------- US map

const FIPS_TO_CODE = {};
export function usMap({ fill, onClick, tip: tipFn, height = 380, labels = true, stroke, mark } = {}) {
  if (!Object.keys(FIPS_TO_CODE).length) for (const st of store.states) FIPS_TO_CODE[st.fips] = st.code;
  const tip = tooltip();
  const geo = store.geo;
  const states = topojson.feature(geo, geo.objects.states).features;
  const path = d3.geoPath();
  const svg = s('svg', { viewBox: '0 0 975 610', role: 'img', 'aria-label': 'Map of the United States' });
  const g = s('g');
  svg.appendChild(g);
  for (const f of states) {
    const code = FIPS_TO_CODE[f.id];
    if (!code) continue;
    const color = fill(code);
    const active = !!onClick && color !== null;
    const p = s('path', { d: path(f), class: `state${active ? '' : ' inactive'}`, fill: color || 'var(--norace)', 'data-state': code });
    if (stroke) p.setAttribute('stroke', stroke(code) || 'var(--surface)');
    if (tipFn) {
      p.addEventListener('mousemove', (e) => { const html = tipFn(code); if (html) tip.show(html, e); });
      p.addEventListener('mouseleave', () => tip.hide());
    }
    if (active) p.addEventListener('click', () => { tip.hide(); onClick(code); });
    g.appendChild(p);
  }
  // A check mark on each projected state (the small north-eastern ones get it in their callout box instead).
  const CALLOUTS = ['VT', 'NH', 'MA', 'RI', 'CT', 'NJ', 'DE', 'MD'];
  if (mark) {
    const checks = s('g', { class: 'map-checks', 'pointer-events': 'none' });
    for (const f of states) {
      const code = FIPS_TO_CODE[f.id];
      if (!code || CALLOUTS.includes(code) || code === 'DC' || !mark(code)) continue;
      const [cx, cy] = CHECK_AT[code] || path.centroid(f);
      checks.appendChild(s('text', { x: cx, y: cy, class: 'map-check' }, '✓'));
    }
    g.appendChild(checks);
  }
  // outline of the nation for crisp edges
  g.appendChild(s('path', { d: path(topojson.mesh(geo, geo.objects.states, (a, b) => a !== b)), fill: 'none', stroke: 'var(--surface)', 'stroke-width': 0.8, 'pointer-events': 'none' }));
  if (labels) {
    // Small north-eastern states get callout boxes out in the Atlantic, clear of the coast, so they can be seen
    // and tapped: box first, label to its right.
    let yy = 206;
    for (const code of CALLOUTS) {
      const color = fill(code);
      const box = s('g', { transform: `translate(914, ${yy})`, style: onClick && color !== null ? 'cursor:pointer' : '' });
      box.appendChild(s('rect', { width: 18, height: 14, rx: 3, fill: color || 'var(--norace)', stroke: 'var(--line-2)', 'stroke-width': 0.5 }));
      if (mark && mark(code)) box.appendChild(s('text', { x: 9, y: 7.5, class: 'map-check small' }, '✓'));
      box.appendChild(s('text', { x: 23, y: 11, style: 'font-size:11px;font-weight:600' }, code));
      if (tipFn) { box.addEventListener('mousemove', (e) => { const html = tipFn(code); if (html) tip.show(html, e); }); box.addEventListener('mouseleave', () => tip.hide()); }
      if (onClick && color !== null) box.addEventListener('click', () => { tip.hide(); onClick(code); });
      svg.appendChild(box);
      yy += 20;
    }
  }
  return h('div', { class: 'map-wrap chart' }, svg);
}

// Where a check mark sits when a state's centroid is awkward (Florida's falls in the Gulf side, Michigan's in the lake).
const CHECK_AT = {};

export function mapLegend(items) {
  return h('div', { class: 'legend' }, items.map(([color, label]) => h('span', null, h('i', { style: { background: color } }), label)));
}

export const RESULT_LEGEND = [
  ['var(--dem)', 'Dem. projected'], [leadFill('D', 7), 'Dem. leading'], [leadFill('R', 7), 'Rep. leading'], ['var(--rep)', 'Rep. projected'],
  ['var(--ind)', 'Ind. projected'], ['var(--novotes)', 'No votes counted'], ['var(--await)', 'Polls still open'], ['var(--norace)', 'No race'],
];

/** Forecast bands before results; won/leading once election-night results flow. */
export function currentLegend() { return nightMode() ? RESULT_LEGEND : BAND_LEGEND.slice(0, 8); }

/**
 * Election-night key as one scale: projected (with the check), then leads from big to small for each side,
 * then the greys. Shared by the site's maps and the broadcast.
 */
export function resultScale() {
  const cells = [
    ['var(--dem)', '✓', 'Called'], [leadFill('D', 12), '10+'], [leadFill('D', 7), '5–10'], [leadFill('D', 3), '2–5'], [leadFill('D', 1), '<2'],
    [leadFill('R', 1), '<2'], [leadFill('R', 3), '2–5'], [leadFill('R', 7), '5–10'], [leadFill('R', 12), '10+'], ['var(--rep)', '✓', 'Called'],
  ];
  return h('div', { class: 'rscale' },
    h('div', { class: 'rs-main' },
      h('div', { class: 'rs-cap' }, h('span', { class: 'c-dem' }, 'Democrat'), h('span', null, 'leading by (points)'), h('span', { class: 'c-rep' }, 'Republican')),
      h('div', { class: 'rs-bar' }, cells.map(([c, t]) => h('span', { style: { background: c } }, t === '✓' ? h('b', null, '✓') : null))),
      h('div', { class: 'rs-labels' }, cells.map(([, t, l]) => h('span', null, l || t)))),
    h('div', { class: 'rs-grey' }, [['var(--novotes)', 'No votes yet'], ['var(--await)', 'Polls open'], ['var(--norace)', 'No race']]
      .map(([c, l]) => h('span', null, h('i', { style: { background: c } }), l))));
}

/** The right key for maps coloured by raceFill right now. */
export function currentLegendEl() { return nightMode() ? resultScale() : mapLegend(BAND_LEGEND.slice(0, 8)); }

export const BAND_LEGEND = [
  ['var(--dem)', 'Solid D'], ['var(--dem-2)', 'Likely D'], ['var(--dem-3)', 'Lean D'], ['var(--toss)', 'Toss-up'],
  ['var(--rep-3)', 'Lean R'], ['var(--rep-2)', 'Likely R'], ['var(--rep)', 'Solid R'], ['var(--ind)', 'Independent'], ['var(--none)', 'No race'],
];

// ------------------------------------------------------------------------------------- seat strip

/** Every race lined up from safest left to safest right, with the majority marker. */
export function seatStrip(races, { need, base = 0, height = 34, majorityLabel } = {}) {
  const tip = tooltip();
  const rows = races.map(r => ({ r, c: cur(r) })).map(x => ({ ...x, dp: dProb(x.r, x.c.p), dd: dShare(x.r, x.c.p) }))
    .sort((a, b) => (b.dp - a.dp) || (b.dd - a.dd));
  const strip = h('div', { class: 'seat-strip', style: { height: `${height}px`, gap: rows.length > 120 ? '0' : '2px' } });
  rows.forEach(({ r, c }) => {
    const a = h('a', { href: r.url, style: { background: raceFill(r), borderRadius: rows.length > 120 ? '0' : null }, 'aria-label': r.title });
    a.addEventListener('mousemove', (e) => tip.show(raceTip(r), e));
    a.addEventListener('mouseleave', () => tip.hide());
    strip.appendChild(a);
  });
  const wrap = h('div', { class: 'strip-wrap' }, strip);
  const idx = need - base; // the seat that delivers the majority
  if (idx > 0 && idx <= rows.length) {
    const left = (idx - 0.5) / rows.length * 100;
    wrap.appendChild(h('div', { class: 'strip-mark', style: { left: `calc(${left}% - 1px)` } }, h('span', null, majorityLabel || `Seat ${need}`)));
  }
  return h('div', null, wrap,
    h('div', { class: 'strip-labels' }, h('span', null, 'Most likely Democratic'), h('span', null, 'Most likely Republican')));
}

// Chance the seat does not go Republican. Sorting by it follows the colours: an independent or an unopposed
// Republican with no real chance sits with the safe Republican seats, not in the middle of the strip.
function dProb(r, p) {
  if (p === null || p === undefined) return 0.5;
  return 1 - (r.left && r.leftParty === 'R' ? p : 0) - (r.right && r.rightParty === 'R' ? 1 - p : 0);
}

// Chance a Democrat wins: breaks ties among the seats Republicans cannot win.
function dShare(r, p) {
  if (p === null || p === undefined) return 0.5;
  return (r.left && r.leftParty === 'D' ? p : 0) + (r.right && r.rightParty === 'D' ? 1 - p : 0);
}

export function raceTip(r) {
  if (awaiting(r)) {
    const d = store.sim ? null : pollCloseDate(r.state);
    return `<div class="tt-title">${esc(r.title)}</div><div class="muted">Polls have not closed yet${d ? ` (${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET)` : ''}.</div>`;
  }
  const c = cur(r);
  const p = c.p ?? 0.5;
  const rows = [];
  const line = (name, party, prob, votes) => `<div class="tt-row"><span><span class="party-chip ${party || 'O'}" style="margin-right:6px">${party || '?'}</span>${esc(name || '—')}</span><b>${votes !== undefined ? votes : pct(prob)}</b></div>`;
  // "D 87%" for whichever side a probability favours (names for independents)
  const fav = (q) => { const party = q >= 0.5 ? r.leftParty : r.rightParty; return `${party === 'D' || party === 'R' ? party : lastName(q >= 0.5 ? r.left : r.right)} ${pct(Math.min(0.999, Math.max(q, 1 - q)))}`; };
  if (r.duel) {
    // Same-party race: the two candidates' chances, or their share of the count.
    const d = duelNow(r);
    const v = d.result, tot = v?.total || 0;
    const q = (x) => pct(Math.min(0.999, Math.max(0.001, x)));
    const share = (x) => `${((x / tot) * 100).toFixed(1)}%<span class="tt-sub">${x.toLocaleString('en-US')}</span>`;
    const favName = d.pA >= 0.5 ? d.a : d.b;
    rows.push(line(d.a, d.party, null, tot ? share(v.a) : q(d.pA)), line(d.b, d.party, null, tot ? share(v.b) : q(1 - d.pA)));
    rows.push(tot
      ? `<div class="tt-row muted"><span>${Math.round(v.eevp)}% of expected vote</span><span>${d.called ? 'Called' : `Live odds ${esc(lastName(favName))} ${q(Math.max(d.pA, 1 - d.pA))}`}</span></div>`
      : `<div class="tt-row muted"><span>Both ${PARTY_NAME[d.party]}s</span><span>${d.party} hold either way</span></div>`);
    if (d.marketA !== null && !store.sim && !d.called) rows.push(`<div class="tt-row muted"><span>Polymarket</span><span>${esc(lastName(d.marketA >= 0.5 ? d.a : d.b))} ${q(Math.max(d.marketA, 1 - d.marketA))}</span></div>`);
    return `<div class="tt-title">${esc(r.title)}</div>${rows.join('')}`;
  }
  if (r.left && r.right && c.result && c.result.total > 0) {
    const res = c.result, tot = res.total;
    const share = (v) => `${((v / tot) * 100).toFixed(1)}%<span class="tt-sub">${v.toLocaleString('en-US')}</span>`;
    rows.push(line(r.left, r.leftParty, null, share(res.left)));
    rows.push(line(r.right, r.rightParty, null, share(res.right)));
    rows.push(`<div class="tt-row muted"><span>${Math.round(c.eevp)}% of expected vote</span><span>${res.called ? 'Called' : `Live odds ${fav(p)}`}</span></div>`);
  } else if (r.left && r.right) {
    rows.push(line(r.left, r.leftParty, p));
    rows.push(line(r.right, r.rightParty, 1 - p));
    rows.push(`<div class="tt-row muted"><span>Projected margin</span><span>${marginText(c.mu, r)}</span></div>`);
  } else {
    rows.push(`<div class="muted">${r.samePartyGeneral ? `Two ${PARTY_NAME[r.samePartyGeneral]}s on the ballot` : 'Uncontested by a major party'}</div>`);
  }
  if (r.left && r.right && c.marketP !== null && c.marketP !== undefined && !store.sim && !c.result?.called) rows.push(`<div class="tt-row muted"><span>Polymarket</span><span>${fav(c.marketP)}</span></div>`);
  return `<div class="tt-title">${esc(r.title)}</div>${rows.join('')}`;
}

// ------------------------------------------------------------------------------------- line chart

/** Forecast history: series = [{ key, label, color, dash }] over points [{ t, ...}] (probabilities 0-1). */
export function historyChart(points, series, { width = 640, height = 220, yDomain = [0, 1], yFormat = (v) => pct(v), area = false } = {}) {
  const tip = tooltip();
  const m = { t: 14, r: 50, b: 26, l: 8 };
  const pts = points.map(p => ({ ...p, d: new Date(p.t) }));
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}` });
  if (pts.length < 2) {
    svg.appendChild(s('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle' }, 'The forecast history fills in as the model re-runs.'));
    return h('div', { class: 'chart' }, svg);
  }
  const x = d3.scaleTime().domain(d3.extent(pts, p => p.d)).range([m.l, width - m.r]);
  const y = d3.scaleLinear().domain(yDomain).range([height - m.b, m.t]);
  for (const v of y.ticks(4)) {
    svg.appendChild(s('line', { x1: m.l, x2: width - m.r, y1: y(v), y2: y(v), stroke: 'var(--line)' }));
    svg.appendChild(s('text', { x: width - m.r + 10, y: y(v) + 4 }, yFormat(v)));
  }
  if (yDomain[0] === 0 && yDomain[1] === 1) svg.appendChild(s('line', { x1: m.l, x2: width - m.r, y1: y(0.5), y2: y(0.5), stroke: 'var(--line-2)', 'stroke-dasharray': '3 3' }));
  const spanDays = (x.domain()[1] - x.domain()[0]) / 864e5;
  const tickFmt = (t) => spanDays < 2 ? t.toLocaleTimeString('en-US', { hour: 'numeric', timeZone: 'America/New_York' }) : fmtDate(t.toISOString());
  for (const t of x.ticks(5)) svg.appendChild(s('text', { x: x(t), y: height - 6, 'text-anchor': 'middle' }, tickFmt(t)));
  // Series with `marker` end in a ringed dot and a value label: a short history still shows its latest value.
  const labels = [];
  for (const se of series) {
    const valid = pts.filter(p => p[se.key] !== null && p[se.key] !== undefined);
    if (!valid.length || (valid.length < 2 && !se.marker)) continue;
    if (valid.length >= 2) {
      const line = d3.line().x(p => x(p.d)).y(p => y(p[se.key])).curve(d3.curveMonotoneX);
      svg.appendChild(s('path', { d: line(valid), fill: 'none', stroke: se.color, 'stroke-width': se.width || 2.25, 'stroke-dasharray': se.dash || null, 'stroke-linejoin': 'round' }));
    }
    const last = valid[valid.length - 1];
    if (se.marker) {
      svg.appendChild(s('circle', { cx: x(last.d), cy: y(last[se.key]), r: 5, fill: se.color, stroke: 'var(--surface)', 'stroke-width': 2.5 }));
      labels.push({ x: x(last.d) - 10, y: y(last[se.key]) + 4, text: yFormat(last[se.key]), color: se.color });
    }
  }
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 14);
  for (const l of labels) svg.appendChild(s('text', { x: l.x, y: l.y, 'text-anchor': 'end', class: 'chart-value', style: `fill:${l.color}` }, l.text));
  const hover = s('rect', { x: m.l, y: m.t, width: width - m.l - m.r, height: height - m.t - m.b, fill: 'transparent' });
  const guide = s('line', { y1: m.t, y2: height - m.b, stroke: 'var(--ink)', 'stroke-width': 1, opacity: 0 });
  svg.append(guide, hover);
  hover.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (width / rect.width);
    const t = x.invert(px);
    const i = d3.bisector(p => p.d).center(pts, t);
    const p = pts[i];
    guide.setAttribute('x1', x(p.d)); guide.setAttribute('x2', x(p.d)); guide.setAttribute('opacity', 0.35);
    tip.show(`<div class="tt-title">${p.d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET</div>` +
      series.filter(se => p[se.key] !== null && p[se.key] !== undefined).map(se => `<div class="tt-row"><span style="color:${se.color}">● ${se.label}</span><b>${yFormat(p[se.key])}</b></div>`).join(''), e);
  });
  hover.addEventListener('mouseleave', () => { tip.hide(); guide.setAttribute('opacity', 0); });
  return h('div', { class: 'chart' }, svg);
}

// ------------------------------------------------------------------------------------- polls chart

export function pollChart(race, { width = 640, height = 240 } = {}) {
  const tip = tooltip();
  const pd = race.pollData;
  const polls = (pd?.polls || []).filter(p => p.left !== null && p.right !== null);
  const m = { t: 16, r: 44, b: 26, l: 8 };
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}` });
  if (!polls.length) return null;
  const pts = polls.map(p => ({ ...p, d: new Date(p.end + 'T12:00:00Z'), margin: p.left - p.right })).sort((a, b) => a.d - b.d);
  const end = new Date('2026-11-03T12:00:00Z');
  const first = d3.min(pts, p => p.d);
  const floor = d3.timeDay.offset(end, -240);
  const start = d3.max([d3.timeDay.offset(first, -7), floor, d3.timeDay.offset(end, -60) < first ? d3.timeDay.offset(end, -60) : floor]);
  const x = d3.scaleTime().domain([start, end]).range([m.l, width - m.r]);
  const shown = pts.filter(p => p.d >= start);
  const ext = d3.max(pts, p => Math.abs(p.margin)) || 10;
  const lim = Math.max(10, Math.ceil(ext / 5) * 5);
  const y = d3.scaleLinear().domain([-lim, lim]).range([height - m.b, m.t]);
  const lc = partyVar(race.leftParty), rc = partyVar(race.rightParty);
  svg.appendChild(s('rect', { x: m.l, y: m.t, width: width - m.l - m.r, height: y(0) - m.t, fill: lc, opacity: 0.05 }));
  svg.appendChild(s('rect', { x: m.l, y: y(0), width: width - m.l - m.r, height: height - m.b - y(0), fill: rc, opacity: 0.05 }));
  for (const v of y.ticks(5)) {
    svg.appendChild(s('line', { x1: m.l, x2: width - m.r, y1: y(v), y2: y(v), stroke: v === 0 ? 'var(--line-2)' : 'var(--line)' }));
    const who = v > 0 ? lastName(race.left) : v < 0 ? lastName(race.right) : 'Tie';
    svg.appendChild(s('text', { x: width - m.r + 6, y: y(v) + 4 }, v === 0 ? 'Even' : `+${Math.abs(v)}`));
    if (v === y.ticks(5)[y.ticks(5).length - 1]) svg.appendChild(s('text', { x: m.l + 4, y: m.t + 12, style: `fill:${lc};font-weight:700` }, `${lastName(race.left)} ahead`));
    void who;
  }
  svg.appendChild(s('text', { x: m.l + 4, y: height - m.b - 6, style: `fill:${rc};font-weight:700` }, `${lastName(race.right)} ahead`));
  for (const t of x.ticks(5)) svg.appendChild(s('text', { x: x(t), y: height - 6, 'text-anchor': 'middle' }, fmtDate(t.toISOString())));
  // Trend line: centered Gaussian-kernel average of the polls (12-day bandwidth), from the first poll on.
  const avgPts = [];
  const bw = 12 * 864e5;
  for (let t = Math.max(+start, +first); t <= +end; t += 864e5) {
    let wsum = 0, msum = 0;
    for (const p of pts) {
      const dt = t - p.d;
      const w = Math.exp(-0.5 * (dt / bw) ** 2) * (p.partisan ? 0.5 : 1);
      wsum += w; msum += w * p.margin;
    }
    if (wsum > 0.05) avgPts.push({ d: new Date(t), v: msum / wsum });
  }
  if (avgPts.length > 1) svg.appendChild(s('path', { d: d3.line().x(p => x(p.d)).y(p => y(p.v)).curve(d3.curveBasis)(avgPts), fill: 'none', stroke: 'var(--ink-2)', 'stroke-width': 2.25, opacity: 0.75 }));
  for (const p of shown) {
    const c = s('circle', { cx: x(p.d), cy: y(Math.max(-lim, Math.min(lim, p.margin))), r: 4.5, fill: p.margin >= 0 ? lc : rc, opacity: p.partisan ? 0.45 : 0.85, stroke: 'var(--surface)', 'stroke-width': 1 });
    c.addEventListener('mousemove', (e) => tip.show(`<div class="tt-title">${esc(p.pollster)}</div><div class="muted xs">${fmtDate(p.start)}–${fmtDate(p.end)} · ${p.n ? p.n.toLocaleString() + ' ' : ''}${(p.pop || '').toUpperCase()}${p.partisan ? ' · partisan' : ''}</div><div class="tt-row"><span>${esc(lastName(race.left))}</span><b>${p.left}%</b></div><div class="tt-row"><span>${esc(lastName(race.right))}</span><b>${p.right}%</b></div>`, e));
    c.addEventListener('mouseleave', () => tip.hide());
    svg.appendChild(c);
  }
  return h('div', { class: 'chart' }, svg);
}

// ------------------------------------------------------------------------------------- outcome curve

/** Distribution of the final margin (normal approximation), shaded by winner. */
export function marginCurve(race, mu, sd, { width = 440, height = 184 } = {}) {
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Range of likely margins' });
  const m = { t: 24, r: 12, b: 52, l: 12 };
  sd = Math.max(sd || 0, 0.5);
  // A close race gets an axis centred on a tie; a lopsided one is fitted to its likely outcomes, keeping the tie in view.
  let lo = mu - 3 * sd, hi = mu + 3 * sd;
  if (lo < 0 && hi > 0) { const span = Math.max(Math.abs(mu) + 3 * sd, 12); lo = -span; hi = span; }
  else { lo = Math.min(lo, 0); hi = Math.max(hi, 0); const pad = (hi - lo) * 0.06; lo -= pad; hi += pad; }
  const x = d3.scaleLinear().domain([lo, hi]).range([m.l, width - m.r]);
  const base = height - m.b;
  const pdf = (v) => Math.exp(-0.5 * ((v - mu) / sd) ** 2);
  const y = d3.scaleLinear().domain([0, 1.05]).range([base, m.t]);
  const xs = d3.range(lo, hi + 1e-9, (hi - lo) / 160).concat(0).sort((a, b) => a - b);
  const area = d3.area().x(v => x(v)).y0(base).y1(v => y(pdf(v))).curve(d3.curveBasis);
  const right = xs.filter(v => v >= 0), left = xs.filter(v => v <= 0);
  if (right.length > 1) svg.appendChild(s('path', { d: area(right), fill: partyVar(race.leftParty), opacity: 0.85 }));
  if (left.length > 1) svg.appendChild(s('path', { d: area(left), fill: partyVar(race.rightParty), opacity: 0.85 }));
  svg.appendChild(s('line', { x1: x(lo), x2: x(hi), y1: base, y2: base, stroke: 'var(--line-2)' }));
  svg.appendChild(s('line', { x1: x(0), x2: x(0), y1: m.t - 8, y2: base, stroke: 'var(--ink)', 'stroke-width': 1.25 }));

  // Who wins on each side of the tie line, where there is room for it.
  const textW = (t) => t.length * 6.3 + 4;
  const sideLabel = (name, party, toLeft) => {
    const t = toLeft ? `← ${name} wins` : `${name} wins →`;
    const room = toLeft ? x(0) - 6 - m.l : width - m.r - (x(0) + 6);
    if (textW(t) > room) return;
    svg.appendChild(s('text', { x: toLeft ? x(0) - 6 : x(0) + 6, y: m.t - 10, 'text-anchor': toLeft ? 'end' : 'start', style: `fill:${partyVar(party)};font-weight:650` }, t));
  };
  sideLabel(lastName(race.right), race.rightParty, true);
  sideLabel(lastName(race.left), race.leftParty, false);

  // The middle 80% of outcomes, with the projected margin beside the bar (not under it, where the axis labels go).
  const p10 = mu - 1.2816 * sd, p90 = mu + 1.2816 * sd, by = base + 13;
  svg.appendChild(s('line', { x1: x(p10), x2: x(p90), y1: by, y2: by, stroke: 'var(--ink-2)', 'stroke-width': 2 }));
  svg.appendChild(s('circle', { cx: x(mu), cy: by, r: 4, fill: 'var(--ink)' }));
  const label = marginText(mu, race);
  const after = x(p90) + 8, before = x(p10) - 8;
  if (after + textW(label) <= width - m.r) svg.appendChild(s('text', { x: after, y: by + 4, class: 'label-strong' }, label));
  else if (before - textW(label) >= m.l) svg.appendChild(s('text', { x: before, y: by + 4, 'text-anchor': 'end', class: 'label-strong' }, label));
  else svg.appendChild(s('text', { x: x(mu), y: by - 8, 'text-anchor': 'middle', class: 'label-strong' }, label));

  // Axis: margins in points, 'Even' at the tie.
  const tag = (party, name) => party === 'D' || party === 'R' ? party : lastName(name);
  const tickText = (v) => v === 0 ? 'Even' : `${v > 0 ? tag(race.leftParty, race.left) : tag(race.rightParty, race.right)}+${Math.abs(v)}`;
  const named = !['D', 'R'].includes(race.leftParty) || !['D', 'R'].includes(race.rightParty);
  for (const v of x.ticks(named ? 3 : 5)) {
    const px = x(v), t = tickText(v), w = textW(t) / 2;
    const anchor = px - w < m.l ? 'start' : px + w > width - m.r ? 'end' : 'middle';
    svg.appendChild(s('line', { x1: px, x2: px, y1: base, y2: base + 4, stroke: 'var(--line-2)' }));
    svg.appendChild(s('text', { x: anchor === 'start' ? m.l : anchor === 'end' ? width - m.r : px, y: height - 6, 'text-anchor': anchor }, t));
  }
  return h('div', { class: 'chart' }, svg);
}

// ------------------------------------------------------------------------------------- signal bars

export function signalRows(race, comps) {
  const names = { fundamentals: 'Fundamentals', polls: 'Polls', ratings: 'Expert ratings', market: 'Prediction market' };
  const order = ['polls', 'ratings', 'market', 'fundamentals'];
  const span = 16;
  const rows = order.filter(k => comps[k]).map(k => {
    const c = comps[k];
    const v = Math.max(-span, Math.min(span, c.margin));
    const left = 50 + (v / span) * 50;
    const detail = k === 'polls' ? `${c.n} poll${c.n === 1 ? '' : 's'}` : k === 'ratings' ? `${c.n} forecasters` : k === 'market' ? `${pct(c.p)} · ${c.volume ? compact(c.volume) + ' traded' : ''}` : 'partisan lean + national mood';
    return h('div', { class: 'signal-row' },
      h('div', null, h('div', { style: { fontWeight: 600 } }, names[k]), h('div', { class: 'xs muted' }, detail)),
      h('div', { class: 'sig-bar', title: marginText(c.margin, race) },
        h('div', { class: 'mid' }),
        h('div', { class: 'dot', style: { left: `${left}%`, background: c.margin >= 0 ? partyVar(race.leftParty) : partyVar(race.rightParty) } }),
        h('div', { class: 'xs', style: { position: 'absolute', top: '1px', left: left > 50 ? 'auto' : `calc(${left}% + 10px)`, right: left > 50 ? `calc(${100 - left}% + 10px)` : 'auto', fontWeight: 700, color: 'var(--ink-2)' } }, marginText(c.margin, race))),
      h('div', { class: 'w' }, `${Math.round(c.weight * 100)}% weight`));
  });
  return h('div', null, rows);
}
