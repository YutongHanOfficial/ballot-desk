// District maps: the national House map (geographic or equal-size hexagons) and per-state district maps.
// Boundaries are the Census Bureau's 2026 (120th Congress) districts, built by pipeline/build_geo.mjs.
import { h, s, probColor, partyVar, tooltip } from './ui.js';
import { store, cur, awaiting } from './store.js';
import { raceTip, mapLegend, BAND_LEGEND } from './charts.js';

const d3 = window.d3;
const topojson = window.topojson;

// ------------------------------------------------------------------------------------------- loading

const cache = new Map();
const pending = new Map();

export function loadGeo(url) {
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  if (!pending.has(url)) {
    pending.set(url, fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); })
      .then(d => { cache.set(url, d); return d; })
      .catch(e => { pending.delete(url); throw e; }));
  }
  return pending.get(url);
}

/** Build immediately when the files are cached; otherwise show a placeholder and swap the map in on arrival. */
function withGeo(urls, build, height) {
  const have = urls.map(u => cache.get(u));
  if (have.every(Boolean)) return build(...have);
  const holder = h('div', { class: 'skeleton map-skeleton', style: { height: `${height}px` } });
  Promise.all(urls.map(loadGeo))
    .then(data => { if (holder.isConnected) holder.replaceWith(build(...data)); })
    .catch(() => { if (holder.isConnected) holder.replaceWith(h('div', { class: 'empty small' }, 'The map could not be loaded.')); });
  return holder;
}

// ------------------------------------------------------------------------------------------- colour

export function raceFill(r) {
  if (!r || awaiting(r)) return 'var(--none)';
  if (!r.left || !r.right) return partyVar((r.left ? r.leftParty : r.rightParty) || r.samePartyGeneral, 1);
  return probColor(cur(r).p, r.leftParty, r.rightParty);
}

function hoverable(el, r, tipFn = raceTip) {
  const tip = tooltip();
  el.addEventListener('mousemove', (e) => tip.show(tipFn(r), e));
  el.addEventListener('mouseleave', () => tip.hide());
  return tip;
}

// ------------------------------------------------------------------------------------------- zoom

const ZOOM = {};   // remembered transforms, so the live re-render every minute doesn't reset the view

function attachZoom(svg, layer, { key, width, height, maxK = 16, onZoom }) {
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

function zoomButtons(api, extra = []) {
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
export function houseMap({ id = 'house', caption = true, fill = raceFill, tip = raceTip } = {}) {
  VIEW.mode = VIEW.mode || pref('houseMapMode') || 'geo';
  const wrap = h('div', { class: 'house-map' });
  const body = h('div', { class: 'map-body' });
  const seg = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Map style' });
  const opts = [['geo', 'Geographic'], ['hex', 'Equal-size']];
  const draw = () => {
    seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', opts[i][0] === VIEW.mode));
    body.replaceChildren(VIEW.mode === 'hex'
      ? withGeo(['data/geo/house-hex.json'], (hex) => hexMap(hex, { fill, tip }), 420)
      : withGeo(['data/geo/districts-2026.json'], (topo) => geoMap(topo, id, { fill, tip }), 420));
  };
  for (const [k, label] of opts) {
    seg.appendChild(h('button', { type: 'button', onclick: () => { VIEW.mode = k; pref('houseMapMode', k); draw(); } }, label));
  }
  wrap.append(h('div', { class: 'map-toolbar' }, seg,
    caption ? h('span', { class: 'xs muted map-hint' }, VIEW.mode === 'hex' ? 'Every district the same size' : 'Click a state to zoom · pinch or Ctrl/⌘-scroll') : null),
    body, mapLegend(BAND_LEGEND.slice(0, 8)));
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
        else location.hash = r.url;
      });
    }
    layer.appendChild(p);
    if (r && r.district) {
      const t = s('text', { x: f.c[0].toFixed(1), y: f.c[1].toFixed(1), 'data-w': f.w.toFixed(1) }, String(r.district));
      labels.appendChild(t);
    }
  }
  layer.append(
    s('path', { d: shapes.borders, class: 'state-borders' }),
    s('path', { d: shapes.coast, class: 'coast' }),
    labels);
  svg.appendChild(layer);
  const placeLabels = (t) => {
    const k = t ? t.k : 1;
    labels.style.fontSize = `${11 / k}px`;
    labels.style.display = k >= 1.9 ? '' : 'none';
    if (k >= 1.9) for (const el of labels.children) el.style.display = (+el.dataset.w * k > 20) ? '' : 'none';
  };
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

function hexMap(hex, { fill = raceFill, tip: tipFn = raceTip } = {}) {
  const svg = s('svg', { viewBox: `0 0 ${hex.width} ${hex.height}`, class: 'hex-map', role: 'img', 'aria-label': 'Equal-size map of all 435 House districts' });
  for (const [id, [x, y]] of Object.entries(hex.cells)) {
    const r = store.byId[id];
    const poly = s('polygon', { points: hexPoints(x, y, hex.r * 0.93), fill: fill(r), class: 'hex' });
    if (r) {
      const tip = hoverable(poly, r, tipFn);
      poly.addEventListener('click', () => { tip.hide(); location.hash = r.url; });
    }
    svg.appendChild(poly);
  }
  svg.appendChild(s('path', { d: hex.borders, class: 'hex-borders' }));
  const lab = s('g', { class: 'hex-labels', style: `font-size:${(hex.r * 0.78).toFixed(1)}px` });
  for (const [st, [x, y]] of Object.entries(hex.labels)) lab.appendChild(s('text', { x, y: y + hex.r * 0.28 }, st));
  svg.appendChild(lab);
  return h('div', { class: 'map-frame hex-frame' }, svg);
}

// ------------------------------------------------------------------------------------------- state maps

/** One state's districts, coloured by forecast. highlight = race id to spotlight (race-page locator). */
export function stateDistrictMap(code, { highlight = null, width = 720, maxHeight = 560, zoomKey = null } = {}) {
  return withGeo([`data/geo/cd/${code}.json`], (topo) => buildStateMap(code, topo, { highlight, width, maxHeight, zoomKey }), Math.min(maxHeight, 360));
}

function buildStateMap(code, topo, { highlight, width: W, maxHeight, zoomKey }) {
  const fc = topojson.feature(topo, topo.objects.districts);
  const [[west, south], [east, north]] = d3.geoBounds(fc);
  const lon = west > east ? ((west + east + 360) / 2 + 180) % 360 - 180 : (west + east) / 2;   // Alaska spans 180°
  const proj = d3.geoConicConformal().rotate([-lon, 0]).parallels([south + (north - south) / 3, north - (north - south) / 3]);
  const target = highlight ? fc.features.find(f => f.properties.id === highlight) : null;
  proj.fitWidth(W - 20, fc);
  let path = d3.geoPath(proj);
  // Frame the whole state, or, for a small urban district, its neighbourhood.
  let box = path.bounds(fc);
  if (target) {
    const tb = path.bounds(target);
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
      p.addEventListener('click', () => { tip.hide(); if (!isTarget) location.hash = r.url; });
    }
    layer.appendChild(p);
    const area = path.area(f);
    if (r && r.district && (area > 700 || isTarget)) {
      const [cx, cy] = path.centroid(f);
      if (Number.isFinite(cx)) labels.appendChild(s('text', { x: cx.toFixed(1), y: (cy + 4).toFixed(1), class: isTarget ? 'target' : '' }, String(r.district)));
    }
  }
  if (target) layer.appendChild(s('path', { d: path(target), class: 'target-outline' }));
  layer.appendChild(s('path', { d: path(topojson.mesh(topo, topo.objects.districts, (a, b) => a === b)), class: 'coast' }));
  layer.appendChild(labels);
  svg.appendChild(layer);
  if (!zoomKey) return h('div', { class: 'map-frame' }, svg);
  const api = attachZoom(svg, layer, { key: zoomKey, width: W, height: H, maxK: 12, onZoom: (t) => { labels.style.fontSize = `${12 / t.k}px`; } });
  if (ZOOM[zoomKey]) labels.style.fontSize = `${12 / ZOOM[zoomKey].k}px`;
  return h('div', { class: 'map-frame' }, svg, zoomButtons(api));
}
