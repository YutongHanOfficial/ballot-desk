// Election-night dashboard.
import { h, pct, partyVar, timeAgo, fmtTimeET, lastName, marginText } from '../ui.js';
import { store, cur, chamber, marketControl, racesOf, nightMode, awaiting } from '../store.js';
import { calledSeats, resultsEnabled, wantCounties } from '../live.js';
import { CONFIG, POLL_CLOSE_ET, pollCloseDate } from '../config.js';
import { raceCard, CHAMBERS } from './common.js';
import { eventsSoFar, clockLabel } from '../sim.js';
import { competitive, stateFill, stateTip } from './home.js';
import { usMap, mapLegend, currentLegend } from '../charts.js';
import { houseMap, countyMap } from '../maps.js';

function calledBar(type) {
  const C = CHAMBERS[type];
  const s = calledSeats(type);
  const total = C.total;
  const und = Math.max(0, total - s.D - s.R - s.O);
  const ch = chamber(type);
  const mk = type !== 'gov' ? marketControl(type) : null;
  const need = C.need;
  const bar = h('div', { style: { position: 'relative', marginTop: '22px' } },
    h('div', { class: 'split-bar', style: { height: '26px', borderRadius: '6px' } },
      h('span', { style: { width: `${(s.D / total) * 100}%`, background: 'var(--dem)' } }),
      h('span', { style: { width: `${(und / total) * 100}%`, background: 'var(--none)' } }),
      s.O ? h('span', { style: { width: `${(s.O / total) * 100}%`, background: 'var(--oth)' } }) : null,
      h('span', { style: { width: `${(s.R / total) * 100}%`, background: 'var(--rep)' } })),
    h('div', { class: 'strip-mark', style: { left: `calc(${(need / total) * 100}% - 1px)`, top: '-18px', bottom: '-4px' } }, h('span', null, `${need} to win`)));
  return h('div', { class: 'card' },
    h('div', { class: 'chamber-top' }, h('div', { class: 'chamber-name' }, C.name),
      ch.live ? h('span', { class: 'pill live' }, h('span', { class: 'live-dot' }), 'Live model') : h('span', { class: 'pill' }, 'Pre-election forecast')),
    h('div', { class: 'odds-row', style: { marginTop: '10px' } },
      h('div', { class: 'odds dem' }, h('span', { class: 'pct' }, s.D), h('span', { class: 'who c-dem' }, 'Democrats (called + not up)')),
      h('div', { class: 'odds rep right' }, h('span', { class: 'pct' }, s.R), h('span', { class: 'who c-rep' }, 'Republicans'))),
    bar,
    h('div', { class: 'compare-line', style: { marginTop: '12px' } },
      type === 'gov'
        ? h('span', null, 'Projected: ', h('b', null, `${Math.round(ch.dSeats.mean)} D · ${50 - Math.round(ch.dSeats.mean)} R`))
        : h('span', null, 'Chance of control: ', h('b', { class: 'c-dem' }, `D ${pct(ch.pD)}`), ' · ', h('b', { class: 'c-rep' }, `R ${pct(ch.pR)}`)),
      mk && mk.pD !== null && !store.sim ? h('span', null, 'Polymarket: ', h('b', null, `D ${pct(mk.pD)}`)) : h('span', null, `${und} uncalled`)));
}

function timeline() {
  const groups = {};
  for (const [st, t] of Object.entries(POLL_CLOSE_ET)) (groups[t] ||= []).push(st);
  const order = Object.keys(groups).sort((a, b) => pollCloseDate(groups[a][0]) - pollCloseDate(groups[b][0]));
  return h('div', { class: 'timeline' }, order.map(t => {
    const d = pollCloseDate(groups[t][0]);
    const past = Date.now() >= d;
    const states = groups[t].filter(s => store.stateByCode[s]).sort();
    const key = states.flatMap(s => (store.byState[s] || []).filter(r => (r.type === 'senate' || r.type === 'gov') && r.left && r.right && Math.abs((cur(r).p ?? 0.5) - 0.5) < 0.35));
    return h('div', { class: `tl-row${past ? ' past' : ''}` },
      h('div', { class: 't' }, fmtTimeET(d).replace(' ET', '')),
      h('div', null,
        h('div', { class: 'chips' }, states.map(s => h('a', { href: `#/state/${s}` }, s))),
        key.length ? h('div', { class: 'xs muted', style: { marginTop: '5px' } }, 'Watch: ', key.map((r, i) => [i ? ', ' : '', h('a', { href: r.url }, `${r.stateName} ${r.office.toLowerCase()}`)])) : null));
  }));
}

const HERO = { tab: 'senate' };

/** The big map at the top: Senate, governors or House, coloured by results as they come in. */
function heroMap() {
  const tabs = [['senate', 'Senate'], ['gov', 'Governors'], ['house', 'House']];
  const seg = h('div', { class: 'seg' });
  const body = h('div');
  const summary = h('div', { class: 'compare-line', style: { marginTop: '10px' } });
  const draw = () => {
    seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', tabs[i][0] === HERO.tab));
    const type = HERO.tab;
    if (type === 'house') body.replaceChildren(houseMap({ id: 'live-house', caption: false }));
    else {
      const go = (code) => { const r = store.races.find(x => x.type === type && x.state === code); if (r) location.hash = r.url; };
      body.replaceChildren(usMap({ fill: stateFill(type), tip: stateTip(type), onClick: go }), mapLegend(currentLegend()));
    }
    const races = racesOf(type).filter(r => r.left || r.right);
    const called = races.filter(r => store.live.results[r.id]?.called).length;
    const counting = races.filter(r => { const x = store.live.results[r.id]; return x && x.total > 0 && !x.called; }).length;
    const waiting = races.filter(r => awaiting(r)).length;
    summary.replaceChildren(
      h('span', null, h('b', null, called), ` of ${races.length} races projected`),
      nightMode() ? h('span', null, h('b', null, counting), ' counting · ', h('b', null, waiting), ' polls still open') : h('span', null, 'Colored by our forecast until results arrive'));
  };
  tabs.forEach(([k, label]) => seg.appendChild(h('button', { type: 'button', onclick: () => { HERO.tab = k; draw(); } }, label)));
  draw();
  return h('section', { class: 'section card hero-map' },
    h('div', { class: 'map-toolbar' }, seg, h('span', { class: 'xs muted' }, nightMode() ? 'Solid = projected winner · light = leading' : 'Forecast view')),
    body, summary);
}

/** Small-multiple county maps of the most competitive statewide races. */
function battlegrounds() {
  const list = store.races.filter(r => (r.type === 'senate' || r.type === 'gov') && r.left && r.right && r.state !== 'AK' && r.p !== null)
    .sort((a, b) => Math.abs(a.p - 0.5) - Math.abs(b.p - 0.5)).slice(0, 8);
  if (nightMode() && !store.sim) wantCounties(list.map(r => r.id));
  const card = (r) => {
    const c = cur(r);
    const res = c.result;
    const counting = res && (res.total > 0 || res.called);
    const tot = res?.total || 0;
    const line = (side) => {
      const name = side === 'left' ? r.left : r.right, party = side === 'left' ? r.leftParty : r.rightParty;
      const val = counting ? (tot ? `${((side === 'left' ? res.left : res.right) / tot * 100).toFixed(1)}%` : '—') : pct(side === 'left' ? c.p : 1 - c.p);
      const won = res?.called === side;
      return h('div', { class: 'bg-cand' }, h('span', { class: `party-chip ${party}` }, party), h('span', { class: 'nm' }, lastName(name), won ? h('span', { class: 'winner-check', style: { marginLeft: '5px' } }, '✓') : null), h('b', { style: { color: partyVar(party) } }, val));
    };
    const status = res?.called ? h('span', { class: 'pill called' }, 'Projected')
      : awaiting(r) ? h('span', { class: 'pill' }, `Polls close ${fmtTimeET(pollCloseDate(r.state)).replace(' ET', '')}`)
      : counting ? h('span', { class: 'pill live' }, `${Math.round(c.eevp)}% counted`) : h('span', { class: 'pill' }, nightMode() ? 'Awaiting votes' : `${r.office}`);
    return h('a', { class: 'bg-card', href: r.url },
      h('div', { class: 'bg-head' }, h('b', null, `${r.stateName} ${r.office === 'Governor' ? 'Gov.' : 'Sen.'}${r.special ? ' (S)' : ''}`), status),
      h('div', { class: 'bg-cands' }, line('left'), line('right')),
      countyMap(r.state, { raceId: r.id, width: 380, maxHeight: 250, compact: true }));
  };
  return h('div', { class: 'card span2' },
    h('div', { class: 'card-title' }, 'Battlegrounds, county by county', h('span', { class: 'muted', style: { textTransform: 'none', letterSpacing: 0 } }, nightMode() ? 'Shaded by leader and margin' : 'Shaded by the 2024 vote until counting starts')),
    h('div', { class: 'bg-grid' }, list.map(card)));
}

export function render(root) {
  const enabled = resultsEnabled();
  const live = store.live;
  const last = Object.values(live.resultsAt || {}).sort().pop();
  root.append(h('header', { class: 'page-head' },
    h('div', { class: 'eyebrow' }, live.active ? h('span', { class: 'live-dot' }) : null, 'Election night', h('span', null, '·'),
      live.demo ? 'Simulated results' : last ? `Results updated ${timeAgo(last)}` : 'Waiting for results'),
    h('h1', null, live.active ? 'Live results and projections' : 'Election night: live results'),
    h('p', { class: 'dek' }, live.demo
      ? 'Simulated returns generated from the forecast, replaying an election night so you can see how this page behaves. None of these numbers are real.'
      : live.active
      ? 'Vote counts from the Associated Press (via The New York Times), with our projection of each race updating as ballots are counted. Calls are the AP’s.'
      : enabled
        ? 'Polls are closing. Counts will appear here automatically; this page refreshes itself.'
        : `Results start flowing after the first polls close at 6 p.m. Eastern on Tuesday, Nov. 3. Leave this page open: it updates on its own. Want a preview? `, live.active ? null : h('a', { href: '#/simulate' }, 'Simulate election night'), live.active ? null : '.')));

  if (store.sim && !live.active) {
    root.append(h('div', { class: 'banner live' }, h('span', { class: 'live-dot' }), h('div', { class: 'grow' }, h('b', null, `${clockLabel(store.sim.t)}. `), 'Polls are about to close. The first results arrive shortly after 6 p.m.')));
  }
  if (live.resultsOk === false && enabled && !live.demo) {
    root.append(h('div', { class: 'banner' }, h('div', { class: 'grow' }, h('b', null, 'The results feed is not reachable right now. '), 'Showing the pre-election forecast and live Polymarket prices; counts will appear when the feed responds.')));
  }

  root.append(h('div', { class: 'grid g3' }, calledBar('senate'), calledBar('house'), calledBar('gov')));
  root.append(heroMap());
  const feed = eventFeed();
  root.append(h('section', { class: 'section grid g3 bg-row' }, battlegrounds(),
    feed || h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Election night, as it happens'), h('p', { class: 'muted small', style: { margin: 0 } }, 'Poll closings and projections will appear here through the night.'))));

  if (live.active && live.swing && live.swing.n >= 3) {
    const sw = live.swing.swing;
    root.append(h('div', { class: 'notice' }, `In the ${live.swing.n} races that are mostly counted, the left-side candidate is running `,
      h('b', null, `${Math.abs(sw).toFixed(1)} points ${sw >= 0 ? 'ahead of' : 'behind'}`), ' our pre-election forecast. The live model shifts uncounted races by that amount.'));
  }

  const counting = racesOf('senate').concat(racesOf('gov'), racesOf('house')).filter(r => { const res = live.results[r.id]; return res && (res.total > 0 || res.called); });
  if (live.active) {
    const close = counting.filter(r => !live.results[r.id].called && r.left && r.right)
      .sort((a, b) => Math.abs(cur(a).p - 0.5) - Math.abs(cur(b).p - 0.5)).slice(0, 12);
    const flips = counting.filter(r => { const res = live.results[r.id]; if (!res.called || !r.holder) return false; const party = res.called === 'left' ? r.leftParty : res.called === 'right' ? r.rightParty : 'O'; return party !== r.holder; });
    root.append(h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'Too close to call'), h('p', null, 'Uncalled races, closest first. Percentages are the share of the vote counted so far.'))),
      close.length ? h('div', { class: 'race-cards' }, close.map(r => raceCard(r))) : h('div', { class: 'card empty' }, 'No uncalled races with votes yet.')));
    if (flips.length) root.append(h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, `Seats that flipped (${flips.length})`)),
      h('div', { class: 'chips' }, flips.map(r => { const res = live.results[r.id]; const party = res.called === 'left' ? r.leftParty : r.rightParty; return h('a', { href: r.url, style: { color: partyVar(party) } }, `${r.short} → ${party}`); }))));
  } else {
    root.append(h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'House races to watch'), h('p', null, 'These switch to live counts as soon as votes are reported.'))),
      h('div', { class: 'race-cards' }, competitive('house', 6).map(r => raceCard(r)))));
  }

  root.append(h('section', { class: 'section grid g2' },
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'When polls close (Eastern time)'), timeline()),
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'How to read election night'),
      h('div', { class: 'prose', style: { fontSize: '14px' } },
        h('p', null, h('b', null, 'Maps'), ' turn light when a candidate leads and solid when a race is projected. Counties are shaded by who leads them and by how much.'),
        h('p', null, h('b', null, 'Expected vote counted'), ' is the AP’s estimate of the share of all ballots that have been tallied. Early returns can lean heavily toward one party depending on whether mail, early or Election Day votes are counted first.'),
        h('p', null, h('b', null, 'Our live projection'), ' blends the counted vote with the pre-election forecast in proportion to how much is left, and nudges uncounted races by how far results are running from expectations elsewhere.'),
        h('p', null, h('b', null, 'Calls'), ' come from the Associated Press. Close races, ranked-choice tabulation in Alaska and Maine, and Georgia’s 50% runoff rule can delay outcomes for days.'),
        h('p', { class: 'muted', style: { marginBottom: 0 } }, `Results refresh every ${CONFIG.results.refreshSec.senate} seconds (House every ${Math.round(CONFIG.results.refreshSec.house / 60)} minutes); markets every minute.`)))));
  void marginText;
}

const FEED = { all: false };

/** Election-night ticker: poll closings, projections and chamber calls, newest first. */
function eventFeed() {
  let items;
  if (store.sim) {
    items = eventsSoFar().map(e => ({ ...e, when: clockLabel(e.t, { short: true }) }));
  } else if (store.live.active) {
    const now = Date.now();
    const closes = {};
    for (const [st, t] of Object.entries(POLL_CLOSE_ET)) if (store.stateByCode[st]) (closes[t] ||= []).push(st);
    items = Object.values(closes).map(sts => ({ d: pollCloseDate(sts[0]), kind: 'close', text: `Polls close in ${sts.map(s => store.stateByCode[s].name).sort().join(', ')}.` }))
      .filter(e => e.d <= now);
    for (const r of store.races) {
      const res = store.live.results[r.id];
      if (!res || !res.called || !res.calledAt || !r.left || !r.right) continue;
      const party = res.called === 'left' ? r.leftParty : r.rightParty;
      const name = res.called === 'left' ? r.left : r.right;
      items.push({ d: new Date(res.calledAt), kind: 'call', party, id: r.id, text: `AP: ${name} (${party}) wins ${r.title}${r.holder && party !== r.holder ? ', a pickup' : ''}.` });
    }
    items.sort((a, b) => b.d - a.d);
    items = items.map(e => ({ ...e, when: fmtTimeET(e.d).replace(' ET', '') }));
  } else return null;
  if (!items.length) return null;
  const shown = FEED.all ? items : items.slice(0, 12);
  const icon = (k, party) => {
    const sym = { close: '◷', call: '✓', batch: '✓', control: '★', info: 'ℹ', final: '■' }[k] || '•';
    return h('span', { class: `feed-icon ${k}`, style: party ? { background: partyVar(party), color: '#fff' } : null }, sym);
  };
  return h('section', { class: 'card feed' },
    h('div', { class: 'card-title' }, store.sim ? 'Election night, as it happens (simulated)' : 'Election night, as it happens',
      items.length > 12 ? h('button', { type: 'button', class: 'linkish', onclick: () => { FEED.all = !FEED.all; const p = document.querySelector('.feed'); if (p) p.replaceWith(eventFeed()); } }, FEED.all ? 'Show fewer' : `Show all ${items.length}`) : null),
    h('ol', { class: 'feed-list' }, shown.map(e => h('li', { class: `feed-item ${e.kind}${e.big || e.kind === 'control' ? ' big' : ''}` },
      h('span', { class: 'feed-time' }, e.when), icon(e.kind, e.party),
      h('span', { class: 'feed-text' }, e.id ? h('a', { href: store.byId[e.id]?.url }, e.text) : e.text)))));
}

export const title = () => 'Live results';
