// SVG charts (D3 is loaded globally from assets/vendor).
import { h, s, pct, partyVar, probColor, tooltip, esc, lastName, marginText, fmtDate, compact, PARTY_NAME } from './ui.js';
import { store, cur, awaiting } from './store.js';
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
export function usMap({ fill, onClick, tip: tipFn, height = 380, labels = true, stroke } = {}) {
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
    const p = s('path', { d: path(f), class: `state${active ? '' : ' inactive'}`, fill: color || 'var(--none)', 'data-state': code });
    if (stroke) p.setAttribute('stroke', stroke(code) || 'var(--surface)');
    if (tipFn) {
      p.addEventListener('mousemove', (e) => { const html = tipFn(code); if (html) tip.show(html, e); });
      p.addEventListener('mouseleave', () => tip.hide());
    }
    if (active) p.addEventListener('click', () => { tip.hide(); onClick(code); });
    g.appendChild(p);
  }
  // outline of the nation for crisp edges
  g.appendChild(s('path', { d: path(topojson.mesh(geo, geo.objects.states, (a, b) => a !== b)), fill: 'none', stroke: 'var(--surface)', 'stroke-width': 0.8, 'pointer-events': 'none' }));
  if (labels) {
    // small north-eastern states get callout boxes so they can be seen and tapped
    const callouts = ['VT', 'NH', 'MA', 'RI', 'CT', 'NJ', 'DE', 'MD', 'DC'];
    let yy = 175;
    for (const code of callouts) {
      if (code === 'DC') continue;
      const color = fill(code);
      const box = s('g', { transform: `translate(925, ${yy})`, style: onClick && color !== null ? 'cursor:pointer' : '' });
      box.appendChild(s('rect', { width: 18, height: 14, rx: 3, fill: color || 'var(--none)', stroke: 'var(--line-2)', 'stroke-width': 0.5 }));
      box.appendChild(s('text', { x: -5, y: 11, 'text-anchor': 'end', style: 'font-size:11px;font-weight:600' }, code));
      if (tipFn) { box.addEventListener('mousemove', (e) => { const html = tipFn(code); if (html) tip.show(html, e); }); box.addEventListener('mouseleave', () => tip.hide()); }
      if (onClick && color !== null) box.addEventListener('click', () => { tip.hide(); onClick(code); });
      svg.appendChild(box);
      yy += 20;
    }
  }
  return h('div', { class: 'map-wrap chart' }, svg);
}

export function mapLegend(items) {
  return h('div', { class: 'legend' }, items.map(([color, label]) => h('span', null, h('i', { style: { background: color } }), label)));
}

export const BAND_LEGEND = [
  ['var(--dem)', 'Solid D'], ['var(--dem-2)', 'Likely D'], ['var(--dem-3)', 'Lean D'], ['var(--toss)', 'Toss-up'],
  ['var(--rep-3)', 'Lean R'], ['var(--rep-2)', 'Likely R'], ['var(--rep)', 'Solid R'], ['var(--ind)', 'Independent'], ['var(--none)', 'No race'],
];

// ------------------------------------------------------------------------------------- seat strip

/** Every race lined up from safest left to safest right, with the majority marker. */
export function seatStrip(races, { need, base = 0, height = 34, majorityLabel } = {}) {
  const tip = tooltip();
  const rows = races.map(r => ({ r, c: cur(r) })).map(x => ({ ...x, dp: dProb(x.r, x.c.p) }))
    .sort((a, b) => b.dp - a.dp);
  const strip = h('div', { class: 'seat-strip', style: { height: `${height}px`, gap: rows.length > 120 ? '0' : '2px' } });
  rows.forEach(({ r, c }) => {
    const a = h('a', { href: r.url, style: { background: probColor(c.p, r.leftParty, r.rightParty), borderRadius: rows.length > 120 ? '0' : null }, 'aria-label': r.title });
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

function dProb(r, p) {
  if (p === null || p === undefined) return 0.5;
  if (r.leftParty === 'D') return p;
  if (r.rightParty === 'D') return 1 - p;
  return r.rightParty === 'R' ? p * 0.5 + 0.25 : 0.5; // independents sit between
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
  if (c.result && c.result.total > 0) {
    const tot = c.result.total;
    rows.push(line(r.left, r.leftParty, null, `${((c.result.left / tot) * 100).toFixed(1)}%`));
    rows.push(line(r.right, r.rightParty, null, `${((c.result.right / tot) * 100).toFixed(1)}%`));
    rows.push(`<div class="tt-row muted"><span>${Math.round(c.eevp)}% of expected vote</span><span>${c.called ? 'Called' : 'Projection ' + pct(Math.max(p, 1 - p))}</span></div>`);
  } else if (r.left && r.right) {
    rows.push(line(r.left, r.leftParty, p));
    rows.push(line(r.right, r.rightParty, 1 - p));
    rows.push(`<div class="tt-row muted"><span>Projected margin</span><span>${marginText(c.mu, r)}</span></div>`);
  } else {
    rows.push(`<div class="muted">${r.samePartyGeneral ? `Two ${PARTY_NAME[r.samePartyGeneral]}s on the ballot` : 'Uncontested by a major party'}</div>`);
  }
  return `<div class="tt-title">${esc(r.title)}</div>${rows.join('')}`;
}

// ------------------------------------------------------------------------------------- line chart

/** Forecast history: series = [{ key, label, color, dash }] over points [{ t, ...}] (probabilities 0-1). */
export function historyChart(points, series, { width = 640, height = 220, yDomain = [0, 1], yFormat = (v) => pct(v), area = false } = {}) {
  const tip = tooltip();
  const m = { t: 14, r: 46, b: 26, l: 8 };
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
    svg.appendChild(s('text', { x: width - m.r + 6, y: y(v) + 4 }, yFormat(v)));
  }
  if (yDomain[0] === 0 && yDomain[1] === 1) svg.appendChild(s('line', { x1: m.l, x2: width - m.r, y1: y(0.5), y2: y(0.5), stroke: 'var(--line-2)', 'stroke-dasharray': '3 3' }));
  const spanDays = (x.domain()[1] - x.domain()[0]) / 864e5;
  const tickFmt = (t) => spanDays < 2 ? t.toLocaleTimeString('en-US', { hour: 'numeric', timeZone: 'America/New_York' }) : fmtDate(t.toISOString());
  for (const t of x.ticks(5)) svg.appendChild(s('text', { x: x(t), y: height - 6, 'text-anchor': 'middle' }, tickFmt(t)));
  for (const se of series) {
    const valid = pts.filter(p => p[se.key] !== null && p[se.key] !== undefined);
    if (valid.length < 2) continue;
    const line = d3.line().x(p => x(p.d)).y(p => y(p[se.key])).curve(d3.curveMonotoneX);
    svg.appendChild(s('path', { d: line(valid), fill: 'none', stroke: se.color, 'stroke-width': se.width || 2.25, 'stroke-dasharray': se.dash || null, 'stroke-linejoin': 'round' }));
    const last = valid[valid.length - 1];
    svg.appendChild(s('circle', { cx: x(last.d), cy: y(last[se.key]), r: 3.5, fill: se.color }));
  }
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
export function marginCurve(race, mu, sd, { width = 440, height = 170 } = {}) {
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Range of likely margins' });
  const m = { t: 14, r: 12, b: 28, l: 12 };
  const span = Math.max(Math.abs(mu) + 3 * sd, 12);
  const x = d3.scaleLinear().domain([-span, span]).range([m.l, width - m.r]);
  const pdf = (v) => Math.exp(-0.5 * ((v - mu) / sd) ** 2);
  const y = d3.scaleLinear().domain([0, 1.05]).range([height - m.b, m.t]);
  const xs = d3.range(-span, span + 0.001, span / 120);
  const area = d3.area().x(v => x(v)).y0(y(0)).y1(v => y(pdf(v))).curve(d3.curveBasis);
  svg.appendChild(s('path', { d: area(xs.filter(v => v >= 0)), fill: partyVar(race.leftParty), opacity: 0.85 }));
  svg.appendChild(s('path', { d: area(xs.filter(v => v <= 0)), fill: partyVar(race.rightParty), opacity: 0.85 }));
  svg.appendChild(s('line', { x1: x(0), x2: x(0), y1: m.t - 4, y2: height - m.b, stroke: 'var(--ink)', 'stroke-width': 1.25 }));
  const lo = mu - 1.2816 * sd, hi = mu + 1.2816 * sd;
  svg.appendChild(s('line', { x1: x(lo), x2: x(hi), y1: height - m.b + 8, y2: height - m.b + 8, stroke: 'var(--ink-2)', 'stroke-width': 2 }));
  svg.appendChild(s('circle', { cx: x(mu), cy: height - m.b + 8, r: 4, fill: 'var(--ink)' }));
  svg.appendChild(s('text', { x: x(-span) + 2, y: height - 2 }, `${lastName(race.right)} +${Math.round(span)}`));
  svg.appendChild(s('text', { x: x(span) - 2, y: height - 2, 'text-anchor': 'end' }, `${lastName(race.left)} +${Math.round(span)}`));
  svg.appendChild(s('text', { x: x(mu), y: height - 2, 'text-anchor': 'middle', class: 'label-strong' }, marginText(mu, race)));
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
