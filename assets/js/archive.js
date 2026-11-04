// Past elections for the archive and the swing map: data loading, margins and shifts, and the national maps.
// The data comes from pipeline/build_archive.mjs (official returns compiled by the MIT Election Data and Science Lab).
import { h, s, esc, num, tooltip, marginFill, MARGIN_BANDS, SHIFT_BANDS, shiftFill, partyVar } from './ui.js';
import { store } from './store.js';
import { loadGeo, cachedGeo } from './geo.js';
import { attachZoom, zoomButtons } from './maps.js';

export const ARCHIVE = '/data/archive';
export const COUNTY_GEO = '/data/geo/counties-us.json';
export const PRES_YEARS = [1976, 1980, 1984, 1988, 1992, 1996, 2000, 2004, 2008, 2012, 2016, 2020, 2024];
export const COUNTY_YEARS = PRES_YEARS.filter(y => y >= 2000);
export const yearUrl = (y) => `${ARCHIVE}/${y}.json`;
export const countiesUrl = (y) => `${ARCHIVE}/counties-${y}.json`;
export const PRESIDENT_URL = `${ARCHIVE}/president.json`;
export const INDEX_URL = `${ARCHIVE}/index.json`;

/** Load JSON files (cached for the visit), then build; a skeleton holds the place until they arrive. */
export function withData(urls, build, height = 380) {
  const have = urls.map(u => cachedGeo(u));
  if (have.every(Boolean)) return build(...have);
  // 'map' keeps the national maps' shape while loading, so the page doesn't jump when they arrive.
  const holder = h('div', { class: 'skeleton map-skeleton', style: height === 'map' ? { aspectRatio: '975 / 610' } : { height: `${height}px` } });
  Promise.all(urls.map(loadGeo))
    .then(data => { if (holder.isConnected) holder.replaceWith(build(...data)); })
    .catch(() => { if (holder.isConnected) holder.replaceWith(h('div', { class: 'empty small' }, 'This could not be loaded. Try again in a moment.')); });
  return holder;
}

// ------------------------------------------------------------------------------------------- numbers

/** Democratic minus Republican share, in points of all votes cast. */
export const marginOf = (T, D, R) => (T > 0 ? (100 * (D - R)) / T : null);
export const marginFillDR = (m) => (m === null || m === undefined ? 'var(--none)' : marginFill(m >= 0 ? 'D' : 'R', Math.abs(m)));
/** 'D+4.2', 'R+12.0' or 'Even'. */
export function marginLabel(m, d = 1) {
  if (m === null || m === undefined || Number.isNaN(m)) return '—';
  const v = Math.abs(m);
  return v < 0.5 * 10 ** -d ? 'Even' : `${m > 0 ? 'D' : 'R'}+${v.toFixed(d)}`;
}
export const partyOfMargin = (m) => (m >= 0 ? 'D' : 'R');

// A shift is the change in that margin from one election to the next, positive toward Democrats (ui.js shiftFill).
export { SHIFT_BANDS, shiftFill };
/** 'D+2.3' (toward Democrats), 'R+5.1', or 'No change'. */
export function shiftLabel(sh, d = 1) {
  if (sh === null || sh === undefined || Number.isNaN(sh)) return '—';
  const v = Math.abs(sh);
  return v < 0.5 * 10 ** -d ? 'No change' : `${sh > 0 ? 'D' : 'R'}+${v.toFixed(d)}`;
}
export const shiftWords = (sh) => (Math.abs(sh) < 0.05 ? 'no change' : `${Math.abs(sh).toFixed(1)} points toward ${sh > 0 ? 'Democrats' : 'Republicans'}`);
export const pctOf = (v, T) => (T > 0 ? `${((100 * v) / T).toFixed(1)}%` : '—');

/** Two-letter code for a state FIPS code, D.C. included. */
let FIPS_ST = null;
export function stateOfFips(f) {
  if (!FIPS_ST) { FIPS_ST = Object.fromEntries(store.states.map(st => [st.fips, st.code])); FIPS_ST['11'] = 'DC'; }
  return FIPS_ST[String(f).slice(0, 2)];
}
export const stateName = (code) => (code === 'DC' ? 'District of Columbia' : store.stateByCode[code]?.name || code);

// Places the county files show as a whole state: Alaska reports by state House district, and Connecticut's
// counties were replaced by planning regions in 2022, so its older county returns don't fit today's map.
export const WHOLE_STATE = {
  AK: 'Alaska reports its votes by state House district, not by borough, so it is shown as a whole.',
  CT: 'Connecticut’s county returns use the counties it replaced with planning regions in 2022, so it is shown as a whole.',
};

// ------------------------------------------------------------------------------------------- arrows

/**
 * One arrow per place: from (x, y), leaning up and pointing left toward Democrats or right toward Republicans,
 * length k pixels per point of shift (capped). Returns two path strings, so thousands of arrows cost two elements.
 */
export function arrowPaths(items, { k = 1.6, cap = 42, min = 0.1 } = {}) {
  const out = { D: '', R: '' };
  const cos = Math.cos(Math.PI / 5.2), sin = Math.sin(Math.PI / 5.2);   // about 35 degrees above level
  for (const { x, y, sh } of items) {
    if (sh === null || sh === undefined || Math.abs(sh) < min) continue;
    const len = Math.min(cap, Math.abs(sh) * k);
    const dir = sh > 0 ? -1 : 1;
    const ex = x + dir * len * cos, ey = y - len * sin;
    // Arrowhead: two short strokes back from the tip, 28 degrees either side of the shaft.
    const hl = Math.min(5, Math.max(2.2, len * 0.42));
    const ang = Math.atan2(ey - y, ex - x);
    const hx = (a) => (ex - hl * Math.cos(ang + a)).toFixed(1), hy = (a) => (ey - hl * Math.sin(ang + a)).toFixed(1);
    out[sh > 0 ? 'D' : 'R'] += `M${x.toFixed(1)} ${y.toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}M${hx(0.5)} ${hy(0.5)}L${ex.toFixed(1)} ${ey.toFixed(1)}L${hx(-0.5)} ${hy(-0.5)}`;
  }
  return out;
}
function arrowLayer(items, opts) {
  const p = arrowPaths(items, opts);
  return s('g', { class: 'shift-arrows', 'pointer-events': 'none' },
    s('path', { d: p.D, class: 'arrow D' }), s('path', { d: p.R, class: 'arrow R' }));
}

/** The arrow key: a sample arrow each way for `pts` points, drawn at the map's scale. */
export function arrowKey({ k = 1.6, pts = 10, caption = 'Shift in the margin' } = {}) {
  const sample = (sh) => {
    const len = Math.min(42, Math.abs(sh) * k);
    const w = Math.ceil(len) + 12;
    const p = arrowPaths([{ x: sh > 0 ? w - 4 : 4, y: 18, sh }], { k });
    return s('svg', { width: w, height: 22, viewBox: `0 0 ${w} 22`, class: 'arrow-sample', 'aria-hidden': 'true' },
      s('path', { d: p.D || p.R, class: `arrow ${sh > 0 ? 'D' : 'R'}` }));
  };
  return h('div', { class: 'legend arrow-key' },
    h('span', null, sample(pts), `${pts} points toward Democrats`),
    h('span', null, sample(-pts), `${pts} points toward Republicans`),
    h('span', { class: 'muted' }, caption));
}

/** The shift key: the four shades each way, labelled in points. left/right: the parties at each end. */
export function shiftLegend({ caption = 'shift in the margin (points)', left = 'D', right = 'R', leftName = 'Democrats', rightName = 'Republicans',
  extras = [['var(--none)', 'No result']], bands = SHIFT_BANDS } = {}) {
  const cells = [...bands.map(b => [1, b]), ...[...bands].reverse().map(b => [-1, b])];
  return h('div', { class: 'rscale' },
    h('div', { class: 'rs-main' },
      h('div', { class: 'rs-cap' }, h('span', { style: { color: partyVar(left) } }, `Toward ${leftName}`), h('span', null, caption), h('span', { style: { color: partyVar(right) } }, `Toward ${rightName}`)),
      h('div', { class: 'rs-bar' }, cells.map(([dir, b]) => h('span', { style: { background: shiftFill(dir * (b.min + 0.01), left, right, bands) } }))),
      h('div', { class: 'rs-labels' }, cells.map(([, b]) => h('span', null, b.range)))),
    extras.length ? h('div', { class: 'rs-grey' }, extras.map(([c, label]) => h('span', null, c === 'hatch' ? h('i', { class: 'lg-hatch' }) : h('i', { style: { background: c } }), label))) : null);
}

/** The margin key: the site's margin scale, as a result rather than a projection. */
export function resultLegend() {
  const cells = [...MARGIN_BANDS.map(b => ['D', b]), ...[...MARGIN_BANDS].reverse().map(b => ['R', b])];
  return h('div', { class: 'rscale' },
    h('div', { class: 'rs-main' },
      h('div', { class: 'rs-cap' }, h('span', { style: { color: partyVar('D') } }, 'Democrat'), h('span', null, 'margin of victory (points)'), h('span', { style: { color: partyVar('R') } }, 'Republican')),
      h('div', { class: 'rs-bar' }, cells.map(([party, b]) => h('span', { style: { background: marginFill(party, b.min || 0.5) } }))),
      h('div', { class: 'rs-labels' }, cells.map(([, b]) => h('span', null, b.range)))));
}

// ------------------------------------------------------------------------------------------- national county map

const W = 975, H = 610;
let countyCache = null;

function countyShapes(topo) {
  if (countyCache && countyCache.topo === topo) return countyCache;
  const proj = d3.geoAlbersUsa().scale(1300).translate([487.5, 305]);   // the same projection as the district map
  const path = d3.geoPath(proj);
  const feats = [];
  for (const f of topojson.feature(topo, topo.objects.counties).features) {
    const d = path(f);
    if (!d) continue;
    feats.push({ id: f.properties.id, n: f.properties.n, st: stateOfFips(f.properties.id), d, c: path.centroid(f), b: path.bounds(f) });
  }
  const sameState = (a, b) => a.properties.id.slice(0, 2) === b.properties.id.slice(0, 2);
  const borders = path(topojson.mesh(topo, topo.objects.counties, (a, b) => a !== b && !sameState(a, b)));
  const coast = path(topojson.mesh(topo, topo.objects.counties, (a, b) => a === b));
  const stateBounds = {};
  for (const f of feats) {
    const sb = stateBounds[f.st] || [[Infinity, Infinity], [-Infinity, -Infinity]];
    sb[0][0] = Math.min(sb[0][0], f.b[0][0]); sb[0][1] = Math.min(sb[0][1], f.b[0][1]);
    sb[1][0] = Math.max(sb[1][0], f.b[1][0]); sb[1][1] = Math.max(sb[1][1], f.b[1][1]);
    stateBounds[f.st] = sb;
  }
  countyCache = { topo, feats, borders, coast, stateBounds };
  return countyCache;
}

/**
 * Where to start a state's arrow: the centre of its largest piece on the state map (the same projection), so
 * Michigan's lands on the lower peninsula rather than in the lake, and Hawaii's on an island.
 */
let centroidCache = null;
export function stateCentroids() {
  if (centroidCache) return centroidCache;
  const geo = store.geo;
  const path = d3.geoPath();
  const out = {};
  for (const f of topojson.feature(geo, geo.objects.states).features) {
    const code = stateOfFips(String(f.id).padStart(2, '0'));
    if (!code) continue;
    let shape = f;
    if (f.geometry.type === 'MultiPolygon') {
      const parts = f.geometry.coordinates.map(c => ({ type: 'Polygon', coordinates: c }));
      shape = parts.reduce((a, b) => (path.area(b) > path.area(a) ? b : a));
    }
    out[code] = path.centroid(shape);
  }
  centroidCache = out;
  return out;
}

/**
 * Every county on one map, with zoom. fill(f) colours a county (f: { id, n, st }); tip(f) gives its tooltip HTML;
 * arrows: [{ x, y, sh }] in map pixels (see arrowPaths); key remembers the zoom across redraws.
 */
export function nationalCountyMap(topo, { fill, tip, arrows = null, arrowScale = 1.6, key = 'county-nation', label = 'Map of every county' } = {}) {
  const shapes = countyShapes(topo);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: `district-map county-nation${arrows ? ' with-arrows' : ''}`, role: 'img', 'aria-label': label });
  const layer = s('g');
  const counties = s('g', { class: 'counties' });
  shapes.feats.forEach((f, i) => counties.appendChild(s('path', { d: f.d, fill: fill(f), class: 'county', 'data-i': i })));
  layer.append(counties, s('path', { d: shapes.borders, class: 'state-borders' }), s('path', { d: shapes.coast, class: 'coast' }));
  if (arrows) layer.appendChild(arrowLayer(arrows, { k: arrowScale }));
  svg.appendChild(layer);
  const t = tooltip();
  const featAt = (e) => { const i = e.target?.dataset?.i; return i === undefined ? null : shapes.feats[+i]; };
  counties.addEventListener('mousemove', (e) => { const f = featAt(e); const html = f && tip ? tip(f) : null; if (html) t.show(html, e); else t.hide(); });
  counties.addEventListener('mouseleave', () => t.hide());
  let api = null;
  counties.addEventListener('click', (e) => {
    const f = featAt(e);
    if (!f || !api) return;
    t.hide();
    const b = shapes.stateBounds[f.st];
    if (api.k < 2.2 && b && b[1][0] - b[0][0] < 600) api.to(b, 12);
  });
  api = attachZoom(svg, layer, { key, width: W, height: H, maxK: 24 });
  const select = h('select', { class: 'input zoom-select', 'aria-label': 'Zoom to a state' },
    h('option', { value: '' }, 'Zoom to a state…'),
    [...store.states, { code: 'DC', name: 'District of Columbia' }].filter(st => shapes.stateBounds[st.code]).sort((a, b) => a.name.localeCompare(b.name))
      .map(st => h('option', { value: st.code }, st.name)));
  select.addEventListener('change', () => { const b = shapes.stateBounds[select.value]; if (b) api.to(b, 14); else api.reset(); });
  return h('div', { class: 'map-frame' }, svg, zoomButtons(api), select);
}

/** County centres in map pixels, for arrows: { fips: [x, y] }. */
export function countyCentres(topo) {
  return Object.fromEntries(countyShapes(topo).feats.map(f => [f.id, f.c]));
}

// ------------------------------------------------------------------------------------------- state map

const CALLOUTS = ['VT', 'NH', 'MA', 'RI', 'CT', 'NJ', 'DE', 'MD', 'DC'];

/**
 * The states (and D.C.) on one map: fill(code) colours a state, null for "no race"; tip(code) gives its tooltip;
 * arrows: [{ code, sh }] start at each state's centre. Small north-eastern states and D.C. also get callout boxes.
 */
export function nationalStateMap({ fill, tip, arrows = null, arrowScale = 2.4, onClick = null, label = 'Map of the states' } = {}) {
  const geo = store.geo;
  const path = d3.geoPath();
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'archive-states', role: 'img', 'aria-label': label });
  const t = tooltip();
  const hover = (el, code) => {
    if (!tip) return;
    el.addEventListener('mousemove', (e) => { const html = tip(code); if (html) t.show(html, e); });
    el.addEventListener('mouseleave', () => t.hide());
    if (onClick) { el.style.cursor = 'pointer'; el.addEventListener('click', () => { t.hide(); onClick(code); }); }
  };
  for (const f of topojson.feature(geo, geo.objects.states).features) {
    const code = stateOfFips(String(f.id).padStart(2, '0'));
    if (!code) continue;
    const p = s('path', { d: path(f), class: 'state', fill: fill(code) || 'var(--norace)' });
    hover(p, code);
    svg.appendChild(p);
  }
  svg.appendChild(s('path', { d: path(topojson.mesh(geo, geo.objects.states, (a, b) => a !== b)), fill: 'none', stroke: 'var(--surface)', 'stroke-width': 0.8, 'pointer-events': 'none' }));
  if (arrows) {
    const at = stateCentroids();
    svg.appendChild(arrowLayer(arrows.filter(a => at[a.code]).map(a => ({ x: at[a.code][0], y: at[a.code][1], sh: a.sh })), { k: arrowScale, cap: 60 }));
  }
  let yy = 196;
  for (const code of CALLOUTS) {
    const box = s('g', { transform: `translate(914, ${yy})` });
    box.appendChild(s('rect', { width: 18, height: 14, rx: 3, fill: fill(code) || 'var(--norace)', stroke: 'var(--line-2)', 'stroke-width': 0.5 }));
    box.appendChild(s('text', { x: 23, y: 11, style: 'font-size:11px;font-weight:600' }, code));
    hover(box, code);
    svg.appendChild(box);
    yy += 20;
  }
  return h('div', { class: 'map-wrap chart' }, svg);
}

// ------------------------------------------------------------------------------------------- tooltips

/** A tooltip row: label on the left, value on the right. */
export const ttRow = (label, value, muted = false) => `<div class="tt-row${muted ? ' muted' : ''}"><span>${label}</span><b>${value}</b></div>`;
export const ttTitle = (text) => `<div class="tt-title">${esc(text)}</div>`;
export const votesText = (n) => `${num(n)} votes`;
