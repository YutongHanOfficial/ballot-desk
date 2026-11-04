// Broadcast view for live streams: add it to OBS or Streamlabs as a Browser Source. A fixed 1920x1080 (or
// 1080x1920) stage scales to the source, updates itself all night, rotates through maps and key races, scrolls a
// ticker and flashes an alert when a race is projected. Overlays draw one piece on a transparent background.
//   /broadcast                          landscape, for YouTube
//   /broadcast?format=vertical          9:16, for TikTok
//   ?overlay=scoreboard|ticker|alerts   one piece only, transparent background
//   ?panel=senate,house,gov,races,calls  ?rotate=15 (seconds per panel)  ?map=odds  ?theme=light
//   ?demo=live&speed=10                 rehearse on a simulated night
import { h, pct, num, partyVar, lastName, fmtTimeET, marginText } from '../ui.js';
import { store, subscribe, cur, chamber, marketControl, racesOf, nightMode, awaiting, raceFill, projectionFill, counting, catchUp, catchUpText } from '../store.js';
import { calledSeats, resultsEnabled, houseVote } from '../live.js';
import { CONFIG, pollCloseDate, POLL_CLOSE_ET } from '../config.js';
import { CHAMBERS } from './common.js';
import { stateFill, stateCalled } from './home.js';
import { usMap, marginLegend } from '../charts.js';
import { houseHex } from '../maps.js';
import { loadGeo } from '../geo.js';
import { clockLabel } from '../sim.js';
import { avatar, photoOf, licenseText } from '../photos.js';

const PANELS = ['senate', 'house', 'gov', 'races', 'calls'];
const PANEL_TITLE = { senate: 'Senate', house: 'House', gov: 'Governors', races: 'Key races', calls: 'Latest projections' };
const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="bc-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f5fd1"/><stop offset="1" stop-color="#d0312d"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#bc-g)"/><rect x="8" y="8" width="16" height="16" rx="3.5" fill="none" stroke="#fff" stroke-width="2.2" opacity=".55"/><path d="M11.6 16.4l3.3 3.3 6.2-7.1" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SIX_PM = Date.UTC(2026, 10, 3, 23, 0);

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
    parts.stats = h('section', { class: 'bc-stats' });
    parts.score = h('section', { class: 'bc-score' });
    parts.panel = h('section', { class: 'bc-panel bc-card' });
    parts.alert = h('div', { class: 'bc-alert-slot' });
    parts.ticker = ticker();
    const main = h('div', { class: 'bc-main' }, parts.panel, parts.alert);
    if (o.vertical) {
      stage.append(parts.header, parts.stats, parts.score, main, parts.ticker.el,
        h('footer', { class: 'bc-foot' }, h('b', null, 'ballotdesk.org'), h('span', null, 'Live results and projections for every race'),
          h('span', { class: 'bc-foot-credit' }, 'Candidate photos via Wikipedia · credits at ballotdesk.org/credits')));
    } else {
      stage.append(parts.header, parts.stats, h('div', { class: 'bc-body' }, main, parts.score), parts.ticker.el);
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
    parts.panel.querySelectorAll('.bc-watch, .bc-calls').forEach(fitList);
    if (fresh) { parts.panel.classList.remove('enter'); void parts.panel.offsetWidth; parts.panel.classList.add('enter'); }
    shown = i;
  };

  const alerts = alertQueue(parts.alert);
  // On air, one piece failing must not take the rest down: each keeps its last good state.
  const safely = (fn) => { try { fn(); } catch (e) { console.error('broadcast:', e); } };
  let queued = null;
  const update = () => {
    queued = null;
    if (parts.header) safely(() => drawHeader(parts.header));
    if (parts.stats) safely(() => drawStats(parts.stats, o));
    if (parts.score) safely(() => parts.score.replaceChildren(...['senate', 'house', 'gov'].map(t => chamberBlock(t, o))));
    safely(() => drawPanel(true));
    if (parts.ticker) safely(() => parts.ticker.set(tickerItems()));
    safely(() => alerts.check());
  };
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

// ------------------------------------------------------------------------------------------- helpers

/** Drop trailing rows that would hang off the bottom of a list: names and counts vary, and half a row looks broken. */
function fitList(list) {
  const bottom = list.getBoundingClientRect().bottom + 0.5;
  const rows = [...list.children].filter(e => !e.classList.contains('bc-w-title'));
  for (let i = rows.length - 1; i > 0 && rows[i].getBoundingClientRect().bottom > bottom; i--) rows[i].remove();
}

const nowMs = () => store.sim ? SIX_PM + Math.min(store.sim.t, 600) * 60000 : Date.now();
const callTag = (r) => r.type === 'house' ? r.short : `${r.stateName} ${r.type === 'gov' ? 'Gov.' : 'Sen.'}`;
const inText = (e) => e > 0 && e < 1 ? '<1% in' : `${Math.round(e || 0)}% in`;
const votesShort = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
const closeTime = (r) => fmtTimeET(pollCloseDate(r.state)).replace(' ET', '').replace(':00', '');

/** The side a probability favours: { party, tag: 'D' / 'R' / an independent's surname, q }. */
function favOdds(r, p) {
  const left = p >= 0.5, party = left ? r.leftParty : r.rightParty;
  return { party, tag: party === 'D' || party === 'R' ? party : lastName(left ? r.left : r.right), q: Math.min(0.999, Math.max(p, 1 - p)) };
}

/** The next poll closing still to come, with its states. */
function nextClose() {
  const groups = {};
  for (const [st, t] of Object.entries(POLL_CLOSE_ET)) if (store.stateByCode[st]) (groups[t] ||= []).push(st);
  const now = nowMs();
  return Object.values(groups).map(sts => ({ d: pollCloseDate(sts[0]), sts: sts.sort() })).filter(g => g.d > now).sort((a, b) => a.d - b.d)[0] || null;
}

/** Uncalled races where a party leads the count. */
function leadingSeats(type) {
  const out = { D: 0, R: 0, O: 0 };
  for (const r of racesOf(type)) {
    if (!r.left || !r.right) continue;
    const res = store.live.results[r.id];
    if (!res || res.called || !res.total || res.left === res.right) continue;
    const p = res.left > res.right ? r.leftParty : r.rightParty;
    out[p === 'D' || p === 'R' ? p : 'O']++;
  }
  return out;
}

/** Every contested projection so far, newest first. */
function callsNow() {
  const out = [];
  for (const r of store.races) {
    if (!['senate', 'gov', 'house'].includes(r.type) || !r.left || !r.right) continue;
    const res = store.live.results[r.id];
    if (!res || (res.called !== 'left' && res.called !== 'right') || !res.calledAt) continue;
    const party = res.called === 'left' ? r.leftParty : r.rightParty;
    out.push({ id: r.id, r, res, party, name: res.called === 'left' ? r.left : r.right, at: new Date(res.calledAt), flip: !!r.holder && party !== r.holder });
  }
  return out.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

// ------------------------------------------------------------------------------------------- header and stats

function drawHeader(el) {
  const sim = !!store.sim;
  const badge = sim ? ['sim', 'Simulation'] : store.live.active || resultsEnabled() ? ['live', 'Live'] : ['', 'Forecast'];
  el.replaceChildren(
    h('div', { class: 'bc-brand' }, h('span', { class: 'bc-logo', html: LOGO }), h('div', null, h('b', null, 'Ballot Desk'), h('span', null, 'Election Night 2026'))),
    h('div', { class: 'bc-mid' }, h('span', { class: `bc-badge ${badge[0]}` }, badge[0] ? h('i', { class: 'live-dot' }) : null, badge[1]), h('span', { class: 'bc-asof' })),
    h('div', { class: 'bc-right' }, h('b', { class: 'bc-clock' }), h('span', { class: 'bc-date' })));
  tickClock(el);
}

function tickClock(el) {
  const clock = el.querySelector('.bc-clock'), date = el.querySelector('.bc-date'), asof = el.querySelector('.bc-asof');
  if (!clock) return;
  if (store.sim) {
    clock.textContent = clockLabel(store.sim.t);
    date.textContent = 'Simulated night';
    asof.textContent = 'Not real results';
    return;
  }
  const now = new Date();
  clock.textContent = fmtTimeET(now);
  date.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  const left = Date.parse(CONFIG.firstPollsClose) - Date.now();
  if (left > 0 && !store.live.active) {
    const hh = Math.floor(left / 36e5), mm = Math.floor(left / 6e4) % 60, ss = Math.floor(left / 1e3) % 60;
    asof.textContent = `First polls close in ${hh ? `${hh}:${String(mm).padStart(2, '0')}` : mm}:${String(ss).padStart(2, '0')}`;
  } else {
    const at = Object.values(store.live.resultsAt || {}).sort().pop();
    asof.textContent = at ? `AP results as of ${fmtTimeET(new Date(at)).replace(' ET', '')}` : 'Waiting for results';
  }
}

function drawStats(el, o) {
  const v = houseVote();
  const all = store.races.filter(r => ['senate', 'gov', 'house'].includes(r.type) && (r.left || r.right));
  const called = all.filter(r => store.live.results[r.id]?.called).length;
  const flips = { D: 0, R: 0 };
  for (const c of callsNow()) if (c.flip && (c.party === 'D' || c.party === 'R')) flips[c.party]++;
  const next = nextClose();
  const share = (x) => `${((x / v.total) * 100).toFixed(1)}%`;
  const kpi = (label, value, sub) => h('div', { class: 'bc-kpi' }, h('span', { class: 'k' }, label), h('div', { class: 'v' }, value), h('span', { class: 's' }, sub || ''));
  const cells = [
    kpi('Votes counted', v ? num(v.total) : '0', v && v.eevp ? `House races · about ${Math.round(v.eevp)}% counted` : 'House races'),
    kpi('House popular vote', v ? [h('b', { class: 'c-dem' }, `D ${share(v.D)}`), h('b', { class: 'c-rep' }, `R ${share(v.R)}`)] : '—',
      v ? `${votesShort(v.D)} Democratic · ${votesShort(v.R)} Republican` : 'No votes counted yet'),
    kpi('Races projected', [h('b', null, called), h('small', null, ` of ${all.length}`)], 'Senate, House and governor'),
    kpi('Seats flipped', [h('b', { class: 'c-dem' }, `D +${flips.D}`), h('b', { class: 'c-rep' }, `R +${flips.R}`)], 'Projected pickups'),
    kpi('Next polls close', next ? fmtTimeET(next.d).replace(' ET', '') : 'All closed',
      next ? `${next.sts.slice(0, 7).join(' · ')}${next.sts.length > 7 ? ` +${next.sts.length - 7}` : ''}` : 'Counting continues'),
  ];
  el.replaceChildren(...(o.vertical ? cells.slice(0, 4) : cells));
}

// ------------------------------------------------------------------------------------------- scoreboard

function chamberBlock(type, o) {
  const C = CHAMBERS[type];
  const s = calledSeats(type), L = leadingSeats(type), ch = chamber(type), night = nightMode();
  const total = C.total;
  const und = Math.max(0, total - s.D - s.R - s.O - L.D - L.R - L.O);
  const seg = (n, color) => n > 0 ? h('i', { style: { width: `${(n / total) * 100}%`, background: color } }) : null;
  const mk = type !== 'gov' && !store.sim ? marketControl(type) : null;
  const side = (party, n, lead, right) => h('div', { class: `bc-side${right ? ' right' : ''}` },
    h('b', { class: party === 'D' ? 'c-dem' : 'c-rep' }, n),
    h('em', null, night && lead ? `+${lead} leading` : party === 'D' ? 'Democrats' : 'Republicans'));
  const odds = type === 'gov'
    ? h('div', { class: 'bc-odds gov' }, h('span', null, ch.live ? 'Projected final' : 'Forecast'),
      h('b', { class: 'c-dem' }, `${Math.round(ch.dSeats.mean)} D`), h('b', { class: 'c-rep' }, `${50 - Math.round(ch.dSeats.mean)} R`))
    : h('div', { class: 'bc-odds' }, h('span', null, ch.live ? 'Chance of control' : 'Forecast'),
      h('b', { class: 'c-dem' }, pct(ch.pD)),
      h('span', { class: 'bc-obar' }, h('i', { style: { width: `${ch.pD * 100}%`, background: 'var(--dem)' } }), h('i', { style: { width: `${ch.pR * 100}%`, background: 'var(--rep)', marginLeft: 'auto' } })),
      h('b', { class: 'c-rep' }, pct(ch.pR)));
  return h('div', { class: 'bc-chamber bc-card' },
    h('div', { class: 'bc-ch-head' }, h('b', null, C.name), h('span', null, `${C.need} for control${type !== 'house' ? ' · counts seats not up' : ''}`)),
    h('div', { class: 'bc-seats' }, side('D', s.D, L.D, false), h('span', { class: 'bc-tocall' }, und ? `${und} uncalled` : 'All called'), side('R', s.R, L.R, true)),
    h('div', { class: 'bc-bar' }, seg(s.D, 'var(--dem)'), seg(L.D, 'var(--dem-lean)'), seg(und, 'var(--none)'), seg(s.O + L.O, 'var(--oth)'), seg(L.R, 'var(--rep-lean)'), seg(s.R, 'var(--rep)'),
      h('b', { class: 'bc-need', style: { left: `${(C.need / total) * 100}%` } })),
    odds,
    mk && mk.pD !== null && mk.pD !== undefined && !o.vertical ? h('div', { class: 'bc-mkt' }, `Polymarket: Democrats ${pct(mk.pD)} · Republicans ${pct(mk.pR ?? 1 - mk.pD)}`) : null);
}

// ------------------------------------------------------------------------------------------- panels

function panel(kind, o, index) {
  const dots = o.panels.length > 1 ? h('span', { class: 'bc-dots' }, o.panels.map((_, i) => h('i', { class: i === index ? 'on' : '' }))) : null;
  const head = (title, note) => h('div', { class: 'bc-p-head' }, h('div', null, h('b', null, title), note ? h('span', null, note) : null), dots);
  const night = nightMode();
  if (kind === 'senate' || kind === 'gov' || kind === 'house') {
    const results = night && !o.odds;
    const fill = results ? raceFill : projectionFill;
    const map = kind === 'house' ? houseHex({ fill }) : usMap({ fill: stateFill(kind, fill), mark: stateCalled(kind), hatch: stateFill(kind, counting) });
    const races = racesOf(kind).filter(r => r.left || r.right);
    const called = races.filter(r => store.live.results[r.id]?.called).length;
    const nCounting = races.filter(counting).length;
    // 435 check marks would bury the House map: there, stripes alone mark the seats still being counted.
    const note = !night ? 'Shaded by our final forecast until results arrive'
      : !results ? 'Shaded by each race’s projected final margin'
      : kind === 'house' ? 'Shaded by the lead in the count; striped seats are still counting' : 'Projected races carry a check mark; striped ones are still counting';
    const key = marginLegend({ results: night, check: kind !== 'house', caption: night && !results ? 'projected final margin (points)' : undefined,
      extras: night ? [kind !== 'house' ? ['check', 'Projected'] : null, ['hatch', 'Still counting'], ['var(--novotes)', 'No votes yet']].filter(Boolean) : [['var(--norace)', 'No race']] });
    return h('div', { class: `bc-p bc-mapp${o.vertical ? ' stack' : ''}` }, head(PANEL_TITLE[kind], note),
      h('div', { class: 'bc-maprow' },
        h('div', { class: 'bc-mapcol' }, h('div', { class: 'bc-map' }, map),
          h('div', { class: 'bc-mapfoot' }, key,
            h('div', { class: 'bc-sum' }, h('span', null, h('b', null, called), ` of ${races.length} projected`), night ? h('span', null, h('b', null, nCounting), ' counting') : null))),
        watchList(kind, o.vertical ? 2 : 3)));
  }
  if (kind === 'races') {
    const photos = store.photos && !o.vertical ? ' · Photos: Wikipedia, credits at ballotdesk.org/credits' : '';   // vertical: in the footer
    return h('div', { class: 'bc-p' }, head('Key races', (night ? 'Share of the vote counted so far, and each race’s live chance of winning' : 'Chance of winning, before any votes are counted') + photos), keyRaces(o));
  }
  return h('div', { class: 'bc-p' }, ...latestCalls(o, head));
}

/** Beside each map: the closest races still being counted, with their numbers. */
function watchList(type, n) {
  const night = nightMode();
  const close = (r) => Math.abs((cur(r).p ?? 0.5) - 0.5);
  const open = racesOf(type).filter(r => r.left && r.right && r.p > 0.06 && r.p < 0.94 && !store.live.results[r.id]?.called)
    .sort((a, b) => close(a) - close(b)).slice(0, n);
  const rows = open.length ? open : callsNow().filter(c => c.r.type === type).slice(0, n).map(c => c.r);
  return h('div', { class: 'bc-watch' }, h('div', { class: 'bc-w-title' }, open.length ? (night ? 'Closest races' : 'Races to watch') : 'Latest calls'), rows.map(watchRow));
}

function watchRow(r) {
  const c = cur(r), res = c.result, tot = res?.total || 0, night = nightMode();
  const p = c.p ?? 0.5;
  const lp = tot ? res.left / tot : p, rp = tot ? res.right / tot : 1 - p;
  const val = (x) => tot ? `${(x * 100).toFixed(1)}%` : pct(x);
  const f = favOdds(r, p);
  const status = res?.called ? h('span', { class: 'bc-wst called' }, '✓ Projected')
    : awaiting(r) ? h('span', { class: 'bc-wst' }, `Polls close ${closeTime(r)}`)
    : tot ? h('span', { class: 'bc-wst' }, inText(c.eevp)) : h('span', { class: 'bc-wst' }, night ? 'No votes yet' : 'Forecast');
  // One line per candidate, so long names get the row's full width instead of running into each other.
  const line = (name, party, share, votes) => h('div', { class: 'bc-wline' },
    avatar(r, name, party, { size: 30, fallback: 'chip', badge: true }),
    h('span', { class: 'nm' }, lastName(name)),
    tot ? h('span', { class: 'bc-wv' }, num(votes)) : null,
    h('b', { style: { color: partyVar(party) } }, val(share)));
  const gap = tot ? Math.abs(res.left - res.right) : 0;
  const need = catchUpText(catchUp(r), { short: true });
  return h('div', { class: `bc-wrow${tot ? '' : ' pre'}` },
    h('div', { class: 'bc-wtop' }, h('b', null, r.type === 'house' ? r.short : r.stateName), status),
    line(r.left, r.leftParty, lp, res?.left), line(r.right, r.rightParty, rp, res?.right),
    h('div', { class: 'bc-wbar' }, h('i', { style: { width: `${lp * 100}%`, background: partyVar(r.leftParty) } }), h('i', { style: { width: `${rp * 100}%`, background: partyVar(r.rightParty), marginLeft: 'auto' } })),
    h('div', { class: 'bc-wfoot' },
      h('span', null, tot ? (gap ? `${lastName(res.left > res.right ? r.left : r.right)} +${num(gap)} votes` : 'Tied') : 'Chance of winning'),
      !res?.called ? h('span', { style: { color: partyVar(f.party) } }, `${f.tag} ${pct(f.q)} ${night ? 'live odds' : 'to win'}`) : null),
    need ? h('div', { class: 'bc-wneed' }, need) : null);
}

/** The closest contested races as cards: statewide first, then House toss-ups; projected ones drop to the end. */
function keyRaces(o) {
  const n = o.vertical ? 5 : 8;
  const close = (r) => Math.abs((cur(r).p ?? 0.5) - 0.5);
  const done = (r) => !!store.live.results[r.id]?.called;
  const pool = (types, lim) => store.races.filter(r => types.includes(r.type) && r.left && r.right && r.p > 0.1 && r.p < 0.9)
    .sort((a, b) => (done(a) - done(b)) || close(a) - close(b)).slice(0, lim);
  const statewide = pool(['senate', 'gov'], n);
  const list = statewide.concat(pool(['house'], n - Math.min(statewide.length, n - 2))).slice(0, n);
  return h('div', { class: 'bc-cards' }, list.map(raceCard));
}

function raceCard(r) {
  const c = cur(r), res = c.result, tot = res?.total || 0, night = nightMode();
  const p = c.p ?? 0.5;
  const line = (side) => {
    const name = side === 'left' ? r.left : r.right, party = side === 'left' ? r.leftParty : r.rightParty;
    const v = res ? (side === 'left' ? res.left : res.right) : 0;
    const share = tot ? v / tot : (side === 'left' ? p : 1 - p);
    const won = res?.called === side;
    return h('div', { class: `bc-cline${won ? ' won' : ''}` },
      avatar(r, name, party, { size: 36, fallback: 'chip', badge: true }),
      h('span', { class: 'nm' }, lastName(name), won ? h('em', null, '✓') : null),
      h('span', { class: 'bc-cbar' }, h('i', { style: { width: `${Math.min(100, share * 100)}%`, background: partyVar(party) } })),
      h('b', { style: { color: partyVar(party) } }, tot ? `${(share * 100).toFixed(1)}%` : pct(share)),
      h('span', { class: 'bc-votes' }, tot ? num(v) : ''));
  };
  const f = favOdds(r, p);
  const margin = tot ? ((res.left - res.right) / tot) * 100 : null;
  const status = res?.called ? 'Projected' : awaiting(r) ? `Polls close ${closeTime(r)}` : tot ? inText(c.eevp) : night ? 'No votes yet' : 'Forecast';
  // While it is counted: what the runner-up needs, in place of the margin (the shares above already show that).
  const need = catchUpText(catchUp(r), { short: true });
  // Before any votes the bars and numbers are each side's chance of winning, drawn fainter so they don't read as votes.
  return h('div', { class: `bc-rcard bc-card${res?.called ? ' called' : ''}${tot ? '' : ' pre'}` },
    h('div', { class: 'bc-rhead' }, h('b', null, r.type === 'house' ? r.short : r.stateName), h('span', null, r.type === 'house' ? 'House' : r.office), h('em', null, status)),
    line('left'), line('right'),
    h('div', { class: 'bc-rfoot' },
      h('span', null, need || (margin !== null ? `Margin ${marginText(margin, r)}` : night ? 'Chance of winning · no votes yet' : 'Chance of winning')),
      tot ? h('span', { class: 'bc-in' }, h('i', { style: { width: `${Math.min(100, c.eevp)}%` } })) : h('span'),
      h('span', { style: { color: partyVar(f.party) } }, res?.called || !tot ? '' : `${f.tag} ${pct(f.q)} to win`)));
}

function latestCalls(o, head) {
  const n = o.vertical ? 9 : 8;
  const calls = callsNow().filter(c => c.r.type !== 'house' || c.flip || (c.r.p > 0.1 && c.r.p < 0.9)).slice(0, n);
  if (calls.length) {
    return [head('Latest projections', store.sim ? 'Simulated decision desk' : 'Calls by the Associated Press'),
      h('div', { class: 'bc-calls' }, calls.map(c => {
        const tot = c.res.total || 0, eevp = c.res.eevp || 0;
        const lp = tot ? (c.res.left / tot) * 100 : null, rp = tot ? (c.res.right / tot) * 100 : null;
        return h('div', { class: 'bc-call' },
          h('span', { class: 'bc-t' }, fmtTimeET(c.at).replace(' ET', '')),
          h('i', { class: `party-chip ${c.party}` }, c.party),
          h('span', { class: 'bc-what' }, h('b', null, lastName(c.name)), ` wins ${c.r.title}`,
            // A call with almost nothing counted is one made as the polls closed; shares of a handful of votes mean nothing.
            h('em', null, lp !== null && eevp >= 1 ? `${lastName(c.r.left)} ${lp.toFixed(1)}% · ${lastName(c.r.right)} ${rp.toFixed(1)}% · ${Math.round(eevp)}% in` : 'Projected as polls closed')),
          c.flip ? h('span', { class: 'bc-flip', style: { background: partyVar(c.party) } }, `${c.party} pickup`) : null);
      }))];
  }
  // Before any calls: when the polls close, with the races to watch at each hour.
  const groups = {};
  for (const [st, t] of Object.entries(POLL_CLOSE_ET)) if (store.stateByCode[st]) (groups[t] ||= []).push(st);
  const now = nowMs();
  const rows = Object.values(groups).map(sts => ({ d: pollCloseDate(sts[0]), sts: sts.sort() })).sort((a, b) => a.d - b.d)
    .filter(g => g.d > now - 30 * 60000).slice(0, n);
  return [head('When polls close', 'Eastern time, with the closest statewide races'),
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
  for (const c of calls) items.push(h('span', { class: 'bc-item' }, h('i', { class: `party-chip ${c.party}` }, c.party), h('b', null, '✓'), `${lastName(c.name)} wins ${callTag(c.r)}${c.flip ? ` · ${c.party} pickup` : ''}`));
  const close = store.races.filter(r => (r.type === 'senate' || r.type === 'gov') && r.left && r.right && r.p > 0.1 && r.p < 0.9)
    .filter(counting);
  for (const r of close.slice(0, 8)) {
    const x = store.live.results[r.id];
    const need = catchUpText(catchUp(r), { short: true });
    items.push(h('span', { class: 'bc-item' }, h('b', null, callTag(r)), ` ${lastName(r.left)} ${((x.left / x.total) * 100).toFixed(1)}% · ${lastName(r.right)} ${((x.right / x.total) * 100).toFixed(1)}% · ${inText(x.eevp)}${need ? ` · ${need}` : ''}`));
  }
  const v = houseVote();
  if (v) items.push(h('span', { class: 'bc-item' }, h('b', null, 'House popular vote'), ` Democrats ${((v.D / v.total) * 100).toFixed(1)}% · Republicans ${((v.R / v.total) * 100).toFixed(1)}% · ${num(v.total)} votes`));
  for (const type of ['senate', 'house']) {
    const ch = chamber(type);
    items.push(h('span', { class: 'bc-item' }, h('b', null, CHAMBERS[type].name), ` ${ch.live ? 'live chance of control' : 'forecast'}: Democrats ${pct(ch.pD)} · Republicans ${pct(ch.pR)}`));
  }
  if (!nightMode()) items.push(h('span', { class: 'bc-item' }, 'The first polls close at 6 p.m. Eastern; results arrive here as they are counted'));
  items.push(h('span', { class: 'bc-item' }, h('b', null, 'ballotdesk.org'), ' · forecasts, maps and live results for every race'));
  return items;
}

/** A crawl that never jumps: positions come from elapsed time, and new items swap in as one copy scrolls off. */
function ticker() {
  const track = h('div', { class: 'bc-track' });
  const view = h('div', { class: 'bc-tick-view' }, track);
  const el = h('div', { class: 'bc-ticker' }, h('div', { class: 'bc-tick-label' }, h('i', { class: 'live-dot' }), 'Latest'), view);
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
      body = [h('div', { class: 'bc-a-label' }, h('span', { class: 'bc-a-check' }, '✓'), 'Projection'),
        h('div', { class: 'bc-a-big' }, `${party === 'D' ? 'Democrats win' : 'Republicans keep'} control of the ${CHAMBERS[item.type].name}`)];
    } else if (item.kind === 'batch') {
      body = [h('div', { class: 'bc-a-label' }, h('span', { class: 'bc-a-check' }, '✓'), 'Projected as polls close'),
        h('div', { class: 'bc-a-list' }, item.calls.slice(0, 8).map(c => h('span', null, h('i', { class: `party-chip ${c.party}` }, c.party), callTag(c.r))),
          item.calls.length > 8 ? h('span', null, `+${item.calls.length - 8} more`) : null)];
    } else {
      const c = item.call, tot = c.res.total || 0, eevp = c.res.eevp || 0;
      const pic = photoOf(c.r, c.name);
      body = [h('div', { class: 'bc-a-label' }, h('span', { class: 'bc-a-check' }, '✓'), 'Projected winner', c.flip ? h('span', { class: 'bc-flip' }, `${c.party} pickup`) : null),
        h('div', { class: 'bc-a-big' }, c.name, h('i', { class: `party-chip ${c.party}` }, c.party)),
        h('div', { class: 'bc-a-race' }, `${c.r.title}`,
          tot && eevp >= 1 ? ` · ${((c.res.left / tot) * 100).toFixed(1)}% to ${((c.res.right / tot) * 100).toFixed(1)}%, ${Math.round(eevp)}% in` : ' · as polls closed',
          store.sim ? ' · simulated' : ' · AP projection')];
      if (pic) {
        body = [h('div', { class: 'bc-a-row' }, avatar(c.r, c.name, c.party, { size: 104 }), h('div', { class: 'bc-a-text' }, body)),
          h('div', { class: 'bc-a-credit' }, `Photo: ${pic.by}, ${licenseText(pic)}, via Wikipedia`)];
      }
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
