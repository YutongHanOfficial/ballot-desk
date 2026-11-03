import { h, pct, num, timeAgo, probColor, partyVar, lastName, esc, fmtDate } from '../ui.js';
import { store, cur, chamber, racesOf, raceFill, projected } from '../store.js';
import { usMap, currentLegendEl, historyChart, raceTip } from '../charts.js';
import { houseMap } from '../maps.js';
import { chamberCard, raceCard, headline, electionBanner, CHAMBERS, supportNote } from './common.js';
import { navigate } from '../nav.js';

export function competitive(type, n) {
  return racesOf(type).filter(r => r.left && r.right && cur(r).p !== null)
    .sort((a, b) => Math.abs(cur(a).p - 0.5) - Math.abs(cur(b).p - 0.5)).slice(0, n);
}

export function stateFill(type, fill = raceFill) {
  return (code) => {
    const r = store.races.find(x => x.type === type && x.state === code && (type !== 'senate' || !x.special)) ||
      store.races.find(x => x.type === type && x.state === code);
    return r ? fill(r) : null;
  };
}

/** On election night, whether a state's race (the regular one, if there are two) has been projected. */
export function stateCalled(type) {
  return (code) => projected(store.races.find(x => x.type === type && x.state === code && (type !== 'senate' || !x.special)) ||
    store.races.find(x => x.type === type && x.state === code));
}

export function stateTip(type) {
  return (code) => {
    const rs = store.races.filter(x => x.type === type && x.state === code);
    if (!rs.length) return `<div class="tt-title">${esc(store.stateByCode[code]?.name)}</div><div class="muted">No ${type === 'gov' ? 'governor' : 'Senate'} race in 2026</div>`;
    return rs.map(raceTip).join('<div style="height:8px"></div>');
  };
}

export function render(root) {
  const f = store.forecast;
  const env = f.env || {};
  const nPolls = Object.values(store.polls.races || {}).reduce((s, r) => s + (r.polls?.length || 0), 0);
  const nRated = new Set(store.races.flatMap(r => Object.keys(r.ratings || {}))).size;

  root.append(
    electionBanner() || '',
    h('header', { class: 'page-head' },
      h('div', { class: 'eyebrow' }, h('span', null, '2026 Midterm Forecast'), h('span', null, '·'), h('span', null, `Updated ${timeAgo(f.updated)}`)),
      h('h1', null, headline()),
      h('p', { class: 'dek' }, `We combine ${num(nPolls)} polls, the ratings of ${nRated} forecasters, Polymarket prices and each race's partisan lean, then simulate the election ${num(f.sims)} times. On election night, counted votes take over from the forecast.`)),
    h('div', { class: 'grid g3' }, chamberCard('senate'), chamberCard('house'), chamberCard('gov')),
    h('a', { class: 'card sim-cta', href: '/simulate' },
      h('span', { class: 'sim-cta-icon' }, '🎲'),
      h('span', { class: 'grow' }, h('b', null, 'Run the election yourself. '), h('span', { class: 'muted' }, 'Simulate one outcome in a click, or replay a whole election night as polls close and races get called.')),
      h('span', { class: 'btn small primary' }, 'Open the simulator →')),
  );

  // Over time + national environment
  // Model runs plus Polymarket's daily price history for the control markets, merged by timestamp.
  const mkt = store.history.market || {};
  const byT = new Map();
  for (const p of store.history.points || []) byT.set(p.t, { ...p });
  for (const [key, arr] of [['mSen', mkt.senate], ['mHouse', mkt.house]]) {
    for (const [t, v] of arr || []) { const o = byT.get(t) || { t }; o[key] = v; byT.set(t, o); }
  }
  // Before the model went live: the same model re-run on each day's inputs (data/backcast.json), drawn dashed
  // and joined to the live line at its first run.
  const firstModel = (store.history.points || []).find(p => p.sen !== undefined && p.sen !== null);
  const back = firstModel ? (store.backcast?.points || []).filter(p => p.t < firstModel.t) : [];
  // Each re-run day joins the nearest Polymarket reading (within 6 hours), so hovering shows both side by side.
  const stamps = [...byT.keys()].map(t => [Date.parse(t), t]).sort((a, b) => a[0] - b[0]);
  for (const p of back) {
    const ms = Date.parse(p.t);
    const near = stamps.reduce((best, s) => Math.abs(s[0] - ms) < Math.abs(best[0] - ms) ? s : best, [Infinity, null]);
    const key = near[1] && Math.abs(near[0] - ms) <= 6 * 3600e3 ? near[1] : p.t;
    const o = byT.get(key) || { t: key };
    Object.assign(o, { bSen: p.sen, bHouse: p.house });
    byT.set(key, o);
  }
  if (back.length) Object.assign(byT.get(firstModel.t), { bSen: firstModel.sen, bHouse: firstModel.house });
  const hist = [...byT.values()].sort((a, b) => a.t.localeCompare(b.t));
  const histCard = h('div', { class: 'card span2' },
    h('div', { class: 'card-title' }, 'Chance of Democratic control over time'),
    historyChart(hist, [
      { key: 'mSen', label: 'Senate (Polymarket)', color: 'var(--dem)', width: 1.5, opacity: back.length ? 0.55 : null },
      { key: 'mHouse', label: 'House (Polymarket)', color: 'var(--ink-2)', width: 1.5, opacity: back.length ? 0.55 : null },
      { key: 'bSen', label: 'Senate (our model, re-run)', color: 'var(--dem)', width: 2.5, dash: '5 4' },
      { key: 'bHouse', label: 'House (our model, re-run)', color: 'var(--ink-2)', width: 2.5, dash: '5 4' },
      { key: 'sen', label: 'Senate (our forecast)', color: 'var(--dem)', width: 3, marker: true },
      { key: 'house', label: 'House (our forecast)', color: 'var(--ink-2)', width: 3, marker: true },
    ]),
    h('div', { class: 'legend' },
      h('span', null, h('i', { style: { background: 'var(--dem)' } }), 'Senate'),
      h('span', null, h('i', { style: { background: 'var(--ink-2)' } }), 'House'),
      h('span', null, h('i', { class: 'lg-line' }), 'Polymarket, daily'),
      h('span', null, h('i', { class: 'lg-dot' }), 'Our forecast'),
      back.length ? h('span', null, h('i', { class: 'lg-dash' }), 'Our model, re-run on earlier days') : null),
    firstModel ? h('p', { class: 'xs muted', style: { margin: '6px 0 0' } }, back.length
      ? [`Before ${fmtDate(firstModel.t)}, when our forecast went live, the dashed line is the same model re-run for each day on the polls, forecaster ratings, generic ballot and Polymarket prices published by then (with this fall’s nominees throughout). `, h('a', { href: '/methodology#backcast' }, 'How it was rebuilt')]
      : `Our forecast’s own history starts ${fmtDate(firstModel.t)}, so its line is short; the dots mark where it stands now.`) : null);

  const gb = env.generic;
  const ap = env.approval;
  const pv = store.markets.brackets?.popularVote;
  const pvTop = pv ? pv.outcomes.filter(o => !/^other$/i.test(o.label)).sort((a, b) => b.p - a.p)[0] : null;
  const envCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, 'National environment'),
    h('div', { class: 'kv' },
      h('dt', null, 'Generic ballot'), h('dd', null, gb === undefined ? '—' : h('span', { class: gb >= 0 ? 'c-dem' : 'c-rep', style: { fontWeight: 750 } }, `${gb >= 0 ? 'D' : 'R'}+${Math.abs(gb).toFixed(1)}`), h('span', { class: 'muted small' }, env.genericSource ? ` · ${env.genericSource}` : '')),
      h('dt', null, 'Trump approval'), h('dd', null, ap ? `${ap.approve.toFixed(1)}% approve · ${ap.disapprove.toFixed(1)}% disapprove` : '—'),
      h('dt', null, 'Net approval'), h('dd', null, ap ? h('span', { class: ap.net >= 0 ? 'c-rep' : 'c-dem', style: { fontWeight: 700 } }, `${ap.net >= 0 ? '+' : '−'}${Math.abs(ap.net).toFixed(1)}`) : '—'),
      pvTop ? [h('dt', null, 'House vote (market)'), h('dd', null, `${pvTop.label} most likely (${pct(pvTop.p)})`)] : null,
      h('dt', null, 'Senate seats (D)'), h('dd', null, `${chamber('senate').dSeats.p10}–${chamber('senate').dSeats.p90} (80% range)`),
      h('dt', null, 'House seats (D)'), h('dd', null, `${chamber('house').dSeats.p10}–${chamber('house').dSeats.p90} (80% range)`)),
    h('p', { class: 'xs muted', style: { marginTop: '12px', marginBottom: 0 } }, 'Generic ballot and approval: averages of the trackers listed on Wikipedia (DDHQ, FiftyPlusOne, RealClearPolitics, Silver Bulletin and others).'));
  root.append(h('section', { class: 'section grid g3' }, histCard, envCard));

  // Races to watch
  const groups = [
    ['Senate', competitive('senate', 8), '/senate'],
    ['Governor', competitive('gov', 6), '/governors'],
    ['House', competitive('house', 9), '/house'],
  ];
  const watch = h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'Races to watch'), h('p', null, 'The closest contests in our forecast, live when counting begins.'))));
  for (const [label, list, url] of groups) {
    watch.append(h('div', { class: 'section-head', style: { marginTop: '18px', marginBottom: '10px' } }, h('h3', null, label), h('a', { class: 'small', href: url }, `All ${label.toLowerCase()} races →`)),
      h('div', { class: 'race-cards' }, list.map(r => raceCard(r, { showType: false }))));
  }
  root.append(watch);

  // Maps
  const go = (type) => (code) => {
    const r = store.races.find(x => x.type === type && x.state === code);
    if (r) navigate(r.url);
  };
  root.append(h('section', { class: 'section card' },
    h('div', { class: 'card-title' }, 'House forecast, district by district', h('a', { class: 'more', href: '/house' }, 'Details →')),
    houseMap({ id: 'home' })));
  root.append(h('section', { class: 'section grid g2' },
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Senate forecast', h('a', { class: 'more', href: '/senate' }, 'Details →')),
      usMap({ fill: stateFill('senate'), onClick: go('senate'), tip: stateTip('senate'), mark: stateCalled('senate') }), currentLegendEl()),
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Governor forecast', h('a', { class: 'more', href: '/governors' }, 'Details →')),
      usMap({ fill: stateFill('gov'), onClick: go('gov'), tip: stateTip('gov'), mark: stateCalled('gov') }), currentLegendEl())));

  // Tipping point
  const tip = Object.entries(chamber('senate').tipping || store.forecast.control.senate.tipping || {}).slice(0, 8);
  if (tip.length) {
    const maxv = tip[0][1];
    root.append(h('section', { class: 'section grid g2' },
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Senate tipping-point races'),
        h('p', { class: 'small muted', style: { marginTop: 0 } }, 'How often each race delivers the deciding 51st (or Republicans’ 50th) seat in our simulations.'),
        tip.map(([id, v]) => {
          const r = store.byId[id];
          if (!r) return null;
          return h('a', { href: r.url, style: { display: 'grid', gridTemplateColumns: '120px 1fr 48px', gap: '10px', alignItems: 'center', padding: '6px 0', textDecoration: 'none' } },
            h('span', { style: { fontWeight: 650 } }, r.stateName),
            h('span', { style: { height: '10px', borderRadius: '99px', background: 'var(--surface-2)', position: 'relative', overflow: 'hidden' } },
              h('i', { style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(v / maxv) * 100}%`, background: probColor(cur(r).p, r.leftParty, r.rightParty) } })),
            h('span', { class: 'tnum small', style: { textAlign: 'right' } }, pct(v)));
        })),
      flipsCard()));
  }

  // States
  root.append(h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'Every state'), h('p', null, 'Senate, House, governor, down-ballot races, legislatures and ballot measures.'))),
    stateGrid()));
  const note = supportNote('If you find it useful, chip in to keep it running.');
  if (note) root.append(note);
}

function flipsCard() {
  const fl = store.forecast.flips || {};
  const rows = [['Senate', fl.senate], ['House', fl.house], ['Governors', fl.gov]];
  const pickups = (type) => racesOf(type).filter(r => r.holder && r.left && r.right && (() => { const p = cur(r).p; const fav = p >= 0.5 ? r.leftParty : r.rightParty; return fav !== r.holder; })());
  return h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Seats likely to change hands'),
    h('div', { class: 'kv' }, rows.map(([l, v]) => v ? [h('dt', null, l), h('dd', null, `${v.median} flips expected `, h('span', { class: 'muted small' }, `(80%: ${v.p10}–${v.p90})`))] : null)),
    h('div', { class: 'divider' }),
    h('div', { class: 'small muted', style: { marginBottom: '6px' } }, 'Projected pickups (favorite differs from the party holding the seat)'),
    h('div', { class: 'chips' }, ['senate', 'gov', 'house'].flatMap(t => pickups(t)).sort((a, b) => Math.abs(cur(b).p - 0.5) - Math.abs(cur(a).p - 0.5)).slice(0, 40)
      .map(r => { const p = cur(r).p; const fav = p >= 0.5 ? r.leftParty : r.rightParty; return h('a', { href: r.url, style: { color: partyVar(fav) } }, r.type === 'house' ? r.short : r.short); })));
}

export function stateGrid() {
  return h('div', { class: 'state-list' }, store.states.map(st => {
    const rs = store.byState[st.code] || [];
    const top = rs.filter(r => r.type === 'senate' || r.type === 'gov');
    return h('a', { class: 'state-link', href: `/state/${st.code}` }, h('span', null, st.name),
      h('span', { class: 'badges' }, top.map(r => h('i', { title: r.title, style: { background: probColor(cur(r).p ?? (r.left ? 1 : 0), r.leftParty, r.rightParty) } }))));
  }));
}

export const title = () => 'Forecast & live results';
void lastName; void CHAMBERS;
