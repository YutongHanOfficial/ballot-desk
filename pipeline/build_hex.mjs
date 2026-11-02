#!/usr/bin/env node
// Rebuild data/geo/house-hex.json (the equal-size House map) from the committed district and state maps.
// No downloads: npm run hex. (npm run geo rebuilds it too, along with everything else.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as d3 from 'd3';
import { feature } from 'topojson-client';
import { hexLayout } from './hex_layout.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'geo');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

/** District centroids on the same Albers USA frame as states-albers-10m.json. */
export function districtCentroids(topo) {
  const proj = d3.geoAlbersUsa().scale(1300).translate([487.5, 305]);
  return feature(topo, topo.objects.districts).features.map(f => {
    const [x, y] = proj(d3.geoCentroid(f)) || proj(d3.geoPath().centroid(f)) || [0, 0];
    return { id: f.properties.id, st: f.properties.st, x, y };
  });
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  const fips = Object.fromEntries(read('data/races.json').states.map(s => [s.fips, s.code]));
  const dists = districtCentroids(read('data/geo/districts-2026.json'));
  const hex = hexLayout(read('data/geo/states-albers-10m.json'), fips, dists, { log });
  fs.writeFileSync(path.join(OUT, 'house-hex.json'), JSON.stringify(hex));
  log(`wrote house-hex.json: ${Object.keys(hex.cells).length} districts, ${(fs.statSync(path.join(OUT, 'house-hex.json')).size / 1024).toFixed(0)}KB`);
}
