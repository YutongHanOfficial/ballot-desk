// Equal-size House map: one hexagon per district, laid out as a cartogram of the states.
//
// 1. A rubber-sheet cartogram (Dougenik, Chrisman & Niemeyer, 1985) stretches the lower 48 states until each
//    one's area matches its share of House seats. Neighbouring states keep touching, so the map keeps the
//    country's shape: New Jersey and Massachusetts swell, Wyoming and Montana shrink.
// 2. A hex grid sized for one cell per district is laid over the stretched map, and every state gets exactly
//    its number of cells through an optimal assignment (Hungarian method) that favours cells inside its
//    stretched outline and close to its middle.
// 3. Districts are matched to their state's hexes by rank-normalised position, so they keep rough geography.
// Alaska and Hawaii sit apart in the lower left, as on most US maps.
import * as d3 from 'd3';
import { feature } from 'topojson-client';

const SQ3 = Math.sqrt(3);

export function hexLayout(statesTopo, fipsToState, dists, { log = () => {} } = {}) {
  const counts = d3.rollup(dists, v => v.length, d => d.st);
  const fc = feature(statesTopo, statesTopo.objects.states);
  const states = fc.features
    .map(f => ({ st: fipsToState[f.id], polys: polygonsOf(f.geometry) }))
    .filter(x => x.st && x.st !== 'AK' && x.st !== 'HI' && counts.get(x.st));

  // ---- 1. cartogram ------------------------------------------------------------------------------------
  const points = new Set();
  for (const S of states) for (const poly of S.polys) for (const ring of poly) for (const p of ring) points.add(p);
  const want = (S) => counts.get(S.st);
  const totalV = d3.sum(states, want);
  let err = Infinity;
  for (let it = 0; it < 120 && err > 1.02; it++) {
    const info = states.map(S => shapeStats(S.polys));
    const totalA = d3.sum(info, d => d.area);
    err = 0;
    const forces = states.map((S, i) => {
      const desired = totalA * want(S) / totalV;
      const radius = Math.sqrt(info[i].area / Math.PI);
      err += Math.max(info[i].area, desired) / Math.min(info[i].area, desired);
      return { x: info[i].x, y: info[i].y, radius, mass: Math.sqrt(desired / Math.PI) - radius };
    });
    err /= states.length;
    const reduce = 1 / (1 + err);
    for (const p of points) {
      let dx = 0, dy = 0;
      for (const F of forces) {
        const vx = p[0] - F.x, vy = p[1] - F.y, d = Math.hypot(vx, vy) || 1e-6;
        const f = d > F.radius ? F.mass * F.radius / d : F.mass * (d * d) / (F.radius * F.radius) * (4 - 3 * d / F.radius);
        dx += f * vx / d; dy += f * vy / d;
      }
      p[0] += dx * reduce; p[1] += dy * reduce;
    }
  }
  const stats = new Map(states.map(S => [S.st, shapeStats(S.polys)]));
  if (!Number.isFinite(err)) throw new Error('hex layout: the cartogram did not converge');
  log(`cartogram: mean area error ${err.toFixed(3)}`);

  // ---- 2. hex grid and exact cell counts ---------------------------------------------------------------
  const areaAll = d3.sum([...stats.values()], d => d.area);
  const s = Math.sqrt(areaAll / totalV / (1.5 * SQ3));   // centre-to-corner radius of one hexagon
  const W = SQ3 * s, H = 1.5 * s;
  const center = (q, r) => [q * W + ((r & 1) ? W / 2 : 0), r * H];
  const key = (q, r) => `${q},${r}`;
  const neighbors = (q, r) => (r & 1)
    ? [[q + 1, r], [q - 1, r], [q, r - 1], [q + 1, r - 1], [q, r + 1], [q + 1, r + 1]]
    : [[q + 1, r], [q - 1, r], [q - 1, r - 1], [q, r - 1], [q - 1, r + 1], [q, r + 1]];

  const segs = new Map(states.map(S => [S.st, S.polys.flatMap(poly => poly.flatMap(ring => ring.map((p, i) => [p, ring[(i + 1) % ring.length]])))]));
  const inside = (st, x, y) => states.find(S => S.st === st).polys.some(poly => d3.polygonContains(poly[0], [x, y]) && !poly.slice(1).some(h => d3.polygonContains(h, [x, y])));
  const distTo = (st, x, y) => inside(st, x, y) ? 0 : Math.sqrt(d3.min(segs.get(st), ([a, b]) => segDist2(x, y, a, b)));

  // Candidate cells: every centre on or near the stretched map.
  const [[x0, y0], [x1, y1]] = bounds(states);
  const cand = [];
  for (let r = Math.floor(y0 / H) - 2; r <= Math.ceil(y1 / H) + 2; r++) {
    for (let q = Math.floor(x0 / W) - 2; q <= Math.ceil(x1 / W) + 2; q++) {
      const [x, y] = center(q, r);
      const near = states.some(S => distTo(S.st, x, y) < 1.6 * s);
      if (near) cand.push({ q, r, x, y });
    }
  }
  // One row per seat; cost = squared distance outside the state's outline plus a small pull toward its middle.
  const rows = [];
  for (const S of states) for (let i = 0; i < want(S); i++) rows.push(S.st);
  const costOf = new Map(states.map(S => {
    const c = stats.get(S.st);
    return [S.st, cand.map(cell => { const d = distTo(S.st, cell.x, cell.y); return (d / s) ** 2 * 10 + ((cell.x - c.x) ** 2 + (cell.y - c.y) ** 2) / (s * s) * 0.05; })];
  }));
  const pick = hungarian(rows.map(st => costOf.get(st)), rows.length, cand.length);
  const owner = new Map();
  pick.forEach((j, i) => owner.set(key(cand[j].q, cand[j].r), rows[i]));
  const candIndex = new Map(cand.map((c, j) => [key(c.q, c.r), j]));
  const cost = (st, k) => candIndex.has(k) ? costOf.get(st)[candIndex.get(k)] : Infinity;
  const moved = reconnect(owner, cost, neighbors, key);
  const filled = fillHoles(owner, cost, neighbors, key);
  if (reconnect(owner, cost, neighbors, key)) throw new Error('hex layout: filling holes split a state');
  log(`hex grid: ${cand.length} candidate cells for ${rows.length} districts; ${moved} cells moved to keep states in one piece, ${filled} holes filled`);

  // ---- 3. Alaska and Hawaii, apart in the lower left ---------------------------------------------------
  let qs = [...owner.keys()].map(k => k.split(',').map(Number));
  const qMin = d3.min(qs, c => c[0]), rMax = d3.max(qs, c => c[1]);
  const free = (q, r) => !owner.has(key(q, r)) && neighbors(q, r).every(([a, b]) => !owner.has(key(a, b)));
  const placeNear = (st, n, q0, r0) => {
    // nearest free spot (with a one-cell gap to everything else) for a run of n cells along the row
    for (let rad = 0; rad < 12; rad++) for (let dr = -rad; dr <= rad; dr++) for (let dq = -rad; dq <= rad; dq++) {
      const q = q0 + dq, r = r0 + dr;
      const run = d3.range(n).map(i => [q + i, r]);
      if (run.every(([a, b]) => free(a, b))) { run.forEach(([a, b]) => owner.set(key(a, b), st)); return; }
    }
    throw new Error(`hex layout: no room for ${st}`);
  };
  placeNear('AK', counts.get('AK') || 1, qMin + 1, rMax);
  placeNear('HI', counts.get('HI') || 2, qMin + 5, rMax + 1);

  // ---- 4. districts to hexes, by position within the state ---------------------------------------------
  const cellsOf = d3.group([...owner].map(([k, st]) => ({ k, st, qr: k.split(',').map(Number) })), c => c.st);
  const rank = (vals) => { const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const out = new Array(vals.length); idx.forEach(([, i], k) => { out[i] = vals.length > 1 ? k / (vals.length - 1) : 0.5; }); return out; };
  const byState = d3.group(dists, d => d.st);
  const cellOf = {};
  for (const [st, ds] of byState) {
    const cells = cellsOf.get(st);
    if (!cells || cells.length !== ds.length) throw new Error(`hex layout: ${st} has ${cells?.length} cells for ${ds.length} districts`);
    const pts = cells.map(c => center(...c.qr));
    const dx = rank(ds.map(d => d.x)), dy = rank(ds.map(d => d.y));
    const cx = rank(pts.map(p => p[0])), cy = rank(pts.map(p => p[1]));
    const cost = (i, j) => (dx[i] - cx[j]) ** 2 + (dy[i] - cy[j]) ** 2;
    const assign = hungarian(ds.map((_, i) => pts.map((_, j) => cost(i, j))), ds.length, pts.length);
    ds.forEach((d, i) => { cellOf[d.id] = cells[assign[i]].qr; });
  }

  // ---- 5. outlines, labels, frame ----------------------------------------------------------------------
  const corner = (x, y, k) => { const a = Math.PI / 180 * (60 * k - 30); return [x + s * Math.cos(a), y + s * Math.sin(a)]; };
  // neighbour order from neighbors(): E, W, then the two above, then the two below; edge = corner pair
  const edgeIndex = (q, r, nq, nr) => {
    const [x, y] = center(q, r), [nx, ny] = center(nq, nr);
    const ang = (Math.atan2(ny - y, nx - x) * 180 / Math.PI + 360) % 360;   // 0 = east, 60 = south-east
    return Math.round(ang / 60) % 6;
  };
  const edges = [];
  for (const [k, st] of owner) {
    const [q, r] = k.split(',').map(Number);
    const [x, y] = center(q, r);
    for (const [nq, nr] of neighbors(q, r)) {
      const other = owner.get(key(nq, nr));
      if (other === st) continue;
      if (other && key(nq, nr) < k) continue;   // a shared edge is drawn once
      const e = edgeIndex(q, r, nq, nr);
      edges.push([corner(x, y, e), corner(x, y, e + 1)]);
    }
  }
  const all = [...owner.keys()].map(k => center(...k.split(',').map(Number)));
  const pad = s * 1.3;
  const ox = d3.min(all, p => p[0]) - pad, oy = d3.min(all, p => p[1]) - pad;
  const fx = (v) => +(v - ox).toFixed(1), fy = (v) => +(v - oy).toFixed(1);
  const cells = {};
  for (const [id, qr] of Object.entries(cellOf)) { const [x, y] = center(...qr); cells[id] = [fx(x), fy(y)]; }
  const labels = {};
  for (const [st, cs] of cellsOf) {
    const pts = cs.map(c => center(...c.qr));
    const mx = d3.mean(pts, p => p[0]), my = d3.mean(pts, p => p[1]);
    const best = d3.least(pts, p => (p[0] - mx) ** 2 + (p[1] - my) ** 2);   // a cell of the state, near its middle
    labels[st] = [fx(best[0]), fy(best[1])];
  }
  const borders = edges.map(([a, b]) => `M${fx(a[0])},${fy(a[1])}L${fx(b[0])},${fy(b[1])}`).join('');
  return {
    r: +s.toFixed(2),
    width: +(d3.max(all, p => p[0]) + pad - ox).toFixed(1), height: +(d3.max(all, p => p[1]) + pad - oy).toFixed(1),
    cells, labels, borders,
  };
}

// ------------------------------------------------------------------------------------------- contiguity

/**
 * The assignment knows nothing about contiguity, so a state can come out in pieces. Move stray cells, one at a
 * time, next to the state's main body: into an empty cell, or by taking a neighbour's cell (that neighbour
 * then takes the stray, or an empty cell it touches) as long as the neighbour stays in one piece. Each step
 * picks the cheapest such move.
 */
function reconnect(owner, cost, neighbors, key) {
  const parse = (k) => k.split(',').map(Number);
  const cellsOf = (st) => [...owner].filter(([, s]) => s === st).map(([k]) => k);
  const pieces = (set) => {
    const left = new Set(set), out = [];
    while (left.size) {
      const start = left.values().next().value, piece = [start], stack = [start];
      left.delete(start);
      while (stack.length) for (const [q, r] of neighbors(...parse(stack.pop()))) {
        const k = key(q, r);
        if (left.has(k)) { left.delete(k); piece.push(k); stack.push(k); }
      }
      out.push(piece);
    }
    return out;
  };
  const whole = (st, drop, add) => { const set = new Set(cellsOf(st)); set.delete(drop); if (add) set.add(add); return pieces(set).length === 1; };
  let moves = 0;
  for (let guard = 0; guard < 2000; guard++) {
    const broken = [...new Set(owner.values())].map(st => ({ st, ps: pieces(cellsOf(st)) })).find(x => x.ps.length > 1);
    if (!broken) return moves;
    const { st, ps } = broken;
    ps.sort((a, b) => b.length - a.length || d3.min(a, k => cost(st, k)) - d3.min(b, k => cost(st, k)));
    const main = new Set(ps[0]);
    const stray = ps[ps.length - 1][0];
    let best = null;
    const consider = (delta, steps) => { if (!best || delta < best.delta) best = { delta, steps }; };
    for (const k of main) for (const [q, r] of neighbors(...parse(k))) {
      const y = key(q, r);
      if (main.has(y) || y === stray) continue;
      const other = owner.get(y);
      if (!other) {
        if (Number.isFinite(cost(st, y))) consider(cost(st, y) - cost(st, stray), [[stray, null], [y, st]]);
        continue;
      }
      if (other === st || !whole(other, y, null)) continue;
      const options = new Set();
      if (neighbors(...parse(stray)).some(([a, b]) => owner.get(key(a, b)) === other)) options.add(stray);
      for (const z of cellsOf(other)) for (const [a, b] of neighbors(...parse(z))) {
        const zk = key(a, b);
        if (!owner.has(zk) && zk !== y && Number.isFinite(cost(other, zk))) options.add(zk);
      }
      for (const z of options) {
        if (!whole(other, y, z)) continue;
        const delta = cost(st, y) - cost(st, stray) + cost(other, z) - cost(other, y);
        consider(delta, z === stray ? [[y, st], [stray, other]] : [[stray, null], [y, st], [z, other]]);
      }
    }
    if (!best) throw new Error(`hex layout: cannot reconnect ${st}`);
    for (const [k, v] of best.steps) { if (v) owner.set(k, v); else owner.delete(k); }
    moves++;
  }
  throw new Error('hex layout: contiguity repair did not settle');
}

/**
 * Empty cells the sea cannot reach (a flood fill from outside the map) read as missing districts. Each one is
 * taken by a neighbouring state, which gives up a cell on the coast instead, keeping its count and staying in
 * one piece. Bays that open to the outside (Lake Michigan) are left alone.
 */
function fillHoles(owner, cost, neighbors, key) {
  const parse = (k) => k.split(',').map(Number);
  const connected = (set) => {
    const start = set.values().next().value, seen = new Set([start]), stack = [start];
    while (stack.length) for (const [q, r] of neighbors(...parse(stack.pop()))) {
      const k = key(q, r);
      if (set.has(k) && !seen.has(k)) { seen.add(k); stack.push(k); }
    }
    return seen.size === set.size;
  };
  let filled = 0;
  for (let guard = 0; guard < 500; guard++) {
    const qr = [...owner.keys()].map(parse);
    const q0 = d3.min(qr, c => c[0]) - 2, q1 = d3.max(qr, c => c[0]) + 2, r0 = d3.min(qr, c => c[1]) - 2, r1 = d3.max(qr, c => c[1]) + 2;
    const sea = new Set([key(q0, r0)]), stack = [[q0, r0]];
    while (stack.length) for (const [q, r] of neighbors(...stack.pop())) {
      const k = key(q, r);
      if (q < q0 || q > q1 || r < r0 || r > r1 || sea.has(k) || owner.has(k)) continue;
      sea.add(k); stack.push([q, r]);
    }
    let hole = null;
    for (let r = r0; r <= r1 && !hole; r++) for (let q = q0; q <= q1; q++) { const k = key(q, r); if (!owner.has(k) && !sea.has(k)) { hole = k; break; } }
    if (!hole) return filled;
    let best = null;
    for (const st of new Set(neighbors(...parse(hole)).map(([q, r]) => owner.get(key(q, r))).filter(Boolean))) {
      const mine = new Set([...owner].filter(([, s]) => s === st).map(([k]) => k));
      for (const d of mine) {
        if (!neighbors(...parse(d)).some(([q, r]) => sea.has(key(q, r)))) continue;   // only coastal cells move
        const next = new Set(mine); next.delete(d); next.add(hole);
        if (!connected(next)) continue;
        const delta = (cost(st, hole) === Infinity ? 0 : cost(st, hole)) - (cost(st, d) === Infinity ? 1e6 : cost(st, d));
        if (!best || delta < best.delta) best = { delta, st, d };
      }
    }
    if (!best) throw new Error(`hex layout: cannot fill the hole at ${hole}`);
    owner.delete(best.d); owner.set(hole, best.st);
    filled++;
  }
  throw new Error('hex layout: hole filling did not settle');
}

// ------------------------------------------------------------------------------------------- geometry

function polygonsOf(g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  // drop each ring's closing point, and slivers with no area (they have no centroid)
  return polys.map(poly => poly.map(ring => ring.slice(0, ring.length - 1)).filter(ring => ring.length >= 3 && Math.abs(d3.polygonArea(ring)) > 1e-6))
    .filter(poly => poly.length);
}

/** Area and centroid of a multipolygon (holes subtract). */
function shapeStats(polys) {
  let area = 0, x = 0, y = 0;
  for (const poly of polys) poly.forEach((ring, i) => {
    const a = Math.abs(d3.polygonArea(ring)) * (i ? -1 : 1);
    if (!a) return;
    const [cx, cy] = d3.polygonCentroid(ring);
    area += a; x += a * cx; y += a * cy;
  });
  return { area, x: x / area, y: y / area };
}

function bounds(states) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const S of states) for (const poly of S.polys) for (const p of poly[0]) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  return [[x0, y0], [x1, y1]];
}

function segDist2(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = dx || dy ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return (x - a[0] - t * dx) ** 2 + (y - a[1] - t * dy) ** 2;
}

/**
 * Minimum-cost assignment of n rows to distinct columns of an n x m cost matrix (n <= m), Hungarian method
 * with potentials, O(n^2 m). Returns the column chosen for each row.
 */
function hungarian(cost, n, m) {
  if (m < n) throw new Error(`assignment: ${n} rows but only ${m} columns`);
  const INF = 1e18;
  const u = new Float64Array(n + 1), v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1), way = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(INF);
    const used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const out = new Array(n);
  for (let j = 1; j <= m; j++) if (p[j]) out[p[j] - 1] = j - 1;
  return out;
}
