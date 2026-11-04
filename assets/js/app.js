// Boot, routing and live re-rendering.
import { CONFIG, supportLinks } from './config.js';
import { h, timeAgo, fmtTimeET } from './ui.js';
import { store, loadData, subscribe, forecastFinal } from './store.js';
import { startLive, recompute, resultsEnabled, liveFrontPage } from './live.js';
import * as home from './views/home.js';
import * as chamberView from './views/chamber.js';
import * as states from './views/states.js';
import * as race from './views/race.js';
import * as liveView from './views/liveview.js';
import * as downballot from './views/downballot.js';
import * as method from './views/method.js';
import * as simulate from './views/simulate.js';
import * as support from './views/support.js';
import * as broadcast from './views/broadcast.js';
import * as stream from './views/stream.js';
import * as credits from './views/credits.js';
import * as legal from './views/legal.js';
import { loadPhotos } from './photos.js';
import { START, END, clockLabel, togglePlay, setSpeed, seek, stopSim } from './sim.js';
import { navigate, currentPath, upgradeHashLink, tidyAddress } from './nav.js';

const main = document.getElementById('main');
const statusEl = document.getElementById('status');

// On election night the front page is the live dashboard; the forecast overview moves to /forecast.
const ROUTES = [
  { re: /^\/?$/, nav: () => liveFrontPage() ? 'live' : 'home',
    render: (root) => liveFrontPage() ? liveView.render(root) : home.render(root),
    title: () => liveFrontPage() ? liveView.title() : home.title() },
  { re: /^\/forecast$/, nav: 'home', render: (root) => home.render(root), title: () => home.title() },
  { re: /^\/senate$/, nav: 'senate', render: (root) => chamberView.renderChamber(root, 'senate'), title: () => chamberView.title('senate') },
  { re: /^\/house$/, nav: 'house', render: (root) => chamberView.renderChamber(root, 'house'), title: () => chamberView.title('house') },
  { re: /^\/governors$/, nav: 'governors', render: (root) => chamberView.renderChamber(root, 'gov'), title: () => chamberView.title('gov') },
  { re: /^\/states$/, nav: 'states', render: (root) => states.renderIndex(root), title: () => 'States' },
  { re: /^\/state\/([A-Z]{2})$/, nav: 'states', render: (root, m) => states.renderState(root, m[1]), title: (m) => states.title(m[1]) },
  { re: /^\/race\/([A-Z0-9-]+)$/, nav: null, render: (root, m) => race.render(root, m[1]), title: (m) => race.title(m[1]) },
  { re: /^\/live$/, nav: 'live', render: (root) => liveView.render(root), title: () => liveView.title() },
  { re: /^\/downballot$/, nav: 'downballot', render: (root) => downballot.render(root, { tab: new URLSearchParams(location.search).get('tab') }), title: () => downballot.title() },
  { re: /^\/methodology$/, nav: 'methodology', render: (root) => method.render(root), title: () => method.title() },
  { re: /^\/simulate$/, nav: 'simulate', render: (root) => simulate.render(root), title: () => simulate.title() },
  { re: /^\/support$/, nav: 'support', render: (root) => support.render(root), title: () => support.title() },
  { re: /^\/broadcast$/, nav: 'broadcast', render: (root) => broadcast.render(root), title: () => broadcast.title() },
  { re: /^\/stream$/, nav: 'stream', render: (root) => stream.render(root), title: () => stream.title() },
  { re: /^\/credits$/, nav: 'credits', render: (root) => credits.render(root), title: () => credits.title() },
  { re: /^\/terms$/, nav: 'terms', render: (root) => legal.renderTerms(root), title: () => legal.termsTitle() },
  { re: /^\/privacy$/, nav: 'privacy', render: (root) => legal.renderPrivacy(root), title: () => legal.privacyTitle() },
];

// Unknown addresses inside the app get a proper not-found page instead of silently showing the front page.
const NOT_FOUND = {
  nav: null, title: () => 'Page not found',
  render: (root) => root.append(h('div', { class: 'card not-found' },
    h('div', { class: 'eyebrow' }, 'Page not found'),
    h('h1', null, 'We couldn’t find that page'),
    h('p', { class: 'dek' }, 'The link may be mistyped, or the page may have moved. Try one of these instead:'),
    h('div', { class: 'nf-links' },
      liveFrontPage() ? h('a', { class: 'btn primary', href: '/' }, h('span', { class: 'live-dot' }), 'Live results') : h('a', { class: 'btn primary', href: '/' }, 'Forecast overview'),
      liveFrontPage() ? h('a', { class: 'btn', href: '/forecast' }, 'Forecast') : h('a', { class: 'btn', href: '/live' }, 'Election night'),
      h('a', { class: 'btn', href: '/senate' }, 'Senate'), h('a', { class: 'btn', href: '/house' }, 'House'),
      h('a', { class: 'btn', href: '/governors' }, 'Governors'), h('a', { class: 'btn', href: '/states' }, 'States'),
      h('a', { class: 'btn', href: '/simulate' }, 'Simulator')))),
};

let current = null;
const navOf = (r) => typeof r.nav === 'function' ? r.nav() : r.nav;

/** Election night: Live leads the menu and the overview link becomes the pre-election forecast. */
let navLive = null;
function setupNav() {
  const live = liveFrontPage();
  if (live === navLive) return false;
  navLive = live;
  const nav = document.querySelector('.nav');
  const liveLink = nav.querySelector('[data-nav="live"]');
  const overview = nav.querySelector('[data-nav="home"]');
  overview.textContent = live ? 'Forecast' : 'Overview';
  overview.setAttribute('href', live ? '/forecast' : '/');
  // Live is always one of the first two tabs: first while results are coming in, right after Overview before.
  if (live) nav.prepend(liveLink);
  else overview.after(liveLink);
  return true;
}

// ---- simulation playback bar (lives in the sticky header; built once per run, then updated in place)
let simBar = null;
function drawSimBar() {
  const host = document.getElementById('simbar');
  const s = store.sim;
  if (!s) { if (simBar) { host.replaceChildren(); simBar = null; } return; }
  if (!simBar) {
    const play = h('button', { type: 'button', class: 'sim-btn', title: 'Play / pause', onclick: () => togglePlay() });
    const speeds = h('div', { class: 'seg sim-speeds' }, [1, 3, 10, 30].map(x => h('button', { type: 'button', 'data-x': x, onclick: () => setSpeed(x) }, `${x}×`)));
    const range = h('input', { type: 'range', min: START, max: END, step: 1, class: 'sim-range', 'aria-label': 'Simulation timeline' });
    let resume = false;
    range.addEventListener('pointerdown', () => { resume = store.sim && store.sim.playing; if (resume) togglePlay(); });
    range.addEventListener('input', () => seek(parseFloat(range.value)));
    range.addEventListener('change', () => { if (resume && store.sim && !store.sim.playing) togglePlay(); resume = false; });
    const clock = h('b', { class: 'sim-clock' });
    simBar = { play, speeds, range, clock,
      el: h('div', { class: 'simbar-inner' },
        h('span', { class: 'sim-badge' }, h('span', { class: 'live-dot' }), 'Simulation'), clock, play, speeds,
        h('div', { class: 'sim-track' }, range, h('div', { class: 'sim-ticks' },
          [[0, '6 PM'], [360, 'Midnight'], [600, '4 AM'], [END, 'Days later']].map(([t, label]) => h('span', { style: { left: `${((t - START) / (END - START)) * 100}%` } }, label)))),
        h('button', { type: 'button', class: 'sim-btn', title: 'Skip to the final result', onclick: () => seek(END) }, '⏭'),
        h('a', { class: 'sim-link', href: '/live' }, 'Dashboard'),
        h('button', { type: 'button', class: 'sim-btn sim-exit', title: 'Exit the simulation', onclick: () => stopSim() }, '✕')) };
    host.replaceChildren(simBar.el);
  }
  simBar.play.textContent = s.playing ? '❚❚' : '▶';
  simBar.clock.textContent = clockLabel(s.t);
  if (document.activeElement !== simBar.range) simBar.range.value = s.t;
  simBar.speeds.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.x === s.speed));
}

function route() {
  const path = currentPath();
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) return { r, m, path };
  }
  return { r: NOT_FOUND, m: [], path };
}

// Pages that present the forecast: once polls close, they keep showing the final forecast while results come in
// (store.frozen). The live dashboard, race and state pages and the broadcast show the count.
const FORECAST_PAGES = new Set(['home', 'senate', 'house', 'governors']);

function render({ keepScroll = false } = {}) {
  const { r, m, path } = route();
  const key = `${path}|${navOf(r)}`;
  store.frozen = FORECAST_PAGES.has(navOf(r));
  const sameView = current && current.key === key;
  document.body.classList.toggle('broadcast-mode', navOf(r) === 'broadcast');
  const y = window.scrollY;
  const root = h('div', { class: 'view' });
  try {
    r.render(root, m);
  } catch (e) {
    console.error(e);
    root.replaceChildren(h('div', { class: 'card empty' }, 'Something went wrong drawing this page. ', h('a', { href: '/' }, 'Back to the front page')));
  }
  main.replaceChildren(root);
  document.title = `${CONFIG.siteName} - ${r.title(m)}`;
  document.querySelectorAll('.nav a, .support-btn').forEach(a => a.classList.toggle('active', a.dataset.nav === navOf(r)));
  if (keepScroll && sameView) window.scrollTo(0, y);
  else if (!sameView) window.scrollTo(0, 0);
  // Links to a section (/methodology#backcast) land on it once the page is drawn.
  if (!sameView && location.hash.length > 1) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  current = { key, loc: location.pathname + location.search };
  drawStatus();
}

function drawStatus() {
  const L = store.live;
  const items = [];
  if (L.demo) items.push(h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } }, h('span', { class: 'live-dot' }), h('b', null, 'Simulated election night')));
  else if (L.active) items.push(h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } }, h('span', { class: 'live-dot' }), h('b', null, 'Live results')));
  else if (resultsEnabled()) items.push(h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } }, h('span', { class: 'live-dot' }), h('b', null, 'Election night: awaiting results')));
  const fu = store.forecast?.updated;
  items.push(forecastFinal() && fu
    ? h('span', null, 'Final forecast ', h('b', null, fmtTimeET(new Date(fu))))
    : h('span', null, 'Forecast updated ', h('b', null, timeAgo(fu))));
  if (L.marketsAt) items.push(h('span', null, 'Markets ', h('b', null, timeAgo(L.marketsAt))));
  const res = Object.values(L.resultsAt || {}).sort().pop();
  if (res && !L.demo) items.push(h('span', null, 'Results ', h('b', null, timeAgo(res))));
  const out = [];
  items.forEach((it, i) => { if (i) out.push(h('span', { class: 'sep' })); out.push(it); });
  statusEl.replaceChildren(...out);
}

// Theme toggle (remembered per browser)
function initTheme() {
  const btn = document.getElementById('theme-btn');
  const apply = (t) => { if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); };
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch { saved = null; }
  apply(saved);
  btn.addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = dark ? 'light' : 'dark';
    apply(next);
    try { localStorage.setItem('theme', next); } catch { /* private mode */ }
    render({ keepScroll: true });
  });
}

let pending = null;
function scheduleRender() {
  if (!store.sim) clearTimeout(pending);
  if (pending && store.sim) return;   // during playback, render at most every 700 ms
  pending = setTimeout(() => {
    pending = null;
    // Don't yank the page out from under someone typing in a search box.
    const ae = document.activeElement;
    if (ae && ae.tagName === 'INPUT' && main.contains(ae)) { drawStatus(); return; }
    render({ keepScroll: true });
  }, store.sim ? 700 : 250);
}

// Donations: a Support button beside the theme toggle and a line in the footer, once a donation page is set.
function setupSupport() {
  if (!supportLinks().length) return;
  const tools = document.querySelector('.header-tools');
  tools.prepend(h('a', { class: 'support-btn', href: '/support', 'data-nav': 'support', title: 'Support Ballot Desk' }, support.heart(), h('span', null, 'Support')));
  document.querySelector('.footer-inner > div')?.append(h('p', null, 'Ballot Desk is free, with no ads or paywall. ', h('a', { href: '/support' }, 'Help keep it running'), '.'));
}

// In-site links change the page without a reload, so live feeds and a running simulation carry on.
function onLinkClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download')) return;
  const href = a.getAttribute('href');
  if (!href.startsWith('/') || href.startsWith('//')) return;
  e.preventDefault();
  navigate(href);
}

// Back/forward and navigate(): redraw unless only an in-page #anchor changed.
function onLocationChange() {
  if (current && current.loc === location.pathname + location.search) return;
  render();
}

async function boot() {
  upgradeHashLink();
  tidyAddress();
  initTheme();
  setupNav();
  setupSupport();
  // GitHub Pages can answer 503 for a moment while a deploy (one every 20 minutes) spreads: retry before giving up.
  for (let attempt = 1; ; attempt++) {
    try {
      await loadData({ first: true });
      break;
    } catch (e) {
      if (attempt < 4) { await new Promise(r => setTimeout(r, 1500 * attempt)); continue; }
      console.error(e);
      main.replaceChildren(h('div', { class: 'card empty' }, 'Could not load the forecast data. Please refresh in a minute.'));
      return;
    }
  }
  render();
  try { sessionStorage.removeItem('bdReloads'); } catch { /* private mode */ }   // index.html's retry count
  loadPhotos();   // after the first paint: pages redraw with headshots when it lands
  setTimeout(keepCopy, 2000);
  window.addEventListener('popstate', onLocationChange);
  window.addEventListener('bd:navigate', onLocationChange);
  document.addEventListener('click', onLinkClick);
  subscribe((reason) => {
    if (navOf(route().r) === 'broadcast') return;   // the broadcast stage updates itself, without a full redraw
    if (reason === 'sim') drawSimBar();
    if (reason === 'markets' && !isMarketView()) { drawStatus(); return; }
    scheduleRender();
  });
  drawSimBar();
  recompute();
  startLive();
  setInterval(() => {
    // Crossing into (or out of) the results window switches the front page and restarts the live feeds.
    if (setupNav()) { startLive(); render(); } else drawStatus();
  }, 30000);
}

// A saved copy of the site (sw.js) that stands in when GitHub Pages briefly answers with an error. The first visit
// loads before the worker exists, so it is handed what this page already loaded, plus the front page as a shell.
function keepCopy() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then((reg) => {
      const urls = [`${location.origin}/`, location.href, ...performance.getEntriesByType('resource').map(e => e.name)];
      reg.active?.postMessage({ type: 'save', urls: urls.filter(u => u.startsWith(`${location.origin}/`)) });
    })
    .catch(() => { /* not supported, or storage blocked: the site works without it */ });
}

function isMarketView() {
  const { r } = route();
  return ['home', 'senate', 'house', 'governors', 'live', null, 'states'].includes(navOf(r));
}

boot();
