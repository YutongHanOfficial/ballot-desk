// Boot, routing and live re-rendering.
import { CONFIG } from './config.js';
import { h, timeAgo } from './ui.js';
import { store, loadData, subscribe } from './store.js';
import { startLive, recompute, resultsEnabled } from './live.js';
import * as home from './views/home.js';
import * as chamberView from './views/chamber.js';
import * as states from './views/states.js';
import * as race from './views/race.js';
import * as liveView from './views/liveview.js';
import * as downballot from './views/downballot.js';
import * as method from './views/method.js';

const main = document.getElementById('main');
const statusEl = document.getElementById('status');

const ROUTES = [
  { re: /^\/?$/, nav: 'home', render: (root) => home.render(root), title: () => home.title() },
  { re: /^\/senate$/, nav: 'senate', render: (root) => chamberView.renderChamber(root, 'senate'), title: () => chamberView.title('senate') },
  { re: /^\/house$/, nav: 'house', render: (root) => chamberView.renderChamber(root, 'house'), title: () => chamberView.title('house') },
  { re: /^\/governors$/, nav: 'governors', render: (root) => chamberView.renderChamber(root, 'gov'), title: () => chamberView.title('gov') },
  { re: /^\/states$/, nav: 'states', render: (root) => states.renderIndex(root), title: () => 'States' },
  { re: /^\/state\/([A-Z]{2})$/, nav: 'states', render: (root, m) => states.renderState(root, m[1]), title: (m) => states.title(m[1]) },
  { re: /^\/race\/([A-Z0-9-]+)$/, nav: null, render: (root, m) => race.render(root, m[1]), title: (m) => race.title(m[1]) },
  { re: /^\/live$/, nav: 'live', render: (root) => liveView.render(root), title: () => liveView.title() },
  { re: /^\/downballot(?:\/(\w+))?$/, nav: 'downballot', render: (root, m) => downballot.render(root, { tab: m[1] }), title: () => downballot.title() },
  { re: /^\/methodology$/, nav: 'methodology', render: (root) => method.render(root), title: () => method.title() },
];

let current = null;

function route() {
  const path = decodeURIComponent((location.hash || '#/').slice(1)).split('?')[0];
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) return { r, m, path };
  }
  return { r: ROUTES[0], m: [], path: '/' };
}

function render({ keepScroll = false } = {}) {
  const { r, m, path } = route();
  const sameView = current && current.path === path;
  const y = window.scrollY;
  const root = h('div', { class: 'view' });
  try {
    r.render(root, m);
  } catch (e) {
    console.error(e);
    root.replaceChildren(h('div', { class: 'card empty' }, 'Something went wrong drawing this page. ', h('a', { href: '#/' }, 'Back to the overview')));
  }
  main.replaceChildren(root);
  document.title = `${r.title(m)} · ${CONFIG.siteName}`;
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === r.nav));
  if (keepScroll && sameView) window.scrollTo(0, y);
  else if (!sameView) window.scrollTo(0, 0);
  current = { path };
  drawStatus();
}

function drawStatus() {
  const L = store.live;
  const items = [];
  if (L.demo) items.push(h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } }, h('span', { class: 'live-dot' }), h('b', null, 'Demo election night')));
  else if (L.active) items.push(h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } }, h('span', { class: 'live-dot' }), h('b', null, 'Live results')));
  else if (resultsEnabled()) items.push(h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } }, h('span', { class: 'live-dot' }), h('b', null, 'Election night: awaiting results')));
  items.push(h('span', null, 'Forecast updated ', h('b', null, timeAgo(store.forecast?.updated))));
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
  clearTimeout(pending);
  pending = setTimeout(() => {
    // Don't yank the page out from under someone typing in a search box.
    const ae = document.activeElement;
    if (ae && ae.tagName === 'INPUT' && main.contains(ae)) { drawStatus(); return; }
    render({ keepScroll: true });
  }, 250);
}

async function boot() {
  initTheme();
  try {
    await loadData({ first: true });
  } catch (e) {
    console.error(e);
    main.replaceChildren(h('div', { class: 'card empty' }, 'Could not load the forecast data. Please refresh in a minute.'));
    return;
  }
  render();
  window.addEventListener('hashchange', () => render());
  subscribe((reason) => { if (reason === 'markets' && !isMarketView()) { drawStatus(); return; } scheduleRender(); });
  recompute();
  startLive();
  setInterval(drawStatus, 30000);
}

function isMarketView() {
  const { r } = route();
  return ['home', 'senate', 'house', 'governors', 'live', null, 'states'].includes(r.nav);
}

boot();
