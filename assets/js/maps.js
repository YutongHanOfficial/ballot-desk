// District maps: the national House map (geographic or equal-size hexagons) and per-state district maps.
// Boundaries are the Census Bureau's 2026 (120th Congress) districts, built by pipeline/build_geo.mjs.
import { h, s, tooltip, esc, marginFill, hatchFill, votePct, shiftFill, shiftScaleFor, num, partyVar } from './ui.js';
import { store, awaiting, raceFill, nightMode, counting, voteDigits, roughly } from './store.js';
import { raceTip, mapLegend, marginLegend } from './charts.js';

const d3 = window.d3;
const topojson = window.topojson;

// ------------------------------------------------------------------------------------------- loading

import { loadGeo, cachedGeo, COUNTY_BASE_URL } from './geo.js';
import { navigate } from './nav.js';
export { loadGeo };

/** Build immediately when the files are cached; otherwise show a placeholder and swap the map in on arrival. */
function withGeo(urls, build, height) {
  const have = urls.map(u => cachedGeo(u));
  if (have.every(Boolean)) return build(...have);
  const holder = h('div', { class: 'skeleton map-skeleton', style: { height: `${height}px` } });
  Promise.all(urls.map(loadGeo))
    .then(data => { if (holder.isConnected) holder.replaceWith(build(...data)); })
    .catch(() => { if (holder.isConnected) holder.replaceWith(h('div', { class: 'empty small' }, 'The map could not be loaded.')); });
  return holder;
}

// ------------------------------------------------------------------------------------------- colour

export { raceFill };

/** A layer of stripes over the races still being counted; empty outside election night. */
function stripesFor(svg, items) {
  const layer = s('g', { class: 'hatch' });
  const live = items.filter(([r]) => counting(r));
  if (live.length) {
    const fill = hatchFill(svg);
    for (const [, shape] of live) layer.appendChild(shape(fill));
  }
  return layer;
}

// District numbers: round badges that keep one size on screen at any zoom (each is scaled by 1/zoom inside the
// zoomed layer) and never overlap. Bigger districts get a contested spot first; the rest appear as you zoom in.
function districtBadge(n, [x, y], { size, width, target = false }) {
  const g = s('g', { class: `dbadge${target ? ' target' : ''}`, 'data-x': x.toFixed(1), 'data-y': y.toFixed(1), 'data-size': target ? 1e9 : size.toFixed(0), 'data-w': target ? 1e9 : width.toFixed(1) });
  g.append(s('circle', { r: 9 }), s('text', null, String(n)));
  return g;
}

function placeBadges(layer, k, { minK = 1, minWidth = 20 } = {}) {
  const gap = 20;   // badge diameter plus a little air, in screen units
  const items = [...layer.children].map(el => ({ el, x: +el.dataset.x, y: +el.dataset.y, size: +el.dataset.size, w: +el.dataset.w }))
    .sort((a, b) => b.size - a.size);
  const placed = [];
  for (const it of items) {
    let show = k >= minK && it.w * k >= minWidth;
    if (show) show = !placed.some(q => Math.hypot((q.x - it.x) * k, (q.y - it.y) * k) < gap);
    it.el.style.display = show ? '' : 'none';
    if (show) { placed.push(it); it.el.setAttribute('transform', `translate(${it.x},${it.y}) scale(${(1 / k).toFixed(4)})`); }
  }
}

function hoverable(el, r, tipFn = raceTip) {
  const tip = tooltip();
  el.addEventListener('mousemove', (e) => tip.show(tipFn(r), e));
  el.addEventListener('mouseleave', () => tip.hide());
  return tip;
}

// ------------------------------------------------------------------------------------------- zoom

const ZOOM = {};   // remembered transforms, so the live re-render every minute doesn't reset the view

export function attachZoom(svg, layer, { key, width, height, maxK = 16, onZoom }) {
  let k = 1;
  const zoom = d3.zoom().scaleExtent([1, maxK]).translateExtent([[0, 0], [width, height]])
    .filter((ev) => {
      if (ev.type === 'wheel') return ev.ctrlKey || ev.metaKey;           // trackpad pinch sends ctrlKey
      if (ev.type === 'dblclick') return false;                           // clicks open races
      if (ev.type.startsWith('touch')) return (ev.touches && ev.touches.length > 1) || k > 1.01;
      return k > 1.01 && !ev.button;                                      // drag to pan once zoomed in
    })
    .on('zoom', (ev) => {
      k = ev.transform.k;
      layer.setAttribute('transform', ev.transform.toString());
      ZOOM[key] = ev.transform;
      svg.classList.toggle('zoomed', k > 1.01);
      if (onZoom) onZoom(ev.transform);
    });
  const sel = d3.select(svg).call(zoom);
  if (ZOOM[key]) sel.call(zoom.transform, ZOOM[key]);
  const api = {
    zoom, get k() { return k; },
    by(f) { sel.transition().duration(350).call(zoom.scaleBy, f); },
    reset() { sel.transition().duration(500).call(zoom.transform, d3.zoomIdentity); },
    to([[x0, y0], [x1, y1]], maxScale = 10) {
      const kk = Math.min(maxScale, 0.88 / Math.max((x1 - x0) / width, (y1 - y0) / height));
      const t = d3.zoomIdentity.translate(width / 2, height / 2).scale(kk).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
      sel.transition().duration(650).call(zoom.transform, t);
    },
  };
  return api;
}

export function zoomButtons(api, extra = []) {
  const btn = (label, title, fn) => h('button', { type: 'button', class: 'zoom-btn', title, 'aria-label': title, onclick: fn }, label);
  return h('div', { class: 'zoom-ctrls' }, btn('+', 'Zoom in', () => api.by(1.8)), btn('−', 'Zoom out', () => api.by(1 / 1.8)), btn('⟲', 'Reset view', () => api.reset()), ...extra);
}

// ------------------------------------------------------------------------------------------- national map

let natCache = null;   // projected path strings, computed once per page load

function nationalShapes(topo) {
  if (natCache && natCache.topo === topo) return natCache;
  const proj = d3.geoAlbersUsa().scale(1300).translate([487.5, 305]);
  const path = d3.geoPath(proj);
  const fc = topojson.feature(topo, topo.objects.districts);
  const feats = fc.features.map(f => {
    const b = path.bounds(f);
    return { id: f.properties.id, st: f.properties.st, d: path(f), c: path.centroid(f), w: b[1][0] - b[0][0], b };
  });
  const borders = path(topojson.mesh(topo, topo.objects.districts, (a, b) => a.properties.st !== b.properties.st));
  const coast = path(topojson.mesh(topo, topo.objects.districts, (a, b) => a === b));
  const stateBounds = {};
  for (const f of feats) {
    const sb = stateBounds[f.st] || [[Infinity, Infinity], [-Infinity, -Infinity]];
    sb[0][0] = Math.min(sb[0][0], f.b[0][0]); sb[0][1] = Math.min(sb[0][1], f.b[0][1]);
    sb[1][0] = Math.max(sb[1][0], f.b[1][0]); sb[1][1] = Math.max(sb[1][1], f.b[1][1]);
    stateBounds[f.st] = sb;
  }
  natCache = { topo, feats, borders, coast, stateBounds };
  return natCache;
}

const VIEW = { mode: null };
function pref(key, val) {
  try { if (val !== undefined) localStorage.setItem(key, val); return localStorage.getItem(key); } catch { return val ?? null; }
}

/** National House map with a Geographic / Equal-size toggle. */
export function houseMap({ id = 'house', caption = true, fill = raceFill, tip = raceTip, legend = null } = {}) {
  VIEW.mode = VIEW.mode || pref('houseMapMode') || 'geo';
  const wrap = h('div', { class: 'house-map' });
  const body = h('div', { class: 'map-body' });
  const seg = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Map style' });
  const opts = [['geo', 'Geographic'], ['hex', 'Equal-size']];
  const draw = () => {
    seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', opts[i][0] === VIEW.mode));
    body.replaceChildren(VIEW.mode === 'hex'
      ? withGeo(['/data/geo/house-hex.json'], (hex) => hexMap(hex, { fill, tip }), 420)
      : withGeo(['/data/geo/districts-2026.json'], (topo) => geoMap(topo, id, { fill, tip }), 420));
  };
  for (const [k, label] of opts) {
    seg.appendChild(h('button', { type: 'button', onclick: () => { VIEW.mode = k; pref('houseMapMode', k); draw(); } }, label));
  }
  wrap.append(h('div', { class: 'map-toolbar' }, seg,
    caption ? h('span', { class: 'xs muted map-hint' }, VIEW.mode === 'hex' ? 'Every district the same size' : 'Click a state to zoom · pinch or Ctrl/⌘-scroll') : null),
    body, legend ? (legend instanceof Node ? legend : mapLegend(legend)) : marginLegend({ check: false, ind: false }));
  draw();
  // keep the hint in sync with the mode
  seg.addEventListener('click', () => { const hint = wrap.querySelector('.map-hint'); if (hint) hint.textContent = VIEW.mode === 'hex' ? 'Every district the same size' : 'Click a state to zoom · pinch or Ctrl/⌘-scroll'; });
  return wrap;
}

function geoMap(topo, key, { fill = raceFill, tip: tipFn = raceTip } = {}) {
  const W = 975, H = 610;
  const shapes = nationalShapes(topo);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'district-map', role: 'img', 'aria-label': 'Map of all 435 House districts' });
  const layer = s('g');
  const labels = s('g', { class: 'district-labels' });
  let api = null;
  for (const f of shapes.feats) {
    const r = store.byId[f.id];
    const p = s('path', { d: f.d, fill: fill(r), class: 'district' });
    if (r) {
      const tip = hoverable(p, r, tipFn);
      p.addEventListener('click', () => {
        tip.hide();
        // First click zooms to the state; once zoomed in, a click opens the race.
        if (api && api.k < 2.2 && shapes.stateBounds[f.st] && (shapes.stateBounds[f.st][1][0] - shapes.stateBounds[f.st][0][0]) < 600) api.to(shapes.stateBounds[f.st], 9);
        else navigate(r.url);
      });
    }
    layer.appendChild(p);
    if (r && r.district) labels.appendChild(districtBadge(r.district, f.c, { size: f.w * (f.b[1][1] - f.b[0][1]), width: f.w }));
  }
  layer.append(
    stripesFor(svg, shapes.feats.map(f => [store.byId[f.id], (fill) => s('path', { d: f.d, fill })])),
    s('path', { d: shapes.borders, class: 'state-borders' }),
    s('path', { d: shapes.coast, class: 'coast' }),
    labels);
  svg.appendChild(layer);
  const placeLabels = (t) => placeBadges(labels, t ? t.k : 1, { minK: 1.9 });
  api = attachZoom(svg, layer, { key, width: W, height: H, onZoom: placeLabels });
  placeLabels(ZOOM[key]);

  const select = h('select', { class: 'input zoom-select', 'aria-label': 'Zoom to a state' },
    h('option', { value: '' }, 'Zoom to a state…'),
    store.states.filter(st => shapes.stateBounds[st.code]).map(st => h('option', { value: st.code }, st.name)));
  select.addEventListener('change', () => { const b = shapes.stateBounds[select.value]; if (b) api.to(b, 12); else api.reset(); });
  return h('div', { class: 'map-frame' }, svg, zoomButtons(api), select);
}

function hexPoints(x, y, r) {
  let out = '';
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 180 * (60 * k - 30);
    out += `${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)} `;
  }
  return out.trim();
}

function hexMap(hex, { fill = raceFill, tip: tipFn = raceTip, mark = null } = {}) {
  const svg = s('svg', { viewBox: `0 0 ${hex.width} ${hex.height}`, class: 'hex-map', role: 'img', 'aria-label': 'Equal-size map of all 435 House districts' });
  for (const [id, [x, y]] of Object.entries(hex.cells)) {
    const r = store.byId[id];
    const poly = s('polygon', { points: hexPoints(x, y, hex.r), fill: fill(r), class: 'hex' });
    if (r) {
      const tip = hoverable(poly, r, tipFn);
      poly.addEventListener('click', () => { tip.hide(); navigate(r.url); });
    }
    svg.appendChild(poly);
  }
  svg.appendChild(stripesFor(svg, Object.entries(hex.cells).map(([id, [x, y]]) => [store.byId[id], (fill) => s('polygon', { points: hexPoints(x, y, hex.r), fill })])));
  svg.appendChild(s('path', { d: hex.borders, class: 'hex-borders' }));
  // Optional check marks (mark: race => bool). The House maps leave them off: projected seats are solid instead.
  if (mark) {
    const checks = s('g', { class: 'hex-checks', style: `font-size:${(hex.r * 0.95).toFixed(1)}px` });
    for (const [id, [x, y]] of Object.entries(hex.cells)) if (mark(store.byId[id])) checks.appendChild(s('text', { x, y: y + hex.r * 0.04 }, '✓'));
    svg.appendChild(checks);
  }
  const lab = s('g', { class: 'hex-labels', style: `font-size:${(hex.r * 0.78).toFixed(1)}px` });
  for (const [st, [x, y]] of Object.entries(hex.labels)) lab.appendChild(s('text', { x, y: y + hex.r * 0.28 }, st));
  svg.appendChild(lab);
  return h('div', { class: 'map-frame hex-frame' }, svg);
}

/** The equal-size House map on its own, without the style toggle or legend (broadcast view). */
export function houseHex({ fill = raceFill } = {}) {
  return withGeo(['/data/geo/house-hex.json'], (hex) => hexMap(hex, { fill, tip: () => '' }), 420);
}

// ------------------------------------------------------------------------------------------- state maps

/** One state's districts, coloured by forecast. highlight = race id to spotlight (race-page locator). */
export function stateDistrictMap(code, { highlight = null, width = 720, maxHeight = 560, zoomKey = null } = {}) {
  return withGeo([`/data/geo/cd/${code}.json`], (topo) => buildStateMap(code, topo, { highlight, width, maxHeight, zoomKey }), Math.min(maxHeight, 360));
}

/** Conformal conic projection framed on a state (or, with focus, on part of it). */
function stateFrame(fc, W, maxHeight, focus = null) {
  const [[west, south], [east, north]] = d3.geoBounds(fc);
  const lon = west > east ? ((west + east + 360) / 2 + 180) % 360 - 180 : (west + east) / 2;   // Alaska spans 180°
  const proj = d3.geoConicConformal().rotate([-lon, 0]).parallels([south + (north - south) / 3, north - (north - south) / 3]);
  proj.fitWidth(W - 20, fc);
  let path = d3.geoPath(proj);
  let box = path.bounds(fc);
  if (focus) {
    const tb = path.bounds(focus);
    const tw = tb[1][0] - tb[0][0], th = tb[1][1] - tb[0][1];
    if (Math.max(tw / (box[1][0] - box[0][0]), th / (box[1][1] - box[0][1])) < 0.28) {
      const cx = (tb[0][0] + tb[1][0]) / 2, cy = (tb[0][1] + tb[1][1]) / 2;
      const half = Math.max(tw, th) * 1.6 + 6;
      box = [[cx - half * 1.25, cy - half], [cx + half * 1.25, cy + half]];
    }
  }
  const bw = box[1][0] - box[0][0], bh = box[1][1] - box[0][1];
  const H = Math.min(maxHeight, Math.round(bh * (W - 20) / bw) + 20);
  const k = Math.min((W - 20) / bw, (H - 20) / bh);
  const [tx, ty] = proj.translate();
  const bcx = (box[0][0] + box[1][0]) / 2, bcy = (box[0][1] + box[1][1]) / 2;
  proj.scale(proj.scale() * k).translate([(tx - bcx) * k + W / 2, (ty - bcy) * k + H / 2]);
  path = d3.geoPath(proj);
  return { proj, path, H };
}

function buildStateMap(code, topo, { highlight, width: W, maxHeight, zoomKey }) {
  const fc = topojson.feature(topo, topo.objects.districts);
  const target = highlight ? fc.features.find(f => f.properties.id === highlight) : null;
  const { path, H } = stateFrame(fc, W, maxHeight, target);

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: `district-map state-map${highlight ? ' locator' : ''}`, role: 'img', 'aria-label': `${store.stateByCode[code]?.name} congressional districts` });
  const layer = s('g');
  const labels = s('g', { class: 'district-labels state-labels' });
  for (const f of fc.features) {
    const r = store.byId[f.properties.id];
    const isTarget = highlight && f.properties.id === highlight;
    const fill = !highlight || isTarget ? raceFill(r) : 'var(--surface-2)';
    const p = s('path', { d: path(f), fill, class: `district${isTarget ? ' target' : ''}` });
    if (r) {
      const tip = hoverable(p, r);
      p.addEventListener('click', () => { tip.hide(); if (!isTarget) navigate(r.url); });
    }
    layer.appendChild(p);
    const area = path.area(f);
    const c = path.centroid(f);
    if (r && r.district && Number.isFinite(c[0])) labels.appendChild(districtBadge(r.district, c, { size: area, width: Math.sqrt(area), target: isTarget }));
  }
  if (!highlight) layer.appendChild(stripesFor(svg, fc.features.map(f => [store.byId[f.properties.id], (fill) => s('path', { d: path(f), fill })])));
  if (target) layer.appendChild(s('path', { d: path(target), class: 'target-outline' }));
  layer.appendChild(s('path', { d: path(topojson.mesh(topo, topo.objects.districts, (a, b) => a === b)), class: 'coast' }));
  layer.appendChild(labels);
  svg.appendChild(layer);
  placeBadges(labels, (zoomKey && ZOOM[zoomKey]?.k) || 1, { minWidth: 24 });
  if (!zoomKey) return h('div', { class: 'map-frame' }, svg);
  const api = attachZoom(svg, layer, { key: zoomKey, width: W, height: H, maxK: 12, onZoom: (t) => placeBadges(labels, t.k, { minWidth: 24 }) });
  return h('div', { class: 'map-frame' }, svg, zoomButtons(api));
}

// ------------------------------------------------------------------------------------------- county maps

/** County results for a race right now: a simulation's synthetic counts, or the live NYT race file. */
export function countyResults(raceId) {
  if (store.sim) return store.live.results[raceId]?.counties || null;
  return store.live.counties?.[raceId] || null;
}

/**
 * Votes still to count in each county of a race, with who leads it so far: { total, counties: { fips: { left,
 * counted, share, m } } }, m being the left side's margin in points (null before any votes). Votes left are the AP's
 * expected vote less the count; without an expected vote (simulations), they follow from the share counted.
 */
export function countyVotesLeft(raceId) {
  const live = countyResults(raceId);
  if (!live) return null;
  const counties = {};
  let total = 0;
  for (const [fips, [share, l, r, counted, expected]] of Object.entries(live)) {
    const left = expected > 0 ? Math.max(0, expected - counted) : share > 0 && share < 1 ? (counted * (1 - share)) / share : 0;
    counties[fips] = { left, counted, share, m: counted > 0 ? (100 * (l - r)) / counted : null };
    total += left;
  }
  return { total, counties };
}

// The share of a county's expected vote counted: '93%', or '99.6%' near the end (rounded down, so "100%" never sits
// beside votes left).
const countedText = (share) => share >= 0.99 && share < 1 ? `${Math.floor(share * 1000) / 10}%` : `${Math.round(share * 100)}%`;
const leadText = (race, m) => Math.abs(m) < 0.05 ? 'Even' : `${lastNameOf(m >= 0 ? race.left : race.right)} +${Math.abs(m).toFixed(1)}`;

/** Under the votes-left map: what the circle sizes and colours mean. */
function votesLeftKey(race, maxLeft) {
  const sizes = [1, 1 / 4, 1 / 16].map(f => [roughly(maxLeft * f), 15 * Math.sqrt(f)]).filter(([v], i, a) => v >= 1 && a.findIndex(x => x[0] === v) === i);
  const swatches = (party) => [3, 10, 20].map(m => h('i', { style: { background: marginFill(party, m) } }));
  return h('div', { class: 'vl-key' },
    h('div', { class: 'vl-sizes' }, sizes.map(([v, r]) => h('span', null, h('i', { style: { width: `${2 * r}px`, height: `${2 * r}px` } }), num(v))),
      h('span', { class: 'vl-cap' }, 'votes left')),
    h('div', { class: 'vl-cols' }, swatches(race.leftParty), h('span', null, `${lastNameOf(race.left)} leads`)),
    h('div', { class: 'vl-cols' }, swatches(race.rightParty), h('span', null, `${lastNameOf(race.right)} leads`)),
    h('span', null, 'darker: a bigger lead'));
}

/** Under the votes-left map: how many votes are left, how they split by who leads each county, and where most are. */
function votesLeftSummary(race, fc, VL, suffix) {
  const names = Object.fromEntries(fc.features.map(f => [f.properties.id, f.properties.n + suffix]));
  const rows = Object.entries(VL.counties).filter(([fips, x]) => x.left >= 1 && names[fips]).sort((a, b) => b[1].left - a[1].left);
  if (!rows.length) return h('p', { class: 'small muted vl-summary' }, 'By the AP’s estimates, every county has finished counting.');
  const by = { left: 0, right: 0, none: 0 };
  for (const [, x] of rows) by[x.m === null ? 'none' : x.m >= 0 ? 'left' : 'right'] += x.left;
  const pctOf = (n) => `${Math.round((100 * n) / VL.total)}%`;
  const split = [
    by.left ? `${pctOf(by.left)} in counties ${lastNameOf(race.left)} leads` : null,
    by.right ? `${pctOf(by.right)} in counties ${lastNameOf(race.right)} leads` : null,
    by.none ? `${pctOf(by.none)} in counties with no votes counted yet` : null,
  ].filter(Boolean);
  const list = split.length < 2 ? split.join('') : `${split.slice(0, -1).join(', ')} and ${split.at(-1)}`;
  const top = rows.slice(0, 6);
  return h('div', { class: 'vl-summary' },
    h('p', { class: 'small' }, h('b', null, `About ${num(roughly(VL.total))} votes left to count`), ` in ${rows.length} ${rows.length === 1 ? 'county' : 'counties'}: ${list}.`),
    h('div', { class: 'table-wrap', style: { border: 0 } }, h('table', { class: 'data vl-table' },
      h('thead', null, h('tr', null, h('th', null, 'County'), h('th', { class: 'num hide-sm' }, 'Counted'), h('th', { class: 'num' }, 'Votes left'), h('th', { class: 'num' }, 'Leads'))),
      h('tbody', null, top.map(([fips, x]) => h('tr', null,
        h('td', null, names[fips]),
        h('td', { class: 'num hide-sm' }, countedText(x.share)),
        h('td', { class: 'num' }, num(Math.round(x.left))),
        h('td', { class: 'num', style: { color: x.m === null ? 'var(--muted)' : partyVar(x.m >= 0 ? race.leftParty : race.rightParty), fontWeight: 650, whiteSpace: 'nowrap' } },
          x.m === null ? 'No votes yet' : leadText(race, x.m))))))));
}

/** Key for the county maps: the same margin scale, by candidate on election night, by party for 2024. */
export function countyLegend(race = null, live = false) {
  if (!race || !live) return marginLegend({ results: false, caption: '2024 presidential margin (points)', leftName: 'Harris (D)', rightName: 'Trump (R)', extras: [] });
  return marginLegend({ results: true, caption: 'lead in the county (points)', left: race.leftParty, right: race.rightParty,
    leftName: lastNameOf(race.left), rightName: lastNameOf(race.right), extras: [['var(--novotes)', 'No votes yet'], ['var(--await)', 'Polls open']] });
}

/**
 * For the "Shift from 2024" view: the side of a race to set against Harris's 2024 vote (a Democrat, or an independent
 * running against a Republican), with sign 1 if that is the race's left side and -1 if its right. Null for races
 * without a Republican on one side, such as two candidates of one party.
 */
export function shiftSides(race) {
  if (!race?.left || !race?.right) return null;
  const lp = race.leftParty, rp = race.rightParty;
  if (rp === 'R' && (lp === 'D' || lp === 'I')) return { sign: 1, party: lp, name: race.left, rival: race.right };
  if (lp === 'R' && (rp === 'D' || rp === 'I')) return { sign: -1, party: rp, name: race.right, rival: race.left };
  return null;
}

/**
 * A state's counties. With a race and county results available (election night, or a simulation), counties
 * are shaded by who leads and by how much; otherwise by the 2024 presidential vote. view 'shift' shades them
 * instead by the change from the 2024 presidential margin (see shiftSides), striping counties still counting.
 */
export function countyMap(code, { raceId = null, width = 720, maxHeight = 540, compact = false, zoomKey = null, view = 'results', shiftKey = null } = {}) {
  if (code === 'AK') return h('div', { class: 'empty small' }, 'Alaska reports results by state House district rather than by county, so there is no county map.');
  return withGeo([`/data/geo/counties/${code}.json`, COUNTY_BASE_URL], (topo, base) => buildCountyMap(code, topo, base, { raceId, width, maxHeight, compact, zoomKey, view, shiftKey }), compact ? 200 : 360);
}

/** 'D+4.2', 'R+3.1', an independent's 'Osborn +2.0', or 'Even'. */
function sideLabel(m, tag) {
  const v = Math.abs(m);
  return v < 0.05 ? 'Even' : `${m > 0 ? tag : 'R'}${m > 0 && tag.length > 1 ? ' ' : ''}+${v.toFixed(1)}`;
}

function buildCountyMap(code, topo, base, { raceId, width: W, maxHeight, compact, zoomKey, view, shiftKey }) {
  const fc = topojson.feature(topo, topo.objects.counties);
  const { path, H } = stateFrame(fc, W, maxHeight);
  const race = raceId ? store.byId[raceId] : null;
  const live = race ? countyResults(raceId) : null;
  const night = !!race && nightMode();
  const waiting = night && awaiting(race);
  const liveMode = night && (!!live || waiting);
  const sides = view === 'shift' && liveMode && !waiting && live ? shiftSides(race) : null;
  const tag = sides ? (sides.party === 'D' ? 'D' : lastNameOf(sides.name)) : null;
  const stillCounting = [];   // shift view: counties under 95% of their expected vote, striped
  // The shift view's scale comes from the shifts themselves; shiftKey(bands) draws the matching key under the map.
  const shiftOf = (fips) => {
    const v = live[fips], b = base[fips];
    if (!(v && v[3] > 0 && b && b[0] > 0)) return null;
    const now = (sides.sign * 100 * (v[1] - v[2])) / v[3];   // this race: the Democrat's (or independent's) margin
    const then = (100 * (b[1] - b[2])) / b[0];                // 2024: Harris's over Trump
    return { now, then, sh: now - then };
  };
  const bands = sides ? shiftScaleFor(fc.features.map(f => shiftOf(f.properties.id)?.sh)) : null;
  // Votes-left view: a circle on each county still counting, sized by its votes left, coloured by who leads it so far.
  const VL = view === 'left' && liveMode && !waiting && live ? countyVotesLeft(raceId) : null;
  const tips = new Map();
  const tip = tooltip();
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: `district-map county-map${compact ? ' compact' : ''}`, role: 'img', 'aria-label': `${store.stateByCode[code]?.name} counties` });
  const layer = s('g');
  const suffix = code === 'LA' ? ' Parish' : '';
  for (const f of fc.features) {
    const fips = f.properties.id, name = f.properties.n + suffix;
    let fill = 'var(--none)', html;
    if (VL) {
      const x = VL.counties[fips];
      html = `<div class="tt-title">${esc(name)}</div>` + (x && x.counted > 0
        ? `<div class="tt-row"><span>Votes left (estimate)</span><b>${num(Math.round(x.left))}</b></div>` +
          `<div class="tt-row"><span>Counted</span><b>${countedText(x.share)}</b></div>` +
          `<div class="tt-row"><span>Leads so far</span><b style="color:${partyVar(x.m >= 0 ? race.leftParty : race.rightParty)}">${esc(leadText(race, x.m))}</b></div>` +
          `<div class="tt-row muted"><span>Counted so far</span><span>${x.counted.toLocaleString()} votes</span></div>`
        : x ? `<div class="tt-row"><span>Votes expected</span><b>${num(Math.round(x.left))}</b></div><div class="muted">No votes counted yet</div>`
        : '<div class="muted">No results for this county yet</div>');
      tips.set(fips, html);
    } else if (sides) {
      const v = live[fips], x = shiftOf(fips);
      if (x) {
        const { now, then, sh } = x;
        fill = shiftFill(sh, sides.party, 'R', bands);
        if (v[0] < 0.95) stillCounting.push(f);
        html = `<div class="tt-title">${esc(name)}</div>` +
          `<div class="tt-row"><span>2024 president</span><b>${sideLabel(then, 'D')}</b></div>` +
          `<div class="tt-row"><span>This race</span><b>${esc(sideLabel(now, tag))}</b></div>` +
          `<div class="tt-row"><span>Shift</span><b style="color:${sh >= 0 ? (sides.party === 'D' ? 'var(--dem)' : 'var(--ind)') : 'var(--rep)'}">${esc(sideLabel(sh, tag))}</b></div>` +
          `<div class="tt-row muted"><span>${Math.round(v[0] * 100)}% counted</span><span>${v[3].toLocaleString()} votes</span></div>`;
      } else {
        fill = v && v[3] > 0 ? 'var(--none)' : 'var(--novotes)';
        html = `<div class="tt-title">${esc(name)}</div><div class="muted">${v && v[3] > 0 ? 'No 2024 county result to compare with' : 'No votes counted yet'}</div>`;
      }
    } else if (liveMode) {
      const v = live && live[fips];
      if (waiting) fill = 'var(--await)';
      else if (v && v[3] > 0) {
        const m = 100 * (v[1] - v[2]) / v[3];
        fill = marginFill(m >= 0 ? race.leftParty : race.rightParty, m);
      }
      const dg = v && v[3] > 0 ? voteDigits({ left: v[1], right: v[2], total: v[3] }) : 2;
      html = `<div class="tt-title">${esc(name)}</div>` + (v && v[3] > 0
        ? `<div class="tt-row"><span><span class="party-chip ${race.leftParty}" style="margin-right:6px">${race.leftParty}</span>${esc(lastNameOf(race.left))}</span><b>${votePct(v[1] / v[3], dg)}</b></div>` +
          `<div class="tt-row"><span><span class="party-chip ${race.rightParty}" style="margin-right:6px">${race.rightParty}</span>${esc(lastNameOf(race.right))}</span><b>${votePct(v[2] / v[3], dg)}</b></div>` +
          `<div class="tt-row muted"><span>${Math.round(v[0] * 100)}% counted</span><span>${v[3].toLocaleString()} votes</span></div>`
        : `<div class="muted">${waiting ? 'Polls still open' : 'No votes counted yet'}</div>`);
      if (!waiting && !(v && v[3] > 0)) fill = 'var(--novotes)';
    } else {
      const b = base[fips];
      if (b && b[0] > 0) {
        const m = 100 * (b[1] - b[2]) / b[0];
        fill = marginFill(m >= 0 ? 'D' : 'R', m);
        const dg = voteDigits({ left: b[1], right: b[2], total: b[0] });
        html = `<div class="tt-title">${esc(name)}</div><div class="tt-row"><span>Harris (D)</span><b>${votePct(b[1] / b[0], dg)}</b></div><div class="tt-row"><span>Trump (R)</span><b>${votePct(b[2] / b[0], dg)}</b></div><div class="tt-row muted"><span>2024 president</span><span>${b[0].toLocaleString()} votes</span></div>`;
      } else html = `<div class="tt-title">${esc(name)}</div><div class="muted">No 2024 county result</div>`;
    }
    const p = s('path', { d: path(f), fill, class: 'county' });
    p.addEventListener('mousemove', (e) => tip.show(html, e));
    p.addEventListener('mouseleave', () => tip.hide());
    layer.appendChild(p);
  }
  if (stillCounting.length) {
    const stripes = hatchFill(svg);
    layer.appendChild(s('path', { d: stillCounting.map(f => path(f)).join(''), fill: stripes, class: 'hatch' }));
  }
  layer.appendChild(s('path', { d: path(topojson.mesh(topo, topo.objects.counties, (a, b) => a === b)), class: 'coast state-outline' }));
  let maxLeft = 0;
  if (VL) {
    // Largest first, so the small circles sit on top; area is proportional to the votes left.
    const items = fc.features.map(f => ({ f, x: VL.counties[f.properties.id] })).filter(b => b.x && b.x.left >= 1).sort((a, b) => b.x.left - a.x.left);
    maxLeft = items.length ? items[0].x.left : 0;
    const rMax = Math.min(W, H) * 0.07;
    const g = s('g', { class: 'vl-bubbles' });
    for (const { f, x } of items) {
      const [cx, cy] = path.centroid(f);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      const party = x.m === null ? null : x.m >= 0 ? race.leftParty : race.rightParty;
      const c = s('circle', { cx: cx.toFixed(1), cy: cy.toFixed(1), r: Math.max(1.5, rMax * Math.sqrt(x.left / maxLeft)).toFixed(2),
        fill: party ? marginFill(party, Math.abs(x.m)) : 'var(--novotes)', class: 'vl-bubble' });
      const html = tips.get(f.properties.id);
      c.addEventListener('mousemove', (e) => tip.show(html, e));
      c.addEventListener('mouseleave', () => tip.hide());
      g.appendChild(c);
    }
    layer.appendChild(g);
  }
  svg.appendChild(layer);
  const frame = h('div', { class: 'map-frame' }, svg);
  if (zoomKey && !compact) frame.appendChild(zoomButtons(attachZoom(svg, layer, { key: zoomKey, width: W, height: H, maxK: 10 })));
  frame.dataset.mode = VL ? 'left' : sides ? 'shift' : liveMode ? 'live' : 'baseline';
  if (compact && night) frame.appendChild(h('span', { class: 'map-tag' }, waiting ? 'Polls open' : liveMode ? (store.sim ? 'Simulated counts' : 'Live counts') : '2024 vote'));
  if (VL) return h('div', null, frame, maxLeft ? votesLeftKey(race, maxLeft) : null, votesLeftSummary(race, fc, VL, suffix));
  return sides && shiftKey ? h('div', null, frame, shiftKey(bands)) : frame;
}

const lastNameOf = (n) => String(n || '').split(' ').slice(-1)[0];
