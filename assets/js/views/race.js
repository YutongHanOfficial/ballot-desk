// Individual race page.
import { h, pct, num, partyChip, partyVar, ratingChip, marginText, lastName, fmtDate, oddsText, compact, timeAgo, PARTY_NAME, bandLabel } from '../ui.js';
import { store, cur, duelNow } from '../store.js';
import { splitBar, pollChart, marginCurve, signalRows } from '../charts.js';
import { stateDistrictMap, countyMap, countyResults, COUNTY_LEGEND } from '../maps.js';
import { mapLegend } from '../charts.js';
import { nightMode } from '../store.js';
import { wantCounties } from '../live.js';
import { electionBanner, pollCloseText, raceCard } from './common.js';

function winsText(name, q) {
  if (q >= 0.995) return `${name} wins virtually every simulation`;
  if (q < 0.55) return 'It is close to a coin flip';
  return `${name} wins ${oddsText(q)} simulations`;
}

function initials(name) {
  const parts = String(name || '?').replace(/\b(Jr\.?|Sr\.?|III|II|IV)\b/g, '').trim().split(/\s+/);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function candBlock(r, side, p, live) {
  const name = side === 'left' ? r.left : r.right;
  const party = side === 'left' ? r.leftParty : r.rightParty;
  const c = side === 'left' ? r.leftCand : r.rightCand;
  return h('div', { class: `cand ${side}` },
    h('div', { class: 'avatar', style: { background: partyVar(party) } }, initials(name)),
    h('div', { class: 'cname' }, name || '—'),
    h('div', { class: 'cmeta' }, `${PARTY_NAME[party] || c?.partyName || 'Other'}${c?.incumbent ? ' · Incumbent' : ''}`),
    h('div', { class: 'cprob', style: { color: partyVar(party) } }, pct(side === 'left' ? p : 1 - p)),
    h('div', { class: 'xs muted' }, live ? 'live chance of winning' : 'chance of winning'));
}

export function render(root, id) {
  const r = store.byId[id];
  if (!r) { root.append(h('div', { class: 'empty' }, 'Race not found. ', h('a', { href: '/' }, 'Back to the overview'))); return; }
  const c = cur(r);
  const inc = r.incumbent;
  const statusLine = r.type === 'house' && !inc
    ? (r.vacant ? `Vacant seat (previously ${PARTY_NAME[r.holder] || ''}). ${r.status || ''}` : 'Newly drawn district with no incumbent.')
    : inc ? `${inc.name} (${inc.party || '?'}) · ${r.status || ''}` : r.status || '';

  root.append(electionBanner() || '',
    h('div', { class: 'eyebrow' }, h('a', { href: '/states' }, 'States'), h('span', null, '›'), h('a', { href: `/state/${r.state}` }, r.stateName), h('span', null, '›'), h('span', null, r.office)),
    h('header', { class: 'page-head' }, h('h1', null, r.title), h('p', { class: 'dek' }, statusLine)));

  // Live results first on election night
  if (c.result && (c.result.total > 0 || c.result.called)) root.append(resultsCard(r, c));

  if (r.duel) {
    root.append(duelHero(r));
    root.append(h('section', { class: 'section grid g2' }, marketCard(r, c), context(r)));
    return;
  }

  if (!r.left || !r.right) {
    const w = r.left ? r.leftCand : r.rightCand;
    root.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Forecast'),
      h('p', { style: { fontSize: '17px', margin: 0 } }, r.samePartyGeneral
        ? `Two ${PARTY_NAME[r.samePartyGeneral]}s advanced to the general election, so the seat will stay ${PARTY_NAME[r.samePartyGeneral]}.`
        : `${w?.name || 'The nominee'} (${w?.party}) has no major-party opponent and is all but certain to win.`),
      candidateList(r)));
    root.append(context(r));
    return;
  }

  const p = c.called ? (c.called === 'left' ? 1 : 0) : Math.min(0.999, Math.max(0.001, c.p ?? 0.5));
  const fav = p >= 0.5 ? 'left' : 'right';
  const favName = fav === 'left' ? r.left : r.right;
  const hero = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, c.live ? 'Live projection' : 'Our forecast', h('span', { class: 'pill', style: { textTransform: 'none', letterSpacing: 0 } }, bandLabel(p, r))),
    h('div', { class: 'matchup' }, candBlock(r, 'left', p, c.live), h('div', { class: 'vs' }, 'VS'), candBlock(r, 'right', p, c.live)),
    h('div', { style: { margin: '16px 0 10px' } }, splitBar(r.leftParty === 'D' || r.leftParty === 'I' ? p : p, 1 - p, { height: 14 })),
    h('p', { class: 'small', style: { margin: 0 } }, h('b', null, winsText(lastName(favName), Math.max(p, 1 - p))), `${c.live ? ', given the votes counted so far' : ''}. Projected margin ${marginText(c.mu, r)}, with an 80% chance it lands between ${marginText(c.mu - 1.2816 * c.sd, r)} and ${marginText(c.mu + 1.2816 * c.sd, r)}.`));
  hero.querySelector('.split-bar').firstChild.style.background = partyVar(r.leftParty);
  hero.querySelector('.split-bar').lastChild.style.background = partyVar(r.rightParty);

  const curve = h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Range of outcomes'),
    marginCurve(r, c.mu, c.sd),
    h('p', { class: 'xs muted', style: { margin: '6px 0 0' } }, 'Shaded by winner; the bar marks the middle 80% of simulated margins.'));
  root.append(h('div', { class: 'race-hero' }, hero, curve));
  if (r.type !== 'house') root.append(countyCard(r));

  // What drives it + market
  const comps = r.components || {};
  const sig = h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'What’s behind the forecast'),
    signalRows(r, comps),
    h('p', { class: 'xs muted', style: { margin: '10px 0 0' } }, 'Each signal is converted to an expected margin and weighted by how precise it is. ', h('a', { href: '/methodology' }, 'Methodology')));
  root.append(h('section', { class: 'section grid g2' }, sig, marketCard(r, c)));

  // Polls
  const pd = r.pollData;
  if (pd && pd.polls?.length) {
    const chart = pollChart(r);
    root.append(h('section', { class: 'section card' },
      h('div', { class: 'card-title' }, 'Polls', pd.avg ? h('span', { style: { textTransform: 'none', letterSpacing: 0, color: 'var(--ink)' } }, `Weighted average: ${marginText(pd.avg.margin, r)} (${pd.avg.left}%–${pd.avg.right}%)`) : null),
      chart, pollTable(r, pd.polls)));
  } else {
    root.append(h('section', { class: 'section card' }, h('div', { class: 'card-title' }, 'Polls'), h('p', { class: 'muted small', style: { margin: 0 } }, 'No public polls of this matchup yet. The forecast relies on ratings, markets and partisan lean.')));
  }

  root.append(h('section', { class: 'section grid g2' }, ratingsCard(r), context(r)));

  const others = (store.byState[r.state] || []).filter(x => x.id !== r.id && (x.type !== 'house' || r.type !== 'house' || Math.abs((x.district || 0) - (r.district || 0)) <= 2)).slice(0, 8);
  if (others.length) root.append(h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, `More in ${r.stateName}`), h('a', { class: 'small', href: `/state/${r.state}` }, 'State page →')),
    h('div', { class: 'race-cards' }, others.map(x => raceCard(x)))));
}

/** Same-party race (California's top two): both candidates' chances; the seat's party is settled either way. */
function duelHero(r) {
  const d = duelNow(r);
  const p = d.called ? (d.called === 'a' ? 1 : 0) : Math.min(0.999, Math.max(0.001, d.pA));
  const partyName = PARTY_NAME[d.party] || 'party';
  const block = (name, q, side, level) => {
    const k = (r.candidates || []).find(x => x.name === name);
    return h('div', { class: `cand ${side}` },
      h('div', { class: 'avatar', style: { background: partyVar(d.party, level) } }, initials(name)),
      h('div', { class: 'cname' }, name),
      h('div', { class: 'cmeta' }, `${partyName}${k?.incumbent ? ' · Incumbent' : ''}`),
      h('div', { class: 'cprob', style: { color: partyVar(d.party, level) } }, pct(q)),
      h('div', { class: 'xs muted' }, d.live ? 'live chance of winning' : 'chance of winning'));
  };
  const fav = p >= 0.5 ? d.a : d.b;
  const q = Math.max(p, 1 - p);
  const lead = d.called ? `${fav} won.` : q < 0.55 ? 'It is close to a coin flip.'
    : q >= 0.95 ? `${lastName(fav)} is a heavy favorite.` : `${lastName(fav)} has about a ${oddsText(q)} chance.`;
  const incumbent = [d.a, d.b].filter(n => (r.candidates || []).find(x => x.name === n)?.incumbent).length === 1;
  const why = d.live ? (d.called ? '' : ' The live odds blend the votes counted so far with the pre-election odds.')
    : d.source === 'market'
      ? ` The odds come from Polymarket’s market on the two candidates${d.volume ? ` (${compact(d.volume)} traded)` : ''}, ${incumbent ? 'nudged slightly toward the usual edge incumbents have in these races' : 'pulled slightly toward even'}.`
      : incumbent ? ' With no market or polls on this matchup, the odds reflect the usual edge incumbents have in same-party races.' : ' With no market or polls on this matchup, it is treated as even.';
  const adj = { D: 'Democratic', R: 'Republican' }[d.party] || partyName;
  return h('div', { class: 'card' },
    h('div', { class: 'card-title' }, d.live ? 'Live projection' : 'Our forecast', h('span', { class: 'pill', style: { textTransform: 'none', letterSpacing: 0 } }, `${partyName} vs. ${partyName}`)),
    h('div', { class: 'matchup' }, block(d.a, p, 'left', 1), h('div', { class: 'vs' }, 'VS'), block(d.b, 1 - p, 'right', 2)),
    h('div', { class: 'split-bar', style: { height: '14px', margin: '16px 0 10px' } },
      h('span', { style: { width: `${p * 100}%`, background: partyVar(d.party, 1) } }),
      h('span', { style: { width: `${(1 - p) * 100}%`, background: partyVar(d.party, 2), marginLeft: 'auto' } })),
    h('p', { class: 'small', style: { margin: 0 } }, h('b', null, lead), ` Both advanced from California’s top-two primary as ${partyName}s, so the seat stays ${adj} whoever wins.${why}`));
}

/** Statewide races: county map, live on election night, otherwise the 2024 presidential vote. */
export function countyCard(r) {
  if (nightMode() && !store.sim) wantCounties([r.id]);
  const live = nightMode() && countyResults(r.id);
  const title = live ? 'Results by county' : 'How the counties voted in 2024';
  const note = r.state === 'AK' ? '' : live
    ? `Shaded by who leads each county and by how much. ${store.sim ? 'Simulated counts.' : 'AP counts via The New York Times.'}`
    : nightMode() ? 'County results appear as soon as counties report.' : 'Presidential vote by county, 2024 (Harris vs. Trump). On election night this map switches to live county results.';
  return h('section', { class: 'section card' },
    h('div', { class: 'card-title' }, title, live ? h('span', { class: 'pill live', style: { textTransform: 'none', letterSpacing: 0 } }, h('span', { class: 'live-dot' }), store.sim ? 'Simulated' : 'Live') : null),
    countyMap(r.state, { raceId: r.id, zoomKey: `county-${r.id}` }),
    r.state === 'AK' ? null : mapLegend(COUNTY_LEGEND.map(([c, l], i) => [c, i < 4 && live ? l.replace('D', lastNameShort(r.left, r.leftParty)) : i >= 4 && live ? l.replace('R', lastNameShort(r.right, r.rightParty)) : l])),
    note ? h('p', { class: 'xs muted', style: { margin: '6px 0 0' } }, note) : null);
}

const lastNameShort = (name, party) => (party === 'D' || party === 'R' ? party : lastName(name));

function resultsCard(r, c) {
  const res = c.result;
  const tot = res.total || 0;
  const rows = res.cands.slice(0, 8).map(k => h('tr', null,
    h('td', null, h('div', { class: 'cand-line' }, partyChip(k.party), h('span', { class: 'nm', style: { fontWeight: k.winner ? 750 : 550 } }, k.name), k.winner ? h('span', { class: 'winner-check', title: 'Winner' }, '✓') : null),
      h('div', { class: 'vote-bar' }, h('i', { style: { width: `${(k.pct * 100).toFixed(1)}%`, background: partyVar(k.party) } }))),
    h('td', { class: 'votes' }, num(k.votes)),
    h('td', { class: 'votes', style: { fontWeight: 700 } }, `${(k.pct * 100).toFixed(1)}%`)));
  const dw = r.duel ? res.duel?.won : null;
  const status = r.duel ? (dw ? `Called for ${dw === 'a' ? r.duel.a : r.duel.b}` : tot ? 'Counting' : 'Polls closed, no votes yet')
    : res.called ? (res.called === 'other' ? 'Called' : `Called for ${res.called === 'left' ? r.left : r.right}`) : res.runoff ? 'Headed to a runoff' : tot ? 'Counting' : 'Polls closed, no votes yet';
  return h('section', { class: 'card', style: { marginBottom: '16px' } },
    h('div', { class: 'card-title' }, h('span', { style: { display: 'inline-flex', gap: '8px', alignItems: 'center' } }, h('span', { class: 'live-dot' }), 'Live results'),
      h('span', { class: (r.duel ? dw : res.called) ? 'pill called' : 'pill live', style: { textTransform: 'none', letterSpacing: 0 } }, status)),
    h('div', { class: 'table-wrap', style: { border: 0 } }, h('table', { class: 'data results-table' },
      h('thead', null, h('tr', null, h('th', null, 'Candidate'), h('th', { class: 'num' }, 'Votes'), h('th', { class: 'num' }, 'Pct.'))), h('tbody', null, rows))),
    h('div', { style: { marginTop: '12px' } }, h('div', { class: 'eevp-bar', style: { height: '8px' } }, h('i', { style: { width: `${Math.min(100, c.eevp)}%` } }))),
    h('div', { class: 'compare-line', style: { marginTop: '8px' } },
      h('span', null, h('b', null, `${Math.round(c.eevp)}%`), ' of expected vote counted · ', `${num(tot)} votes`),
      h('span', null, res.demo ? 'Simulated (demo)' : `Source: AP via The New York Times · updated ${timeAgo(res.updated)}`)));
}

function marketCard(r, c) {
  const live = store.live.markets[r.id];
  const m = r.market;
  if (!m) return h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Prediction market'), h('p', { class: 'muted small', style: { margin: 0 } }, 'No Polymarket market for this race.'));
  const outs = (live?.outcomes || m.outcomes).filter(o => o.p >= 0.005).slice(0, 6);
  return h('div', { class: 'card' },
    h('div', { class: 'card-title' }, 'Polymarket', live ? h('span', { class: 'pill live', style: { textTransform: 'none', letterSpacing: 0 } }, h('span', { class: 'live-dot' }), 'Live price') : null),
    outs.map(o => h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 140px 52px', gap: '10px', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--line)' } },
      h('div', { class: 'cand-line' }, partyChip(o.party || (o.name && r.candidates?.find(k => k.name && lastName(k.name) === lastName(o.name))?.party) || 'O'), h('span', { class: 'nm' }, o.name || o.label)),
      h('div', { class: 'vote-bar', style: { marginTop: 0, height: '8px' } }, h('i', { style: { width: `${o.p * 100}%`, background: partyVar(o.party || 'O') } })),
      h('b', { class: 'tnum', style: { textAlign: 'right' } }, pct(o.p)))),
    h('p', { class: 'xs muted', style: { margin: '10px 0 0' } }, `${compact(m.volume)} traded. Prices are traders’ implied probabilities, not polls. `,
      h('a', { href: `https://polymarket.com/event/${m.slug}`, target: '_blank', rel: 'noopener' }, 'View market ↗')));
}

function pollTable(r, polls) {
  const rows = polls.slice(0, 15).map(p => h('tr', null,
    h('td', null, h('div', { style: { fontWeight: 600 } }, p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener' }, p.pollster) : p.pollster),
      h('div', { class: 'xs muted' }, [p.sponsors?.join(', '), p.partisan ? 'partisan/internal' : null].filter(Boolean).join(' · '))),
    h('td', { class: 'hide-sm small muted nowrap' }, `${fmtDate(p.start)}–${fmtDate(p.end)}`),
    h('td', { class: 'num small hide-sm' }, p.n ? `${num(p.n)} ${String(p.pop || '').toUpperCase()}` : String(p.pop || '').toUpperCase()),
    h('td', { class: 'num', style: { color: partyVar(r.leftParty), fontWeight: 650 } }, `${p.left}%`),
    h('td', { class: 'num', style: { color: partyVar(r.rightParty), fontWeight: 650 } }, `${p.right}%`),
    h('td', { class: 'num', style: { fontWeight: 700 } }, marginText(p.left - p.right, r, 0))));
  return h('div', { class: 'table-wrap', style: { marginTop: '14px' } }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'Pollster'), h('th', { class: 'hide-sm' }, 'Dates'), h('th', { class: 'num hide-sm' }, 'Sample'),
      h('th', { class: 'num' }, lastName(r.left)), h('th', { class: 'num' }, lastName(r.right)), h('th', { class: 'num' }, 'Net'))),
    h('tbody', null, rows)));
}

function ratingsCard(r) {
  const rs = Object.entries(r.ratings || {});
  const FULL = { Cook: 'Cook Political Report', IE: 'Inside Elections', Sabato: "Sabato's Crystal Ball", Econ: 'The Economist', ST: 'Split Ticket', DDHQ: 'Decision Desk HQ', FPO: 'FiftyPlusOne', Fox: 'Fox News', Silver: 'Silver Bulletin', RCP: 'RealClearPolitics', NBC: 'NBC News', 'MS NOW': 'MS NOW', 'State Nav.': 'State Navigate' };
  return h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Expert ratings'),
    rs.length ? rs.map(([n, v]) => h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--line)', gap: '10px' } },
      h('span', null, FULL[n] || n, h('span', { class: 'xs muted' }, r.ratingDates?.[n] ? ` · ${r.ratingDates[n]}` : '')), ratingChip(v)))
      : h('p', { class: 'muted small', style: { margin: 0 } }, 'Forecasters rate this seat safe for the incumbent party.'),
    h('p', { class: 'xs muted', style: { margin: '10px 0 0' } }, 'Compiled from Wikipedia’s ratings tables.'));
}

function candidateList(r) {
  return h('div', { style: { marginTop: '12px' } }, h('div', { class: 'small muted', style: { marginBottom: '6px' } }, 'On the ballot'),
    h('div', { class: 'chips' }, (r.candidates || []).map(k => h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center', padding: '3px 8px', borderRadius: '6px', background: 'var(--surface-2)', fontSize: '13px' } }, partyChip(k.party), k.name, k.incumbent ? h('span', { class: 'inc-star' }, 'INC') : null))));
}

function context(r) {
  const pviText = r.pvi === null || r.pvi === undefined ? '—' : r.pvi === 0 ? 'EVEN' : `${r.pvi > 0 ? 'D' : 'R'}+${Math.abs(r.pvi)}`;
  const map = r.type === 'house'
    ? stateDistrictMap(r.state, { highlight: r.id, width: 560, maxHeight: 340 })
    : stateDistrictMap(r.state, { width: 560, maxHeight: 300 });
  return h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'About this race'),
    h('div', { style: { marginBottom: '12px' } }, map,
      h('div', { class: 'xs muted', style: { marginTop: '4px' } }, r.type === 'house' ? `${r.short} with neighboring districts (2026 lines)` : `${r.stateName}'s House districts, colored by our forecast`)),
    h('dl', { class: 'kv', style: { margin: 0 } },
      h('dt', null, 'Partisan lean'), h('dd', null, `${pviText} (Cook PVI)`),
      r.lastResult ? [h('dt', null, 'Last result'), h('dd', null, r.lastResult)] : null,
      h('dt', null, 'Held by'), h('dd', null, r.holder ? PARTY_NAME[r.holder] : 'New seat'),
      r.firstElected ? [h('dt', null, 'First elected'), h('dd', null, r.firstElected)] : null,
      h('dt', null, 'Polls close'), h('dd', null, pollCloseText(r.state)),
      r.note ? [h('dt', null, 'Note'), h('dd', null, r.note)] : null,
      r.state === 'GA' && (r.type === 'senate' || r.type === 'gov') ? [h('dt', null, 'Runoff'), h('dd', null, 'If no one tops 50%, the top two meet in a Dec. 1 runoff.')] : null,
      r.state === 'AK' || (r.state === 'ME' && (r.type === 'senate' || r.type === 'house')) ? [h('dt', null, 'Voting method'), h('dd', null, 'Ranked-choice voting; if no one wins a majority of first choices, the final result can take a week or more.')] : null),
    r.left && r.right ? candidateList(r) : null);
}

export const title = (id) => store.byId[id]?.title || 'Race';
void timeAgo;
