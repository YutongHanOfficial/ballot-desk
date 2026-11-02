// Broadcast view for live streams: add it to OBS or Streamlabs as a Browser Source. A fixed 1920x1080 (or
// 1080x1920) stage scales to the source, updates itself all night, rotates through maps and key races, scrolls a
// ticker and flashes an alert when a race is projected. Overlays draw one piece on a transparent background.
//   /broadcast                          landscape, for YouTube
//   /broadcast?format=vertical          9:16, for TikTok
//   ?overlay=scoreboard|ticker|alerts   one piece only, transparent background
//   ?panel=senate,house,gov,races,calls  ?rotate=15 (seconds per panel)  ?map=odds  ?theme=light
//   ?demo=live&speed=10                 rehearse on a simulated night
import { h, pct, partyVar, lastName, fmtTimeET, probColor } from '../ui.js';
import { store, subscribe, cur, chamber, marketControl, racesOf, nightMode, awaiting, raceFill } from '../store.js';
import { calledSeats, resultsEnabled } from '../live.js';
import { CONFIG, pollCloseDate, POLL_CLOSE_ET } from '../config.js';
import { CHAMBERS } from './common.js';
import { stateFill } from './home.js';
import { usMap, RESULT_LEGEND, BAND_LEGEND } from '../charts.js';
import { houseHex } from '../maps.js';
import { loadGeo } from '../geo.js';
import { clockLabel } from '../sim.js';

const PANELS = ['senate', 'house', 'gov', 'races', 'calls'];
const PANEL_TITLE = { senate: 'Senate', house: 'House', gov: 'Governors', races: 'Key races', calls: 'Latest projections' };
const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="bc-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f5fd1"/><stop offset="1" stop-color="#d0312d"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#bc-g)"/><rect x="8" y="8" width="16" height="16" rx="3.5" fill="none" stroke="#fff" stroke-width="2.2" opacity=".55"/><path d="M11.6 16.4l3.3 3.3 6.2-7.1" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function options() {
  const q = new URLSearchParams(location.search);
  const panels = (q.get('panel') || '').split(',').map(x => x.trim()).filter(x => PANELS.includes(x));
  const overlay = q.get('overlay');
  return {
    vertical: q.get('format') === 'vertical',
    overlay: ['scoreboard', 'ticker', 'alerts'].includes(overlay) ? overlay : null,
    panels: panels.length ? panels : PANELS,
    rotate: Math.min(300, Math.max(5, +q.get('rotate') || 15)) * 1000,
    odds: q.get('map') === 'odds',
    light: q.get('theme') === 'light',
  };
}

let running = null;   // one broadcast per page

export function render(root) {
  if (running) running.stop();
  const o = options();
  document.documentElement.setAttribute('data-theme', o.light ? 'light' : 'dark');
  document.documentElement.classList.toggle('bc-transparent', !!o.overlay);
  loadGeo('/data/geo/house-hex.json').catch(() => null);
  const [W, H] = o.vertical ? [1080, 1920] : [1920, 1080];
  const stage = h('div', { class: `bc-stage ${o.vertical ? 'vertical' : 'landscape'}${o.overlay ? ` overlay ${o.overlay}` : ''}`, style: { width: `${W}px`, height: `${H}px` } });
  root.append(stage);
  running = start(stage, o, W, H);
}

export const title = () => 'Broadcast';

// ------------------------------------------------------------------------------------------- the stage

function start(stage, o, W, H) {
  const parts = {};
  if (!o.overlay) {
    parts.header = h('header', { class: 'bc-header' });
    parts.score = h('section', { class: 'bc-score' });
    parts.panel = h('section', { class: 'bc-panel' });
    parts.alert = h('div', { class: 'bc-alert-slot' });
    parts.ticker = ticker();
    const main = h('div', { class: 'bc-main' }, parts.panel, parts.alert);
    if (o.vertical) {
      stage.append(parts.header, parts.score, main, parts.ticker.el,
        h('footer', { class: 'bc-foot' }, h('b', null, 'ballotdesk.org'), h('span', null, 'Live results and projections for every race')));
    } else {
      stage.append(parts.header, h('div', { class: 'bc-body' }, main, parts.score), parts.ticker.el);
    }
  } else if (o.overlay === 'scoreboard') {
    parts.score = h('section', { class: 'bc-score strip' });
    stage.append(parts.score);
  } else if (o.overlay === 'ticker') {
    parts.ticker = ticker();
    stage.append(parts.ticker.el);
  } else {
    parts.alert = h('div', { class: 'bc-alert-slot' });
    stage.append(parts.alert);
  }

  const fit = () => {
    const k = Math.min(innerWidth / W, innerHeight / H);
    stage.style.transform = `translate(${(innerWidth - W * k) / 2}px, ${(innerHeight - H * k) / 2}px) scale(${k})`;
  };
  fit();
  addEventListener('resize', fit);

  // Panels rotate on the wall clock, so a data update never restarts the cycle.
  const t0 = Date.now();
  let shown = -1;
  const drawPanel = (force) => {
    if (!parts.panel) return;
    const i = Math.floor((Date.now() - t0) / o.rotate) % o.panels.length;
    if (i === shown && !force) return;
    const fresh = i !== shown;
    parts.panel.replaceChildren(panel(o.panels[i], o, i));
    if (fresh) { parts.panel.classList.remove('enter'); void parts.panel.offsetWidth; parts.panel.classList.add('enter'); }
    shown = i;
  };

  const alerts = alertQueue(parts.alert);
  // On air, one piece failing must not take the rest down: each keeps its last good state.
  const safely = (fn) => { try { fn(); } catch (e) { console.error('broadcast:', e); } };
  const update = () => {
    queued = null;
    if (parts.header) safely(() => drawHeader(parts.header));
    if (parts.score) safely(() => parts.score.replaceChildren(...['senate', 'house', 'gov'].map(t => chamberBlock(t, o))));
    safely(() => drawPanel(true));
    if (parts.ticker) safely(() => parts.ticker.set(tickerItems()));
    safely(() => alerts.check());
  };
  let queued = null;
  const unsubscribe = subscribe(() => { if (!queued) queued = setTimeout(update, 800); });
  update();
  const timer = setInterval(() => {
    if (!document.body.contains(stage)) { stop(); return; }
    if (parts.header) safely(() => tickClock(parts.header));
    safely(() => drawPanel(false));
    safely(() => alerts.tick());
  }, 1000);

  function stop() {
    clearInterval(timer);
    clearTimeout(queued);
    unsubscribe();
    removeEventListener('resize', fit);
    parts.ticker?.stop();
    document.documentElement.classList.remove('bc-transparent');
    let theme = null;
    try { theme = localStorage.getItem('theme'); } catch { /* private mode */ }
    if (theme) document.documentElement.setAttribute('data-theme', theme); else document.documentElement.removeAttribute('data-theme');
    if (running && running.stage === stage) running = null;
  }
  return { stop, stage };
}

// ------------------------------------------------------------------------------------------- header

function drawHeader(el) {
  const sim = !!store.sim;
  const badge = sim ? ['sim', 'Simulation'] : store.live.active || resultsEnabled() ? ['live', 'Live'] : ['', 'Forecast'];
  el.replaceChildren(
    h('div', { class: 'bc-brand' }, h('span', { class: 'bc-logo', html: LOGO }), h('div', null, h('b', null, 'Ballot Desk'), h('span', null, 'ballotdesk.org'))),
    h('div', { class: 'bc-title' }, h('b', null, '2026 Midterms'), h('span', null, 'Election night')),
    h('div', { class: 'bc-right' },
      h('span', { class: `bc-badge ${badge[0]}` }, badge[0] ? h('i', { class: 'live-dot' }) : null, badge[1]),
      h('div', { class: 'bc-clockbox' }, h('b', { class: 'bc-clock' }), h('span', { class: 'bc-sub' }))));
  tickClock(el);
}

function tickClock(el) {
  const clock = el.querySelector('.bc-clock'), sub = el.querySelector('.bc-sub');
  if (!clock) return;
  if (store.sim) { clock.textContent = clockLabel(store.sim.t); sub.textContent = 'Not real results'; return; }
  clock.textContent = fmtTimeET(new Date());
  const first = Date.parse(CONFIG.firstPollsClose);
  const left = first - Date.now();
  if (left > 0 && !store.live.active) {
    const hh = Math.floor(left / 36e5), mm = Math.floor(left / 6e4) % 60, ss = Math.floor(left / 1e3) % 60;
    sub.textContent = `First polls close in ${hh ? `${hh}:${String(mm).padStart(2, '0')}` : mm}:${String(ss).padStart(2, '0')}`;
  } else {
    const at = Object.values(store.live.resultsAt || {}).sort().pop();
    sub.textContent = at ? `Results as of ${fmtTimeET(new Date(at)).replace(' ET', '')}` : 'Waiting for results';
  }
}

// ------------------------------------------------------------------------------------------- scoreboard

function chamberBlock(type, o) {
  const C = CHAMBERS[type];
  const s = calledSeats(type), ch = chamber(type);
  const total = C.total, und = Math.max(0, total - s.D - s.R - s.O);
  const mk = type !== 'gov' && !store.sim ? marketControl(type) : null;
  const seg = (n, color) => n ? h('i', { style: { width: `${(n / total) * 100}%`, background: color } }) : null;
  const odds = type === 'gov'
    ? h('div', { class: 'bc-odds' }, h('span', null, ch.live ? 'Projected final' : 'Forecast'),
      h('b', { class: 'c-dem' }, `${Math.round(ch.dSeats.mean)} D`), h('b', { class: 'c-rep' }, `${50 - Math.round(ch.dSeats.mean)} R`))
    : h('div', { class: 'bc-odds' }, h('span', null, ch.live ? 'Chance of control' : 'Forecast'),
      h('b', { class: 'c-dem' }, `D ${pct(ch.pD)}`), h('b', { class: 'c-rep' }, `R ${pct(ch.pR)}`),
      mk && mk.pD !== null && mk.pD !== undefined && !o.vertical ? h('em', null, `Polymarket D ${pct(mk.pD)}`) : null);
  return h('div', { class: 'bc-chamber' },
    h('div', { class: 'bc-ch-head' }, h('b', null, C.name), h('span', null, `${C.need} to win${type === 'senate' ? ' · incl. seats not up' : type === 'gov' ? ' · incl. not up' : ''}`)),
    h('div', { class: 'bc-seats' }, h('b', { class: 'c-dem' }, s.D), h('span', null, und ? `${und} to call` : 'All called'), h('b', { class: 'c-rep' }, s.R)),
    h('div', { class: 'bc-bar' }, seg(s.D, 'var(--dem)'), seg(und, 'var(--none)'), seg(s.O, 'var(--oth)'), seg(s.R, 'var(--rep)'),
      h('b', { class: 'bc-need', style: { left: `${(C.need / total) * 100}%` } })),
    odds);
}

// ------------------------------------------------------------------------------------------- panels

function oddsFill(r) {
  if (!r) return 'var(--none)';
  if (!r.left || !r.right) return partyVar((r.left ? r.leftParty : r.rightParty) || r.samePartyGeneral, 1);
  return probColor(cur(r).p, r.leftParty, r.rightParty);
}

function panel(kind, o, index) {
  const dots = o.panels.length > 1 ? h('span', { class: 'bc-dots' }, o.panels.map((_, i) => h('i', { class: i === index ? 'on' : '' }))) : null;
  const head = (title, note) => h('div', { class: 'bc-p-head' }, h('div', null, h('b', null, title), note ? h('span', null, note) : null), dots);
  const night = nightMode();
  const results = night && !o.odds;
  const legend = () => h('div', { class: 'bc-legend' }, (results ? RESULT_LEGEND.filter(([, l]) => l !== 'Ind. won') : BAND_LEGEND.slice(0, 7))
    .map(([c, l]) => h('span', null, h('i', { style: { background: c } }), l)));
  if (kind === 'senate' || kind === 'gov' || kind === 'house') {
    const races = racesOf(kind).filter(r => r.left || r.right);
    const called = races.filter(r => store.live.results[r.id]?.called).length;
    const counting = races.filter(r => { const x = store.live.results[r.id]; return x && x.total > 0 && !x.called; }).length;
    const waiting = races.filter(r => awaiting(r)).length;
    const fill = results ? raceFill : oddsFill;
    const map = kind === 'house' ? houseHex({ fill }) : usMap({ fill: stateFill(kind, fill) });
    const note = !night ? 'Colored by our forecast' : results ? 'Solid = projected · light = leading' : 'Colored by live chance of winning';
    return h('div', { class: 'bc-p bc-mapp' }, head(PANEL_TITLE[kind], note), h('div', { class: 'bc-map' }, map), legend(),
      h('div', { class: 'bc-sum' }, h('span', null, h('b', null, called), ` of ${races.length} projected`),
        night ? h('span', null, h('b', null, counting), ' counting') : null, night ? h('span', null, h('b', null, waiting), ' polls open') : null));
  }
  if (kind === 'races') return h('div', { class: 'bc-p' }, head('Key races', night ? 'Share of the vote counted so far · live chance of winning' : 'Chance of winning, before results'), keyRaces(o));
  return h('div', { class: 'bc-p' }, ...latestCalls(o, head));
}

/** The closest contested races: statewide first, then House toss-ups; projected races drop to the bottom. */
function keyRaces(o) {
  const n = o.vertical ? 7 : 8;
  const night = nightMode();
  const close = (r) => Math.abs((cur(r).p ?? 0.5) - 0.5);
  const done = (r) => !!store.live.results[r.id]?.called;
  const pool = (types, lim) => store.races.filter(r => types.includes(r.type) && r.left && r.right && r.p > 0.1 && r.p < 0.9)
    .sort((a, b) => (done(a) - done(b)) || close(a) - close(b)).slice(0, lim);
  const statewide = pool(['senate', 'gov'], n);
  const list = statewide.concat(pool(['house'], n - Math.min(statewide.length, n - 2))).slice(0, n);
  return h('div', { class: 'bc-races' }, list.map(r => {
    const c = cur(r), res = c.result, tot = res?.total || 0;
    const side = (s) => {
      const name = s === 'left' ? r.left : r.right, party = s === 'left' ? r.leftParty : r.rightParty;
      const v = res ? (s === 'left' ? res.left : res.right) : 0;
      const won = res?.called === s;
      const val = tot ? `${((v / tot) * 100).toFixed(1)}%` : pct(s === 'left' ? c.p : 1 - c.p);
      return h('div', { class: `bc-cand${won ? ' won' : ''}` }, h('i', { class: `party-chip ${party}` }, party),
        h('span', { class: 'nm' }, lastName(name), won ? h('em', null, '✓') : null), h('b', { style: { color: partyVar(party) } }, val));
    };
    const p = c.p ?? 0.5, fav = p >= 0.5 ? r.leftParty : r.rightParty;
    const status = res?.called ? h('span', { class: 'bc-status called' }, 'Projected')
      : awaiting(r) ? h('span', { class: 'bc-status' }, `Polls ${fmtTimeET(pollCloseDate(r.state)).replace(' ET', '').replace(':00', '')}`)
      : tot ? h('span', { class: 'bc-status' }, h('span', { class: 'bc-in' }, h('i', { style: { width: `${Math.min(100, c.eevp)}%` } })), `${Math.round(c.eevp)}% in`)
      : h('span', { class: 'bc-status' }, night ? 'No votes yet' : r.office);
    return h('div', { class: 'bc-race' },
      h('div', { class: 'bc-label' }, h('b', null, r.type === 'house' ? r.short : r.stateName), h('span', null, r.type === 'house' ? 'House' : r.office)),
      side('left'), side('right'), status,
      h('div', { class: 'bc-chance', style: { color: partyVar(fav) } }, res?.called ? '' : `${fav === 'D' || fav === 'R' ? fav : lastName(p >= 0.5 ? r.left : r.right)} ${pct(Math.min(0.99, Math.max(p, 1 - p)))}`));
  }));
}

/** Every contested projection so far, newest first. */
function callsNow() {
  const out = [];
  for (const r of store.races) {
    if (!['senate', 'gov', 'house'].includes(r.type) || !r.left || !r.right) continue;
    const res = store.live.results[r.id];
    if (!res || (res.called !== 'left' && res.called !== 'right') || !res.calledAt) continue;
    const party = res.called === 'left' ? r.leftParty : r.rightParty;
    out.push({ id: r.id, r, party, name: res.called === 'left' ? r.left : r.right, at: new Date(res.calledAt), flip: !!r.holder && party !== r.holder });
  }
  return out.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

const callTag = (r) => r.type === 'house' ? r.short : `${r.stateName} ${r.type === 'gov' ? 'Gov.' : 'Sen.'}`;

function latestCalls(o, head) {
  const n = o.vertical ? 9 : 10;
  const calls = callsNow().filter(c => c.r.type !== 'house' || c.flip || (c.r.p > 0.1 && c.r.p < 0.9)).slice(0, n);
  if (calls.length) {
    return [head('Latest projections', store.sim ? 'Simulated decision desk' : 'Calls by the Associated Press'),
      h('div', { class: 'bc-calls' }, calls.map(c => h('div', { class: 'bc-call' },
        h('span', { class: 'bc-t' }, fmtTimeET(c.at).replace(' ET', '')),
        h('i', { class: `party-chip ${c.party}` }, c.party),
        h('span', { class: 'bc-what' }, h('b', null, lastName(c.name)), ` wins ${callTag(c.r)}`),
        c.flip ? h('span', { class: 'bc-flip', style: { background: partyVar(c.party) } }, `${c.party} pickup`) : null)))];
  }
  // Before any calls: when the polls close, with the races to watch at each hour.
  const groups = {};
  for (const [st, t] of Object.entries(POLL_CLOSE_ET)) if (store.stateByCode[st]) (groups[t] ||= []).push(st);
  const now = Date.now();
  const rows = Object.values(groups).map(sts => ({ d: pollCloseDate(sts[0]), sts: sts.sort() })).sort((a, b) => a.d - b.d)
    .filter(g => store.sim || g.d > now - 30 * 60000).slice(0, n);
  return [head('When polls close', 'Eastern time'),
    h('div', { class: 'bc-calls' }, rows.map(g => {
      const watch = g.sts.flatMap(st => (store.byState[st] || []).filter(r => (r.type === 'senate' || r.type === 'gov') && r.left && r.right && r.p > 0.1 && r.p < 0.9));
      return h('div', { class: 'bc-call' }, h('span', { class: 'bc-t' }, fmtTimeET(g.d).replace(' ET', '')),
        h('span', { class: 'bc-what' }, h('b', null, g.sts.join(' · ')), watch.length ? h('em', null, `Watch: ${watch.map(callTag).join(', ')}`) : null));
    }))];
}

// ------------------------------------------------------------------------------------------- ticker

function tickerItems() {
  const items = [];
  const calls = callsNow().filter(c => c.r.type !== 'house' || c.flip || (c.r.p > 0.15 && c.r.p < 0.85)).slice(0, 10);
  for (const c of calls) items.push(h('span', { class: 'bc-item' }, h('i', { class: `party-chip ${c.party}` }, c.party), `${lastName(c.name)} wins ${callTag(c.r)}${c.flip ? ` · ${c.party} pickup` : ''}`));
  const counting = store.races.filter(r => (r.type === 'senate' || r.type === 'gov') && r.left && r.right && r.p > 0.1 && r.p < 0.9)
    .filter(r => { const x = store.live.results[r.id]; return x && x.total > 0 && !x.called; });
  for (const r of counting.slice(0, 8)) {
    const x = store.live.results[r.id];
    items.push(h('span', { class: 'bc-item' }, h('b', null, callTag(r)), ` ${lastName(r.left)} ${((x.left / x.total) * 100).toFixed(1)}% · ${lastName(r.right)} ${((x.right / x.total) * 100).toFixed(1)}% · ${Math.round(x.eevp)}% in`));
  }
  for (const type of ['senate', 'house']) {
    const ch = chamber(type);
    items.push(h('span', { class: 'bc-item' }, h('b', null, CHAMBERS[type].name), ` ${ch.live ? 'live chance' : 'forecast'}: Democrats ${pct(ch.pD)} · Republicans ${pct(ch.pR)}`));
  }
  if (!items.length || !nightMode()) items.push(h('span', { class: 'bc-item' }, `The first polls close at 6 p.m. Eastern; results arrive here as they are counted`));
  items.push(h('span', { class: 'bc-item' }, h('b', null, 'ballotdesk.org'), ' · forecasts, maps and live results for every race'));
  return items;
}

/** A crawl that never jumps: positions come from elapsed time, and new items swap in as one copy scrolls off. */
function ticker() {
  const track = h('div', { class: 'bc-track' });
  const view = h('div', { class: 'bc-tick-view' }, track);
  const el = h('div', { class: 'bc-ticker' }, h('div', { class: 'bc-tick-label' }, 'Latest'), view);
  let pending = null, width = 0, offset = 0, last = performance.now(), raf = 0, sig = '';
  const SPEED = 120;   // stage pixels per second
  const apply = () => {
    const run = h('div', { class: 'bc-run' }, pending);
    track.replaceChildren(run);
    width = run.offsetWidth;
    // enough copies to cover the bar even when there are only a few items
    const copies = width ? Math.ceil((view.offsetWidth || 1600) / width) + 1 : 2;
    for (let i = 1; i < copies; i++) track.appendChild(run.cloneNode(true));
    pending = null;
  };
  const frame = (now) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    offset += SPEED * dt;
    if (width && offset >= width) { offset -= width; if (pending) { apply(); offset = 0; } }
    if (!width && pending) apply();
    track.style.transform = `translateX(${-offset}px)`;
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return {
    el,
    set(items) {
      const next = items.map(i => i.textContent).join('|');
      if (next === sig) return;
      sig = next;
      pending = items;
      if (!width) apply();
    },
    stop() { cancelAnimationFrame(raf); },
  };
}

// ------------------------------------------------------------------------------------------- alerts

/**
 * "Projected winner" alerts for calls that happen while the page is open (not ones already made when it loads).
 * Senate and governor calls and competitive or flipped House seats get their own alert; safe seats called at
 * the same minute are grouped; a party reaching a majority gets the big one.
 */
function alertQueue(slot) {
  const seen = new Set(callsNow().map(c => c.id));
  const majority = (type) => { const s = calledSeats(type), C = CHAMBERS[type]; return s.D >= C.need ? 'D' : s.R >= C.needR ? 'R' : null; };
  const control = { senate: majority('senate'), house: majority('house') };
  const queue = [];
  let current = null;
  const show = (item) => {
    if (!slot) return;
    const party = item.party;
    let body;
    if (item.kind === 'control') {
      body = [h('div', { class: 'bc-a-label' }, 'Projection'),
        h('div', { class: 'bc-a-big' }, `${party === 'D' ? 'Democrats win' : 'Republicans keep'} the ${CHAMBERS[item.type].name}`)];
    } else if (item.kind === 'batch') {
      body = [h('div', { class: 'bc-a-label' }, 'Projected as polls close'),
        h('div', { class: 'bc-a-list' }, item.calls.slice(0, 8).map(c => h('span', null, h('i', { class: `party-chip ${c.party}` }, c.party), callTag(c.r))),
          item.calls.length > 8 ? h('span', null, `+${item.calls.length - 8} more`) : null)];
    } else {
      const c = item.call;
      body = [h('div', { class: 'bc-a-label' }, 'Projected winner', c.flip ? h('span', { class: 'bc-flip' }, `${c.party} pickup`) : null),
        h('div', { class: 'bc-a-big' }, c.name, h('i', { class: `party-chip ${c.party}` }, c.party)),
        h('div', { class: 'bc-a-race' }, `${c.r.title}${store.sim ? ' · simulated' : ' · AP projection'}`)];
    }
    const box = h('div', { class: `bc-alert ${item.kind}` }, body);
    box.style.setProperty('--party', party ? partyVar(party) : 'var(--gold)');
    slot.replaceChildren(box);
  };
  return {
    check() {
      const fresh = callsNow().filter(c => !seen.has(c.id)).reverse();   // oldest first
      fresh.forEach(c => seen.add(c.id));
      const key = fresh.filter(c => c.r.type !== 'house' ? (c.flip || (c.r.p > 0.05 && c.r.p < 0.95)) : (c.flip || (c.r.p > 0.1 && c.r.p < 0.9)));
      const safe = fresh.filter(c => c.r.type !== 'house' && !key.includes(c));
      for (const c of key) queue.push({ kind: 'call', call: c, party: c.party });
      if (safe.length) queue.push({ kind: 'batch', calls: safe, party: null });
      for (const type of ['senate', 'house']) {
        const w = majority(type);
        if (w && w !== control[type]) { control[type] = w; queue.unshift({ kind: 'control', type, party: w }); }
      }
      // A burst (a fast rehearsal, or a wave of calls as polls close) must not leave alerts minutes behind:
      // past eight waiting, the oldest House-only ones give way.
      while (queue.length > 8) {
        const i = queue.findIndex(x => x.kind === 'call' && x.call.r.type === 'house');
        if (i < 0) break;
        queue.splice(i, 1);
      }
    },
    tick() {
      const now = Date.now();
      if (current && now < current.until) return;
      if (current) { current = null; slot?.replaceChildren(); return; }   // a beat of empty screen between alerts
      const next = queue.shift();
      if (!next) return;
      current = { ...next, until: now + (next.kind === 'control' ? 12000 : queue.length > 3 ? 5000 : 8000) };
      show(next);
    },
  };
}

