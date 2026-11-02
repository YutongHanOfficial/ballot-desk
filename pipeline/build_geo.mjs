#!/usr/bin/env node
// Build the district map files from the Census Bureau's TIGER/Line 2026 congressional districts (120th
// Congress, the lines used in the November 2026 election, including the mid-decade redraws).
//
//   data/geo/districts-2026.json   all 435 districts (TopoJSON, lon/lat), simplified for the national map
//   data/geo/cd/XX.json            one state's districts at higher detail, for state and race pages
//   data/geo/house-hex.json        equal-size hexagon layout, one hex per district (hex_layout.mjs)
//   data/geo/counties/XX.json      a state's counties (Census cartographic boundaries, 2025)
//   data/geo/counties-2024.json    2024 presidential vote by county: { fips: [total, dem, gop] }
//                                  (tonmcg/US_County_Level_Election_Results_08-24, MIT licence)
//
// One-time build: `npm install && npm run geo` (needs `unzip`). The output is committed; the GitHub Action
// never runs this.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hexLayout } from './hex_layout.mjs';
import { districtCentroids } from './build_hex.mjs';

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

// ------------------------------------------------------------------------------------------- counties

async function buildCounties() {
  log('counties');
  const zip = path.join(CACHE, 'cb_2025_us_county_500k.zip');
  await download('https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_county_500k.zip', zip);
  const dir = path.join(CACHE, 'counties');
  if (!fs.existsSync(path.join(dir, 'cb_2025_us_county_500k.shp'))) execFileSync('unzip', ['-oq', zip, '-d', dir]);
  const csvFile = path.join(CACHE, 'county_president_2024.csv');
  await download('https://raw.githubusercontent.com/tonmcg/US_County_Level_Election_Results_08-24/master/2024_US_County_Level_Presidential_Results.csv', csvFile);

  // 2024 baseline. Alaska reports by state House district and D.C. by ward, so neither has county shapes.
  const lines = fs.readFileSync(csvFile, 'utf8').trim().split(/\r?\n/);
  const head = lines.shift().split(',');
  const col = (n) => head.indexOf(n);
  const base = {};
  for (const line of lines) {
    const c = line.split(',');
    const fips = c[col('county_fips')].padStart(5, '0');
    if (!FIPS[fips.slice(0, 2)] || fips.startsWith('02')) continue;
    base[fips] = [+c[col('total_votes')], +c[col('votes_dem')], +c[col('votes_gop')]];
  }
  fs.writeFileSync(path.join(OUT, 'counties-2024.json'), JSON.stringify(base));

  const perDir = path.join(CACHE, 'county-per-state');
  fs.rmSync(perDir, { recursive: true, force: true });
  fs.mkdirSync(perDir, { recursive: true });
  ms('-i', path.join(dir, 'cb_2025_us_county_500k.shp'), '-filter-fields', 'GEOID,NAME,STATEFP', '-split', 'STATEFP', '-o', perDir + path.sep);
  fs.mkdirSync(path.join(OUT, 'counties'), { recursive: true });
  for (const file of fs.readdirSync(perDir).filter(f => f.endsWith('.shp'))) {
    const fips = (file.match(/(\d{2})\.shp$/) || [])[1];
    if (!FIPS[fips] || fips === '02') continue;
    const out = path.join(perDir, `${fips}.json`);
    ms('-i', path.join(perDir, file), '-simplify', 'resolution=900x900', 'keep-shapes', '-o', 'format=topojson', 'quantization=100000', out);
    const t = JSON.parse(fs.readFileSync(out, 'utf8'));
    const obj = Object.values(t.objects)[0];
    for (const g of obj.geometries) g.properties = { id: g.properties.GEOID, n: g.properties.NAME };
    t.objects = { counties: obj };
    fs.writeFileSync(path.join(OUT, 'counties', `${FIPS[fips]}.json`), JSON.stringify(t));
  }
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
  const dists = districtCentroids(topo);
  const hex = hexLayout(JSON.parse(fs.readFileSync(path.join(OUT, 'states-albers-10m.json'), 'utf8')), FIPS, dists, { log });
  fs.writeFileSync(path.join(OUT, 'house-hex.json'), JSON.stringify(hex));

  await buildCounties();

  const sizes = ['districts-2026.json', 'house-hex.json', 'counties-2024.json'].map(f => `${f} ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)}KB`);
  log(`done: ${dists.length} districts; ${sizes.join(', ')}; ${fs.readdirSync(path.join(OUT, 'cd')).length} state files`);
}

main().catch(e => { console.error(e); process.exit(1); });
