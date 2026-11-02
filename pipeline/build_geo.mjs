#!/usr/bin/env node
// Build the district map files from the Census Bureau's TIGER/Line 2026 congressional districts (120th
// Congress, the lines used in the November 2026 election, including the mid-decade redraws).
//
//   data/geo/districts-2026.json   all 435 districts (TopoJSON, lon/lat), simplified for the national map
//   data/geo/cd/XX.json            one state's districts at higher detail, for state and race pages
//   data/geo/house-hex.json        equal-size hexagon layout, one hex per district
//
// One-time build: `npm install && npm run geo` (needs `unzip`). The output is committed; the GitHub Action
// never runs this.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as d3 from 'd3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'pipeline', '.cache', 'geo');
const OUT = path.join(ROOT, 'data', 'geo');
const MS = process.env.MAPSHAPER || path.join(ROOT, 'node_modules', '.bin', 'mapshaper');

const FIPS = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '12': 'FL', '13': 'GA',
  '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD',
  '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ',
  '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC',
  '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY',
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const ms = (...args) => execFileSync(MS, args, { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 30 });

async function download(url, file) {
  if (fs.existsSync(file)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

function districtId(p) {
  const st = FIPS[p.STATEFP];
  const d = parseInt(p.CD120FP, 10);
  return { id: !d ? `${st}-AL` : `${st}-${String(d).padStart(2, '0')}`, st, d: d || 0 };
}

/** Replace Census attributes with { id, st, d } and drop anything that is not a voting district. */
function tidy(topo) {
  const obj = Object.values(topo.objects)[0];
  obj.geometries = obj.geometries.filter(g => FIPS[g.properties.STATEFP]);
  for (const g of obj.geometries) g.properties = districtId(g.properties);
  topo.objects = { districts: obj };
  return topo;
}

// ------------------------------------------------------------------------------------------- hex layout

/**
 * Equal-size cartogram: states become Dorling circles sized by seat count (pulled toward their geographic
 * centres), each circle is filled with a contiguous blob of hexagons, and districts are matched to hexes
 * inside their state by rank-normalised position so the layout keeps rough geography.
 */
function hexLayout(dists, s) {
  const hexArea = 1.5 * Math.sqrt(3) * s * s;
  const W = Math.sqrt(3) * s, H = 1.5 * s;
  const byState = d3.group(dists, d => d.st);
  // Pull every state toward the seat-weighted centre so the sparse West closes up while the crowded
  // Northeast spreads out (the collision force does the spreading).
  const cx0 = d3.mean(dists, d => d.x), cy0 = d3.mean(dists, d => d.y);
  const nodes = [...byState].map(([st, ds]) => {
    const x = d3.mean(ds, d => d.x), y = d3.mean(ds, d => d.y);
    return { st, n: ds.length, gx: cx0 + (x - cx0) * 0.74, gy: cy0 + (y - cy0) * 0.8, r: Math.sqrt(ds.length * hexArea / Math.PI) };
  });
  nodes.forEach(n => { n.x = n.gx; n.y = n.gy; });
  const sim = d3.forceSimulation(nodes)
    .force('x', d3.forceX(d => d.gx).strength(0.05))
    .force('y', d3.forceY(d => d.gy).strength(0.05))
    .force('collide', d3.forceCollide(d => d.r + s * 0.12).iterations(10))
    .stop();
  for (let i = 0; i < 1500; i++) sim.tick();

  const key = (q, r) => `${q},${r}`;
  const center = (q, r) => [q * W + ((r & 1) ? W / 2 : 0), r * H];
  const nearest = (x, y) => { const r = Math.round(y / H); return [Math.round((x - ((r & 1) ? W / 2 : 0)) / W), r]; };
  const neighbors = (q, r) => (r & 1)
    ? [[q + 1, r], [q - 1, r], [q, r - 1], [q + 1, r - 1], [q, r + 1], [q + 1, r + 1]]
    : [[q + 1, r], [q - 1, r], [q - 1, r - 1], [q, r - 1], [q - 1, r + 1], [q, r + 1]];
  const owner = new Map();
  const dist2 = (q, r, nd) => { const [cx, cy] = center(q, r); return (cx - nd.x) ** 2 + (cy - nd.y) ** 2; };

  // Big states claim their space first; small ones then fit around them.
  nodes.sort((a, b) => b.n - a.n);
  for (const nd of nodes) {
    let [q0, r0] = nearest(nd.x, nd.y);
    if (owner.has(key(q0, r0))) {
      let best = null, bestD = Infinity;
      for (let dq = -12; dq <= 12; dq++) for (let dr = -12; dr <= 12; dr++) {
        const q = q0 + dq, r = r0 + dr;
        if (owner.has(key(q, r))) continue;
        const dd = dist2(q, r, nd);
        if (dd < bestD) { bestD = dd; best = [q, r]; }
      }
      [q0, r0] = best;
    }
    const cells = [[q0, r0]];
    owner.set(key(q0, r0), nd.st);
    while (cells.length < nd.n) {
      let best = null, bestD = Infinity;
      for (const [q, r] of cells) for (const [nq, nr] of neighbors(q, r)) {
        if (owner.has(key(nq, nr))) continue;
        const dd = dist2(nq, nr, nd);
        if (dd < bestD) { bestD = dd; best = [nq, nr]; }
      }
      if (!best) throw new Error(`hex layout: ${nd.st} is boxed in; adjust spacing`);
      cells.push(best);
      owner.set(key(best[0], best[1]), nd.st);
    }
    nd.cells = cells;
  }

  fillHoles(nodes, owner, neighbors, key, center);

  // Match districts to their state's hexes (rank-normalised coordinates, greedy then pairwise swaps).
  const rank = (vals) => { const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const out = new Array(vals.length); idx.forEach(([, i], k) => { out[i] = vals.length > 1 ? k / (vals.length - 1) : 0.5; }); return out; };
  const cellOf = {};
  for (const nd of nodes) {
    const ds = byState.get(nd.st);
    const pts = nd.cells.map(([q, r]) => center(q, r));
    const dx = rank(ds.map(d => d.x)), dy = rank(ds.map(d => d.y));
    const cx = rank(pts.map(p => p[0])), cy = rank(pts.map(p => p[1]));
    const cost = (i, j) => (dx[i] - cx[j]) ** 2 + (dy[i] - cy[j]) ** 2;
    const assign = new Array(ds.length).fill(-1), used = new Set();
    const pairs = [];
    for (let i = 0; i < ds.length; i++) for (let j = 0; j < pts.length; j++) pairs.push([cost(i, j), i, j]);
    pairs.sort((a, b) => a[0] - b[0]);
    for (const [, i, j] of pairs) if (assign[i] < 0 && !used.has(j)) { assign[i] = j; used.add(j); }
    for (let pass = 0, improved = true; improved && pass < 50; pass++) {
      improved = false;
      for (let a = 0; a < ds.length; a++) for (let b = a + 1; b < ds.length; b++) {
        const now = cost(a, assign[a]) + cost(b, assign[b]);
        const swap = cost(a, assign[b]) + cost(b, assign[a]);
        if (swap < now - 1e-9) { [assign[a], assign[b]] = [assign[b], assign[a]]; improved = true; }
      }
    }
    ds.forEach((d, i) => { cellOf[d.id] = { q: nd.cells[assign[i]][0], r: nd.cells[assign[i]][1], st: nd.st }; });
  }

  // Hex outlines between different states, as one SVG path.
  const cornersOf = (x, y) => d3.range(6).map(k => { const a = Math.PI / 180 * (60 * k - 30); return [x + s * Math.cos(a), y + s * Math.sin(a)]; });
  // neighbour direction -> edge (corner pair) for pointy-top hexes
  const edgeFor = (q, r, nq, nr) => {
    const [x, y] = center(q, r), [nx, ny] = center(nq, nr);
    const ang = Math.atan2(ny - y, nx - x) * 180 / Math.PI; // 0 = east
    const k = Math.round(((ang + 360) % 360) / 60) % 6;      // 0 E, 1 SE, 2 SW, 3 W, 4 NW, 5 NE
    const c = cornersOf(x, y);
    return [[c[0], c[1]], [c[1], c[2]], [c[2], c[3]], [c[3], c[4]], [c[4], c[5]], [c[5], c[0]]][k];
  };
  let border = '';
  const allXY = [];
  for (const [k, st] of owner) {
    const [q, r] = k.split(',').map(Number);
    const [x, y] = center(q, r);
    allXY.push([x, y]);
    for (const [nq, nr] of neighbors(q, r)) {
      const other = owner.get(key(nq, nr));
      if (other === st) continue;
      if (other && `${nq},${nr}` < k) continue; // shared edge: draw once
      const [a, b] = edgeFor(q, r, nq, nr);
      border += `M${a[0].toFixed(1)},${a[1].toFixed(1)}L${b[0].toFixed(1)},${b[1].toFixed(1)}`;
    }
  }
  const xs = allXY.map(p => p[0]), ys = allXY.map(p => p[1]);
  const pad = s * 1.5;
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  const width = Math.max(...xs) + pad - x0, height = Math.max(...ys) + pad - y0;
  const cells = {};
  for (const [id, c] of Object.entries(cellOf)) {
    const [x, y] = center(c.q, c.r);
    cells[id] = [+(x - x0).toFixed(1), +(y - y0).toFixed(1)];
  }
  const labels = {};
  for (const nd of nodes) {
    const pts = nd.cells.map(([q, r]) => center(q, r));
    labels[nd.st] = [+(d3.mean(pts, p => p[0]) - x0).toFixed(1), +(d3.mean(pts, p => p[1]) - y0).toFixed(1)];
  }
  // shift the border path into the same frame
  border = border.replace(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g, (_, a, b) => `${(+a - x0).toFixed(1)},${(+b - y0).toFixed(1)}`);
  return { r: s, width: +width.toFixed(1), height: +height.toFixed(1), cells, labels, borders: border };
}

/**
 * Close gaps the circle packing leaves between states: an empty hex mostly surrounded by occupied ones is
 * taken over by a neighbouring state, which gives up one of its outermost hexes, as long as the state stays
 * in one piece.
 */
function fillHoles(nodes, owner, neighbors, key, center) {
  const cellsOf = new Map(nodes.map(n => [n.st, new Set(n.cells.map(([q, r]) => key(q, r)))]));
  const parse = (k) => k.split(',').map(Number);
  const emptyAround = (k) => neighbors(...parse(k)).filter(([q, r]) => !owner.has(key(q, r))).length;
  const connected = (set) => {
    const start = set.values().next().value;
    const seen = new Set([start]), stack = [start];
    while (stack.length) {
      const k = stack.pop();
      for (const [q, r] of neighbors(...parse(k))) {
        const nk = key(q, r);
        if (set.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    return seen.size === set.size;
  };
  for (const [enclosed, exposed] of [[6, 3], [5, 3], [4, 3]]) {
    for (let iter = 0; iter < 400; iter++) {
      const holes = new Map();
      for (const k of owner.keys()) for (const [q, r] of neighbors(...parse(k))) {
        const nk = key(q, r);
        if (!owner.has(nk)) holes.set(nk, (holes.get(nk) || 0) + 1);
      }
      const targets = [...holes].filter(([, c]) => c >= enclosed).sort((a, b) => b[1] - a[1]);
      let moved = false;
      for (const [hk] of targets) {
        if (owner.has(hk)) continue;
        const [hq, hr] = parse(hk);
        const [hx, hy] = center(hq, hr);
        const adj = {};
        for (const [q, r] of neighbors(hq, hr)) { const o = owner.get(key(q, r)); if (o) adj[o] = (adj[o] || 0) + 1; }
        for (const st of Object.keys(adj).sort((a, b) => adj[b] - adj[a])) {
          const set = cellsOf.get(st);
          const donors = [...set].filter(k => emptyAround(k) >= exposed)
            .sort((a, b) => { const [ax, ay] = center(...parse(a)), [bx, by] = center(...parse(b)); return ((bx - hx) ** 2 + (by - hy) ** 2) - ((ax - hx) ** 2 + (ay - hy) ** 2); });
          for (const dk of donors) {
            set.delete(dk); set.add(hk);
            if (connected(set)) { owner.delete(dk); owner.set(hk, st); moved = true; break; }
            set.delete(hk); set.add(dk);
          }
          if (owner.get(hk) === st) break;
        }
      }
      if (!moved) break;
    }
  }
  // Any hole still enclosed (found by flood-filling the sea from outside the map) is walked outward:
  // a neighbouring hex farther from the middle slides into it until the hole reaches the coastline.
  let mx = 0, my = 0;
  for (const k of owner.keys()) { const [x, y] = center(...parse(k)); mx += x; my += y; }
  mx /= owner.size; my /= owner.size;
  const fromMid = (k) => { const [x, y] = center(...parse(k)); return (x - mx) ** 2 + (y - my) ** 2; };
  const sea = () => {
    let q0 = Infinity, q1 = -Infinity, r0 = Infinity, r1 = -Infinity;
    for (const k of owner.keys()) { const [q, r] = parse(k); q0 = Math.min(q0, q); q1 = Math.max(q1, q); r0 = Math.min(r0, r); r1 = Math.max(r1, r); }
    q0 -= 2; q1 += 2; r0 -= 2; r1 += 2;
    const out = new Set(), stack = [];
    const push = (q, r) => { const k = key(q, r); if (!owner.has(k) && !out.has(k)) { out.add(k); stack.push([q, r]); } };
    for (let q = q0; q <= q1; q++) { push(q, r0); push(q, r1); }
    for (let r = r0; r <= r1; r++) { push(q0, r); push(q1, r); }
    while (stack.length) {
      const [q, r] = stack.pop();
      for (const [nq, nr] of neighbors(q, r)) if (nq >= q0 && nq <= q1 && nr >= r0 && nr <= r1) push(nq, nr);
    }
    const lakes = [];
    for (let q = q0; q <= q1; q++) for (let r = r0; r <= r1; r++) { const k = key(q, r); if (!owner.has(k) && !out.has(k)) lakes.push(k); }
    return { out, lakes };
  };
  for (let round = 0; round < 400; round++) {
    const { out, lakes } = sea();
    if (!lakes.length) break;
    // the lake cell nearest the coast escapes first
    let hk = lakes.sort((a, b) => fromMid(b) - fromMid(a))[0];
    const seen = new Set([hk]);
    let escaped = false;
    for (let step = 0; step < 120; step++) {
      if (neighbors(...parse(hk)).some(([q, r]) => out.has(key(q, r)))) { escaped = true; break; }
      const options = neighbors(...parse(hk)).map(([q, r]) => key(q, r)).filter(nk => owner.has(nk) && !seen.has(nk))
        .sort((a, b) => fromMid(b) - fromMid(a));
      let moved = false;
      for (const nk of options) {
        const st = owner.get(nk), set = cellsOf.get(st);
        set.delete(nk); set.add(hk);
        if (connected(set)) { owner.delete(nk); owner.set(hk, st); hk = nk; seen.add(nk); moved = true; break; }
        set.delete(hk); set.add(nk);
      }
      if (!moved) break;
    }
    if (!escaped) break; // stuck: leave the remaining holes rather than loop forever
  }
  for (const nd of nodes) nd.cells = [...cellsOf.get(nd.st)].map(parse);
}

// ------------------------------------------------------------------------------------------- main

async function main() {
  const cd = path.join(CACHE, 'cd120');
  log('downloading Census TIGER/Line 2026 congressional districts');
  for (const f of Object.keys(FIPS)) {
    await download(`https://www2.census.gov/geo/tiger/TIGER2026/CD/tl_2026_${f}_cd120.zip`, path.join(cd, `tl_2026_${f}_cd120.zip`));
  }
  const stZip = path.join(CACHE, 'cb_2025_us_state_500k.zip');
  await download('https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_state_500k.zip', stZip);
  const stDir = path.join(CACHE, 'states');
  if (!fs.existsSync(path.join(stDir, 'cb_2025_us_state_500k.shp'))) execFileSync('unzip', ['-oq', stZip, '-d', stDir]);

  log('merging and clipping to the coastline (TIGER districts extend into lakes and coastal water)');
  const full = path.join(CACHE, 'districts_full.shp');
  ms('-i', ...Object.keys(FIPS).map(f => path.join(cd, `tl_2026_${f}_cd120.zip`)), 'combine-files',
    '-merge-layers', 'force', 'name=districts', '-filter-fields', 'STATEFP,CD120FP',
    '-clip', path.join(stDir, 'cb_2025_us_state_500k.shp'), 'remove-slivers', '-o', full);

  fs.mkdirSync(path.join(OUT, 'cd'), { recursive: true });
  log('national file');
  const nat = path.join(CACHE, 'national.json');
  ms('-i', full, '-simplify', '3%', 'keep-shapes', '-o', 'format=topojson', 'quantization=100000', nat);
  const topo = tidy(JSON.parse(fs.readFileSync(nat, 'utf8')));
  fs.writeFileSync(path.join(OUT, 'districts-2026.json'), JSON.stringify(topo));

  log('per-state files');
  const perDir = path.join(CACHE, 'per-state');
  fs.rmSync(perDir, { recursive: true, force: true });
  fs.mkdirSync(perDir, { recursive: true });
  // Split at full resolution, then simplify each state for a ~1100px-wide map so Alaska's coastline and
  // Rhode Island get comparable detail.
  ms('-i', full, '-split', 'STATEFP', '-o', perDir + path.sep);
  for (const file of fs.readdirSync(perDir).filter(f => f.endsWith('.shp'))) {
    const fips = (file.match(/(\d{2})\.shp$/) || [])[1];
    if (!FIPS[fips]) continue;
    const out = path.join(perDir, `${fips}.json`);
    ms('-i', path.join(perDir, file), '-simplify', 'resolution=1100x1100', 'keep-shapes', '-o', 'format=topojson', 'quantization=100000', out);
    fs.writeFileSync(path.join(OUT, 'cd', `${FIPS[fips]}.json`), JSON.stringify(tidy(JSON.parse(fs.readFileSync(out, 'utf8')))));
  }

  log('hex layout');
  const { feature } = await import('topojson-client');
  const fc = feature(topo, topo.objects.districts);
  const proj = d3.geoAlbersUsa().scale(1300).translate([487.5, 305]);
  const dists = fc.features.map(f => {
    const [x, y] = proj(d3.geoCentroid(f)) || proj(d3.geoPath().centroid(f)) || [0, 0];
    return { id: f.properties.id, st: f.properties.st, x, y };
  });
  const hex = hexLayout(dists, 15.5);
  fs.writeFileSync(path.join(OUT, 'house-hex.json'), JSON.stringify(hex));

  const sizes = ['districts-2026.json', 'house-hex.json'].map(f => `${f} ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)}KB`);
  log(`done: ${fc.features.length} districts; ${sizes.join(', ')}; ${fs.readdirSync(path.join(OUT, 'cd')).length} state files`);
}

main().catch(e => { console.error(e); process.exit(1); });
