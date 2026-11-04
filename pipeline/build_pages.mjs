// Writes a copy of index.html for every address on the site (live.html, state/PA.html, race/GA-SEN.html, ...).
// GitHub Pages serves /race/GA-SEN from race/GA-SEN.html, so plain addresses load directly with a 200, and each
// copy carries its own title and link-preview text. Also writes sitemap.xml and robots.txt.
// Run after editing index.html or when races are added: npm run pages
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { titleFor } from '../assets/js/store.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE = 'https://ballotdesk.org';
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const template = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const base = read('data/races.json');
const forecast = read('data/forecast.json');
const stateName = Object.fromEntries(base.states.map(s => [s.code, s.name]));
const PARTY = { D: 'D', R: 'R', I: 'I', L: 'L', G: 'G' };

const pages = [
  ['/live', 'Live election results', 'Live vote counts, projections and maps for every 2026 midterm race for Senate, House and governor, updating through election night.'],
  ['/forecast', '2026 midterm forecast', 'Who will win the Senate, House and governorships? Our forecast combines polls, expert ratings, prediction markets and each race’s partisan lean.'],
  ['/senate', 'Senate forecast', 'Each party’s chance of winning the Senate in 2026, with odds, polls, maps and live results for all 35 races.'],
  ['/house', 'House forecast', 'Each party’s chance of winning the House in 2026: all 435 districts, with maps, odds and live results.'],
  ['/governors', 'Governor forecast', 'Forecasts, maps and live results for the 36 governor races in 2026.'],
  ['/states', 'Every state', 'Every state on the 2026 ballot: Senate, House and governor races, down-ballot offices, legislatures and ballot measures.'],
  ['/downballot', 'Down-ballot races', 'Lieutenant governor, attorney general and secretary of state races, state legislatures and ballot measures in 2026.'],
  ['/methodology', 'How the forecast works', 'How Ballot Desk forecasts the 2026 midterms: polls, expert ratings, prediction markets, partisan lean and a simulation model.'],
  ['/simulate', 'Election simulator', 'Simulate the 2026 midterms: draw one outcome in a click, or replay a whole election night as polls close and races are called.'],
  ['/support', 'Support', 'Ballot Desk is free and independent, with no ads and no paywall. Chip in to help keep it running.'],
  ['/stream', 'Stream kit', 'Live election-night scenes and overlays for OBS and Streamlabs: balance of power, maps, key races, a ticker and projection alerts.', { noindex: true }],
  ['/broadcast', 'Broadcast', 'Ballot Desk election-night broadcast scene.', { noindex: true }],
  ['/credits', 'Photo credits', 'Authors and licenses of the candidate photos on Ballot Desk, from the candidates’ Wikipedia articles.'],
  ['/terms', 'Terms of service', 'The terms for using Ballot Desk: forecasts are probabilities, results are unofficial, and nothing here is advice.'],
  ['/privacy', 'Privacy policy', 'Ballot Desk has no accounts, cookies, analytics or ads, and collects no personal information. What your browser stores and connects to.'],
];

// Past elections (data/archive, from pipeline/build_archive.mjs). The index is archive/index.html, so /archive/2024
// can sit beside it: GitHub Pages sends /archive to /archive/ because the folder exists.
const archive = read('data/archive/index.json');
pages.push(['/archive/', 'Past elections', 'Results of every U.S. federal general election since 1976, for president, Senate and House, with maps by state and, from 2000, by county.', { file: 'archive/index' }]);
pages.push(['/swing', 'Swing map', 'How the presidential vote shifted between any two elections since 1976: county by county from 2000, as arrows or shading.']);
for (const e of archive.years) {
  const p = e.president;
  const hs = e.house.seats, hw = hs.D > hs.R ? 'Democrats' : 'Republicans';
  const lead = p ? `${p.ev.D > p.ev.R ? p.D : p.R} won the presidency with ${Math.max(p.ev.D, p.ev.R)} electoral votes, and ${hw} won the House ${Math.max(hs.D, hs.R)}–${Math.min(hs.D, hs.R)}.`
    : `Midterm results: ${hw} won the House ${Math.max(hs.D, hs.R)}–${Math.min(hs.D, hs.R)}.`;
  pages.push([`/archive/${e.year}`, `${e.year} elections`, `${lead} Results and maps for ${p ? 'president, ' : ''}the Senate and the House${e.counties ? ', by state and county' : ''}.`]);
}

const OFFICES = { senate: 'Senate', gov: 'governor', ltgov: 'lieutenant governor', ag: 'attorney general', sos: 'secretary of state' };
const listText = (xs) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
for (const st of base.states) {
  const rs = base.races.filter(r => r.state === st.code);
  const house = rs.filter(r => r.type === 'house').length;
  const offices = [...new Set(rs.filter(r => r.type !== 'house').map(r => OFFICES[r.type]))].filter(Boolean);
  const parts = [...offices.map(o => `${o} race`), `${house} House seat${house === 1 ? '' : 's'}`];
  pages.push([`/state/${st.code}`, st.name, `Every 2026 race in ${st.name}: ${listText(parts)}, with forecasts, maps and live results on election night.`]);
}

for (const r of base.races) {
  const f = forecast.races[r.id] || {};
  const left = f.left ?? r.left, right = f.right ?? r.right;
  const lp = f.leftParty ?? r.leftParty, rp = f.rightParty ?? r.rightParty;
  const who = (name, party) => `${name}${PARTY[party] ? ` (${party})` : ''}`;
  // Same-party races come from the race list (not the forecast), so the text never depends on a data run.
  const pair = r.samePartyGeneral ? (r.candidates || []).filter(c => !c.writeIn && c.party === r.samePartyGeneral)
    .sort((a, b) => (b.incumbent ? 1 : 0) - (a.incumbent ? 1 : 0)).slice(0, 2) : [];
  const both = { D: 'Democrats', R: 'Republicans' }[r.samePartyGeneral] || 'from one party';
  const desc = pair.length === 2
    ? `${pair[0].name} vs. ${pair[1].name}, both ${both}: odds, prediction markets and live results on election night.`
    : left && right
    ? `${who(left, lp)} vs. ${who(right, rp)}: forecast, polls, prediction markets and live results on election night.`
    : left || right
      ? `${who(left || right, left ? lp : rp)} faces no major-party opponent. Forecast and live results on election night.`
      : 'Forecast and live results on election night.';
  pages.push([`/race/${r.id}`, titleFor(r, stateName[r.state] || r.state), desc]);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function pageHtml(url, title, desc, { noindex = false } = {}) {
  const full = `Ballot Desk - ${title}`;
  const swaps = [
    [/<title>[^<]*<\/title>/, `<title>${esc(full)}</title>`],
    [/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(desc)}">`],
    [/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(full)}">`],
    [/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(desc)}">`],
    [/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${url}">`],
    [/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`],
  ];
  let html = template;
  for (const [re, value] of swaps) {
    if (!re.test(html)) throw new Error(`index.html is missing ${re}`);
    html = html.replace(re, () => value);
  }
  if (noindex) html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta name="robots" content="noindex">');
  return html.replace('<!doctype html>', '<!doctype html>\n<!-- Generated from index.html by pipeline/build_pages.mjs (npm run pages). Edit index.html instead. -->');
}

// The generator owns state/, race/ and archive/ outright, so pages for races that no longer exist disappear.
for (const dir of ['state', 'race', 'archive']) fs.rmSync(path.join(ROOT, dir), { recursive: true, force: true });
for (const [p, title, desc, opts] of pages) {
  const file = path.join(ROOT, `${opts?.file || p}.html`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pageHtml(`${SITE}${p}`, title, desc, opts));
}

const urls = ['/', ...pages.filter(([, , , opts]) => !opts?.noindex).map(([p]) => p)];
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${SITE}${u === '/' ? '/' : u}</loc></url>`).join('\n')}\n</urlset>\n`);
fs.writeFileSync(path.join(ROOT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
console.log(`wrote ${pages.length} pages, sitemap.xml and robots.txt`);
