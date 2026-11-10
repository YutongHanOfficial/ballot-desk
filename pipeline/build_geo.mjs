#!/usr/bin/env node
// Build the district map files from the Census Bureau's TIGER/Line 2026 congressional districts (120th
// Congress, the lines used in the November 2026 election, including the mid-decade redraws).
//
//   data/geo/districts-2026.json   all 435 districts (TopoJSON, lon/lat), simplified for the national map
//   data/geo/cd/XX.json            one state's districts at higher detail, for state and race pages
//   data/geo/house-hex.json        equal-size hexagon layout, one hex per district (hex_layout.mjs)
//   data/geo/counties/XX.json      a state's counties (Census cartographic boundaries, 2025); for Alaska, which
//                                  counts its votes by state House district, its 40 House districts instead
//   data/geo/counties-2024.json    2024 presidential vote by county: { fips: [total, dem, gop] }
//                                  (tonmcg/US_County_Level_Election_Results_08-24, MIT licence), and by Alaska
//                                  House district (Alaska Division of Elections, official results by precinct)
//   data/geo/towns/XX.json         New England's towns, for its live race maps (Census cartographic county
//                                  subdivisions, 2025), and assets/js/ne-towns.js, which matches the results feed's
//                                  towns to them (and Connecticut's towns to its planning regions)
//
// One-time build: `npm install && npm run geo` (needs `unzip`). The output is committed; the GitHub Action
// never runs this. `npm run geo -- alaska towns` rebuilds just those parts.
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

  // 2024 baseline. Alaska reports by state House district (buildAlaska adds those) and D.C. by ward, so neither is
  // taken from this file.
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

/** The fields of one CSV line, allowing for quoted fields with commas and doubled quotes. */
function csvFields(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') cur += ch;
      else if (line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// ------------------------------------------------------------------------------------------- Alaska

// Alaska counts its votes by state House district rather than by borough, and the results feed reports it the same
// way, so its county map is its 40 House districts (the lines used since 2022). Their ids aren't borough FIPS codes,
// so the two can never be mixed up: 02H01 to 02H40.
const akDistrictId = (n) => `02H${String(n).padStart(2, '0')}`;

async function buildAlaska() {
  log('Alaska House districts');
  const dir = path.join(CACHE, 'ak-sldl');
  const zip = path.join(dir, 'cb_2025_02_sldl_500k.zip');
  await download('https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_02_sldl_500k.zip', zip);
  if (!fs.existsSync(path.join(dir, 'cb_2025_02_sldl_500k.shp'))) execFileSync('unzip', ['-oq', zip, '-d', dir]);
  // Simplified by size: to 150 m for the city districts (Anchorage's are 6 to 100 km²), so they keep their shape when
  // zoomed in, and to 600 m and 2 km for the larger and the vast rural ones, whose long coastlines would otherwise
  // make the map slow to draw (about 5,000 points in all, like Texas). Islands under 5 km² are dropped. Alaska spans
  // 180°, so its bounding box is nearly 360° wide and needs a finer grid than other states.
  const out = path.join(dir, 'AK.json');
  ms('-i', path.join(dir, 'cb_2025_02_sldl_500k.shp'), '-simplify', 'variable', 'interval=ALAND < 1e9 ? 150 : ALAND < 2e10 ? 600 : 2000',
    'keep-shapes', '-filter-islands', 'min-area=5km2', '-filter-fields', 'SLDLST', '-o', 'format=topojson', 'quantization=1000000', out);
  const t = JSON.parse(fs.readFileSync(out, 'utf8'));
  const obj = Object.values(t.objects)[0];
  for (const g of obj.geometries) {
    const n = parseInt(g.properties.SLDLST, 10);
    g.properties = { id: akDistrictId(n), n: `District ${n}` };
  }
  obj.geometries.sort((a, b) => a.properties.id.localeCompare(b.properties.id));
  t.objects = { counties: obj };
  fs.writeFileSync(path.join(OUT, 'counties', 'AK.json'), JSON.stringify(t));

  // 2024 presidential vote by district, from the official results by precinct. Precinct names start with their
  // district ("01-600 Ketchikan No. 1"); absentee, early and questioned ballots come as district rows ("District 1 -
  // Absentee"). Only overseas voters' federal ballots ("HD99 Fed Overseas Absentee", about 400) belong to no district.
  const csv = path.join(CACHE, 'ak-2024', 'ENRbyPrecinct.csv');
  await download('https://www.elections.alaska.gov/results/24GENR/ENRbyPrecinct.csv', csv);
  const lines = fs.readFileSync(csv, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const head = csvFields(lines.shift());
  const col = (n) => { const i = head.indexOf(n); if (i < 0) throw new Error(`ENRbyPrecinct.csv: no ${n} column`); return i; };
  const [cPct, cContest, cParty, cVotes] = ['Precinct_name', 'Contest_title', 'Party_Code', 'total_votes'].map(col);
  const by = {};
  for (const line of lines) {
    const c = csvFields(line);
    if (!c[cContest].startsWith('U.S. President')) continue;
    if (/^HD99\b/.test(c[cPct])) continue;
    const m = c[cPct].match(/^(\d\d)-\d/) || c[cPct].match(/^District (\d+)\b/);
    if (!m) throw new Error(`ENRbyPrecinct.csv: no district in "${c[cPct]}"`);
    const v = by[akDistrictId(parseInt(m[1], 10))] ||= [0, 0, 0];
    const n = parseInt(c[cVotes], 10) || 0;
    v[0] += n;
    if (c[cParty] === 'DEM') v[1] += n;
    if (c[cParty] === 'REP') v[2] += n;
  }
  if (Object.keys(by).length !== 40) throw new Error(`Alaska: ${Object.keys(by).length} districts in the 2024 results, not 40`);
  const baseFile = path.join(OUT, 'counties-2024.json');
  const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  for (const k of Object.keys(base)) if (k.startsWith('02')) delete base[k];
  Object.assign(base, Object.fromEntries(Object.entries(by).sort()));
  fs.writeFileSync(baseFile, JSON.stringify(base));
  const sum = Object.values(by).reduce((a, v) => a.map((x, i) => x + v[i]), [0, 0, 0]);
  log(`Alaska: ${obj.geometries.length} districts, ${(fs.statSync(path.join(OUT, 'counties', 'AK.json')).size / 1024).toFixed(0)}KB; 2024: ${sum[0]} votes, Harris ${sum[1]}, Trump ${sum[2]}`);
}

// ------------------------------------------------------------------------------------------- New England towns

// New England reports its votes by town (the feed's 'township' units), so its live race maps show towns: the Census
// Bureau's 2025 cartographic county subdivisions. The feed's town codes are Census codes everywhere but Maine, whose
// units are matched by name and kind (town, plantation, unorganized territory, reservation) within their county, and
// four Massachusetts towns, matched by name. Maine's feed also lists unorganized townships whose votes it already
// counts in their unorganized territory ("Albany Township" inside "South Oxford unorganized territory"): they have
// no Census area of their own and are skipped. The build checks that the towns kept add up to each state's total.
//   data/geo/towns/XX.json   a state's towns (object 'counties', as in the county files; id = state FIPS + Census
//                            town code, n = the feed's name, x = 1 where the feed has no count of its own)
//   assets/js/ne-towns.js    feed code -> Census code where they differ ('' = counted in another unit), the Maine
//                            townships whose 2024 vote belongs to their territory, and Connecticut's planning regions
const NE_STATES = {
  '09': ['connecticut', ['governor']], '23': ['maine', ['us-senate', 'governor']], '25': ['massachusetts', ['us-senate', 'governor']],
  '33': ['new-hampshire', ['us-senate', 'governor']], '44': ['rhode-island', ['us-senate', 'governor']], '50': ['vermont', ['governor']],
};
const TOWN_KIND = { 25: 'town', 43: 'town', 47: 'town', 39: 'plantation', 46: 'ut', 86: 'reservation' };   // Census LSAD codes

/** A name reduced for matching: lower case, no possessive 's or punctuation, "Plt." spelled out. */
const plain = (n) => String(n).toLowerCase().replace(/[’']s\b/g, '').replace(/[’']/g, '').replace(/\bplt\b\.?/g, 'plantation').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
/** Without a trailing kind word, so "Weymouth Town", "Essex town" and "Hale's Location" meet their feed names. */
const bare = (n) => plain(n).replace(/ (town|city|location|plantation|gore|grant|purchase)$/, '');

/** The kind of place a Maine feed unit is, and its name without the kind. */
function maineKind(name) {
  const b = plain(name);
  if (/ plantation$/.test(b)) return ['plantation', b.replace(/ plantation$/, '')];
  if (/ unorganized territory$/.test(b)) return ['ut', b.replace(/ unorganized territory$/, '')];
  if (/reservation|voting district/.test(b)) return ['reservation', b];
  if (/ townships?$/.test(b) || /^t\w* r\d|^[a-z] township/.test(b)) return ['township', b];
  return ['town', b];
}

/** The Census town (county subdivision) each of a state's feed town units belongs to; null = no area of its own. */
function matchTowns(st, census, units) {
  const byCode = new Map(census.map(c => [c.COUSUBFP, c]));
  const out = new Map();
  for (const u of units) {
    let hit = null;
    if (st === '23') {
      // Maine: the feed's codes aren't Census codes (one even collides with an unrelated town's), so by name only.
      const [kind, name] = maineKind(u.name);
      const pool = census.filter(c => c.COUNTYFP === u.fips_county && TOWN_KIND[c.LSAD] === (kind === 'township' ? 'none' : kind));
      let found = kind === 'reservation'
        ? pool.filter(c => name.includes(plain(c.NAME)))
        : pool.filter(c => plain(c.NAME) === name);
      if (kind === 'reservation' && !found.length) found = pool.filter(c => name.split(' ')[0] === plain(c.NAME).split(' ')[0]);
      if (found.length > 1) throw new Error(`Maine: "${u.name}" matches ${found.map(c => c.NAMELSAD).join(', ')}`);
      hit = found[0] || null;
    } else {
      const c = byCode.get(u.fips_suffix);
      if (c && bare(c.NAME) === bare(u.name)) hit = c;
      else if (c) throw new Error(`${st}: feed town ${u.fips_suffix} "${u.name}" has the code of "${c.NAMELSAD}"`);
      else {
        const found = census.filter(x => x.COUNTYFP === u.fips_county && bare(x.NAME) === bare(u.name));
        if (found.length !== 1) throw new Error(`${st}: no single Census town for feed town "${u.name}" (${u.fips_county}-${u.fips_suffix})`);
        hit = found[0];
      }
    }
    out.set(u.fips_suffix, hit);
  }
  const seen = new Map();
  for (const [suffix, c] of out) {
    if (!c) continue;
    if (seen.has(c.COUSUBFP)) throw new Error(`${st}: feed towns ${seen.get(c.COUSUBFP)} and ${suffix} both match ${c.NAMELSAD}`);
    seen.set(c.COUSUBFP, suffix);
  }
  return out;
}

async function buildNewEnglandTowns() {
  log('New England towns');
  fs.mkdirSync(path.join(OUT, 'towns'), { recursive: true });
  const exceptions = {}, into2024 = {}, regions = {};
  for (const [st, [slug, races]] of Object.entries(NE_STATES)) {
    const dir = path.join(CACHE, st === '09' ? 'ct-cousub' : `ne-cousub-${st}`);
    const base = `cb_2025_${st}_cousub_500k`;
    await download(`https://www2.census.gov/geo/tiger/GENZ2025/shp/${base}.zip`, path.join(dir, `${base}.zip`));
    if (!fs.existsSync(path.join(dir, `${base}.shp`))) execFileSync('unzip', ['-oq', path.join(dir, `${base}.zip`), '-d', dir]);
    const csv = path.join(dir, 'towns.csv');
    ms('-i', path.join(dir, `${base}.shp`), '-filter-fields', 'COUNTYFP,COUSUBFP,NAME,NAMELSAD,LSAD,NAMELSADCO', '-o', 'format=csv', csv);
    const lines = fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/);
    const head = csvFields(lines.shift());
    const census = lines.map(l => Object.fromEntries(csvFields(l).map((v, i) => [head[i], v])));

    // The towns each race file lists (every race in a state lists the same ones) and its totals.
    const files = [];
    for (const race of races) {
      const file = path.join(CACHE, 'feed', `results-${slug}-${race}.json`);
      await download(`https://static01.nyt.com/elections-assets/pages/data/2026-11-03/results-${slug}-${race}.json`, file);
      files.push(JSON.parse(fs.readFileSync(file, 'utf8')).races[0].reporting_units);
    }
    const towns = files.map(us => us.filter(u => u.level === 'township'));
    const ids = (ts) => ts.map(u => u.fips_suffix).sort().join(' ');
    if (towns.some(ts => ids(ts) !== ids(towns[0]))) throw new Error(`${slug}: the race files list different towns`);
    const match = matchTowns(st, census, towns[0]);

    // What's kept must add up to the statewide count, less overseas ballots, which belong to no town.
    for (const [i, us] of files.entries()) {
      const state = us.find(u => u.level === 'state').total_votes;
      const overseas = us.filter(u => u.level === 'other' && /overseas/i.test(u.name)).reduce((t, u) => t + u.total_votes, 0);
      const kept = towns[i].filter(u => match.get(u.fips_suffix)).reduce((t, u) => t + u.total_votes, 0);
      if (kept + overseas !== state) throw new Error(`${slug} ${races[i]}: towns ${kept} + overseas ${overseas} != state ${state}`);
    }

    // Feed codes that differ from the Census code, and the units counted in another one.
    const ex = {};
    for (const [suffix, c] of match) if (!c || c.COUSUBFP !== suffix) ex[suffix] = c ? c.COUSUBFP : '';
    if (Object.keys(ex).length) exceptions[st] = ex;

    // A skipped Maine township's 2024 vote belongs to its territory when this year's counts show it is the territory's
    // only polling place: the same counts for every candidate in every race file.
    const counts = (i, u) => (u.candidates || []).map(c => `${c.nyt_id}:${c.votes?.total || 0}`).join(',');
    for (const u of towns[0]) {
      if (match.get(u.fips_suffix) || !Object.keys(u.historical_comparison_race_data || {}).some(k => /-G-P-2024-11-05$/.test(k)) || !u.total_votes) continue;
      const twins = towns[0].filter(p => p !== u && match.get(p.fips_suffix) && p.fips_county === u.fips_county &&
        files.every((us, i) => { const a = towns[i].find(x => x.fips_suffix === u.fips_suffix), b = towns[i].find(x => x.fips_suffix === p.fips_suffix); return counts(i, a) === counts(i, b); }));
      if (twins.length === 1) (into2024[st] ||= {})[u.fips_suffix] = match.get(twins[0].fips_suffix).COUSUBFP;
    }

    // The map: each town named as the feed names it; areas with no count of their own marked x.
    const unitOf = new Map([...match].filter(([, c]) => c).map(([suffix, c]) => [c.COUSUBFP, towns[0].find(u => u.fips_suffix === suffix)]));
    const out = path.join(dir, 'towns.json');
    // One shape per town: the Census lists Maine's Penobscot Indian Island Reservation under two counties.
    ms('-i', path.join(dir, `${base}.shp`), '-filter-fields', 'COUSUBFP,NAMELSAD', '-simplify', 'resolution=1400x1400', 'keep-shapes',
      '-filter-islands', 'min-area=0.05km2', '-dissolve', 'COUSUBFP', 'copy-fields=NAMELSAD', '-o', 'format=topojson', 'quantization=100000', out);
    const t = JSON.parse(fs.readFileSync(out, 'utf8'));
    const obj = Object.values(t.objects)[0];
    for (const g of obj.geometries) {
      const u = unitOf.get(g.properties.COUSUBFP);
      const name = u ? u.name : g.properties.NAMELSAD.replace(/ UT$/, ' (unorganized)');
      g.properties = { id: `${st}${g.properties.COUSUBFP}`, n: name, ...(u ? {} : { x: 1 }) };
    }
    t.objects = { counties: obj };
    fs.writeFileSync(path.join(OUT, 'towns', `${FIPS[st]}.json`), JSON.stringify(t));
    if (st === '09') for (const c of census) (regions[`09${c.COUNTYFP}`] ||= { name: c.NAMELSADCO, towns: [] }).towns.push(c.COUSUBFP);
    const kb = (fs.statSync(path.join(OUT, 'towns', `${FIPS[st]}.json`)).size / 1024).toFixed(0);
    log(`${FIPS[st]}: ${towns[0].length} feed towns, ${unitOf.size} of ${census.length} Census towns matched, ${towns[0].length - unitOf.size} skipped, ` +
      `${Object.keys(ex).length} code exceptions, ${Object.keys(into2024[st] || {}).length} 2024 hand-offs; ${kb}KB`);
  }
  const keys = Object.keys(regions).sort();
  if (keys.length !== 9 || keys.reduce((t, k) => t + regions[k].towns.length, 0) !== 169) throw new Error('Connecticut: not 169 towns in 9 regions');
  // One state per block, eight codes a line, in code order, so a rebuild only changes what changed.
  const table = (o) => ['{', ...Object.keys(o).sort().flatMap(st => {
    const pairs = Object.keys(o[st]).sort().map(k => `'${k}': '${o[st][k]}'`);
    const rows = [];
    for (let i = 0; i < pairs.length; i += 8) rows.push(`    ${pairs.slice(i, i + 8).join(', ')},`);
    return [`  '${st}': {   // ${FIPS[st]}`, ...rows, '  },'];
  }), '}'].join('\n');
  const js = [
    '// New England reports its votes by town. Generated by pipeline/build_geo.mjs from the results feed\'s town lists and',
    '// the Census Bureau\'s 2025 county subdivisions; don\'t edit by hand. live.js loads it for New England races only.',
    '',
    '// Feed town code -> Census town code, where they differ (Maine everywhere, four Massachusetts towns). \'\' marks a',
    '// unit the feed already counts inside another one (Maine\'s unorganized townships), which is skipped.',
    `export const TOWNS = ${table(exceptions)};`,
    '',
    '// States whose other feed town codes are Census codes.',
    `export const SAME_CODES = ${JSON.stringify(Object.keys(NE_STATES).filter(s => s !== '23'))};`,
    '',
    '// Skipped Maine townships whose 2024 vote belongs to their unorganized territory\'s area: this year their counts',
    '// match the territory\'s exactly, so they are its only polling place.',
    `export const TOWN_2024_INTO = ${table(into2024)};`,
    '',
    '// Connecticut\'s 169 towns by planning region (its county equivalents since 2022): the feed tags its towns with',
    '// the old counties, but the county map shows the regions.',
    'export const CT_REGIONS = {',
    ...keys.map(k => `  '${k}': '${regions[k].towns.sort().join(' ')}',   // ${regions[k].name}`),
    '};',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, 'assets', 'js', 'ne-towns.js'), js);
  log(`ne-towns.js ${(js.length / 1024).toFixed(1)}KB`);
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
  await buildAlaska();
  await buildNewEnglandTowns();

  const sizes = ['districts-2026.json', 'house-hex.json', 'counties-2024.json'].map(f => `${f} ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)}KB`);
  log(`done: ${dists.length} districts; ${sizes.join(', ')}; ${fs.readdirSync(path.join(OUT, 'cd')).length} state files`);
}

// `node pipeline/build_geo.mjs alaska towns` runs just those steps; with no arguments, everything.
const STEPS = { alaska: buildAlaska, towns: buildNewEnglandTowns };
const only = process.argv.slice(2);
const run = only.length
  ? async () => { for (const s of only) { if (!STEPS[s]) throw new Error(`unknown step "${s}" (have: ${Object.keys(STEPS).join(', ')})`); await STEPS[s](); } }
  : main;
run().catch(e => { console.error(e); process.exit(1); });
