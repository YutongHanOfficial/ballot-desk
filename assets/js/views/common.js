// Building blocks shared by several pages.
import { h, pct, partyChip, partyVar, lastName, marginText, num, oddsText, ratingChip, fmtTimeET, PARTY_NAME, timeAgo } from '../ui.js';
import { store, cur, chamber, marketControl, duelNow } from '../store.js';
import { avatar } from '../photos.js';
import { splitBar, probCell } from '../charts.js';
import { calledSeats, resultsEnabled } from '../live.js';
import { CONFIG, pollCloseDate, supportLinks } from '../config.js';

export const CHAMBERS = {
  senate: { name: 'Senate', url: '/senate', need: 51, total: 100, needR: 50, unit: 'seats' },
  house: { name: 'House', url: '/house', need: 218, total: 435, needR: 218, unit: 'seats' },
  gov: { name: 'Governors', url: '/governors', need: 26, total: 50, needR: 25, unit: 'governorships' },
};

const VERB = (q) => q >= 0.95 ? 'are near-certain to win' : q >= 0.85 ? 'are clear favorites to win' : q >= 0.7 ? 'are favored to win' : q >= 0.58 ? 'are slightly favored to win' : null;

export function headline() {
  const s = chamber('senate'), hs = chamber('house');
  const fav = (c) => c.pD >= c.pR ? 'Democrats' : 'Republicans';
  const q = (c) => Math.max(c.pD, c.pR);
  if (fav(s) === fav(hs) && VERB(q(s)) && VERB(q(hs))) return `${fav(s)} ${VERB(Math.min(q(s), q(hs)))} both the House and the Senate`;
  const hp = VERB(q(hs)) ? `${fav(hs)} ${VERB(q(hs))} the House` : 'The House is a toss-up';
  const sp = VERB(q(s)) ? `${fav(s)} ${VERB(q(s))} the Senate` : 'the Senate is a toss-up';
  return `${hp}, and ${sp}`;
}

/** Big card with control odds for a chamber. */
export function chamberCard(type, { link = true } = {}) {
  const C = CHAMBERS[type];
  const ch = chamber(type);
  const mk = type !== 'gov' ? marketControl(type) : null;
  const dSeats = ch.dSeats;
  const pD = type === 'gov' ? null : ch.pD, pR = type === 'gov' ? null : ch.pR;
  const body = [];
  body.push(h('div', { class: 'chamber-top' },
    h('div', null, h('div', { class: 'chamber-name' }, C.name), h('div', { class: 'chamber-sub' }, type === 'gov' ? '36 races · 50 governorships' : type === 'senate' ? '35 races · 51 seats for control' : '435 races · 218 seats for control')),
    ch.live ? h('span', { class: 'pill live' }, h('span', { class: 'live-dot' }), 'Live') : null));
  if (type === 'gov') {
    body.push(h('div', { class: 'odds-row' },
      h('div', { class: 'odds dem' }, h('span', { class: 'pct' }, num(dSeats.mean, 0)), h('span', { class: 'who c-dem' }, 'Democratic governors')),
      h('div', { class: 'odds rep right' }, h('span', { class: 'pct' }, num(50 - dSeats.mean, 0)), h('span', { class: 'who c-rep' }, 'Republican governors'))));
    body.push(splitBar(dSeats.mean / 50, 1 - dSeats.mean / 50));
    body.push(h('div', { class: 'compare-line' }, h('span', null, 'Now: ', h('b', null, '24 D · 26 R')), h('span', null, '80% range: ', h('b', null, `${dSeats.p10}–${dSeats.p90} D`))));
  } else {
    body.push(h('div', { class: 'odds-row' },
      h('div', { class: 'odds dem' }, h('span', { class: 'pct' }, pct(pD)), h('span', { class: 'who c-dem' }, 'Democrats')),
      h('div', { class: 'odds rep right' }, h('span', { class: 'pct' }, pct(pR)), h('span', { class: 'who c-rep' }, 'Republicans'))));
    body.push(splitBar(pD, pR, { pO: ch.pNeither }));
    body.push(h('div', { class: 'compare-line' },
      h('span', null, 'Expected: ', h('b', null, `${Math.round(dSeats.mean)} D · ${C.total - Math.round(dSeats.mean)} R`)),
      mk && mk.pD !== null ? h('span', null, 'Polymarket: ', h('b', { class: 'c-dem' }, pct(mk.pD)), ' D') : null));
  }
  return h(link ? 'a' : 'div', { class: 'card chamber-card', href: link ? C.url : null }, body);
}

/** Race summary card (pre-election forecast or live count). */
export function raceCard(r, { showType = true } = {}) {
  const c = cur(r);
  const res = c.result;
  const counting = res && (res.total > 0 || res.called);
  const p = c.p ?? 0.5;
  const rows = [];
  const cand = (name, party, val, lead, winner, votes) => h('div', { class: `rc-cand${lead ? ' lead' : ''}` },
    avatar(r, name, party, { size: 28, fallback: 'chip', badge: true }), h('span', { class: 'nm' }, name || '—', winner ? h('span', { class: 'winner-check', style: { marginLeft: '6px' }, title: 'Winner' }, '✓') : null),
    votes !== undefined ? h('span', { class: 'rc-votes' }, num(votes)) : null,
    h('span', { class: 'pv', style: { color: lead ? partyVar(party) : 'var(--ink-2)' } }, val));
  const card = (foot) => h('a', { class: 'race-card', href: r.url },
    h('div', { class: 'rc-head' }, h('span', { class: 'rc-title' }, r.type === 'house' ? r.short : r.stateName + (r.special ? ' (special)' : '')),
      showType ? h('span', { class: 'rc-type' }, r.office) : null),
    h('div', { class: 'rc-cands' }, rows), foot);
  if (r.duel) {
    // Two candidates of one party: the odds (or the count) between them.
    const d = duelNow(r);
    const v = d.result, tot = v?.total || 0;
    const share = (x) => `${((x / tot) * 100).toFixed(1)}%`;
    const q = (x) => pct(Math.min(0.999, Math.max(0.001, x)));
    rows.push(cand(d.a, d.party, tot ? share(v.a) : q(d.pA), tot ? v.a >= v.b : d.pA >= 0.5, d.called === 'a', tot ? v.a : undefined));
    rows.push(cand(d.b, d.party, tot ? share(v.b) : q(1 - d.pA), tot ? v.b > v.a : d.pA < 0.5, d.called === 'b', tot ? v.b : undefined));
    if (tot) rows.push(h('div', { class: 'eevp-bar', title: `${Math.round(v.eevp)}% of expected vote counted` }, h('i', { style: { width: `${Math.min(100, v.eevp)}%` } })));
    const favName = d.pA >= 0.5 ? d.a : d.b;
    return card(h('div', { class: 'rc-foot' },
      h('span', null, tot ? `${Math.round(v.eevp)}% counted` : `Both ${PARTY_NAME[d.party]}s`),
      d.called ? h('span', null, 'Called')
        : tot ? h('span', { style: { color: partyVar(d.party), fontWeight: 650 } }, `${lastName(favName)} ${q(Math.max(d.pA, 1 - d.pA))} to win`)
        : h('span', null, `${d.party} hold either way`)));
  }
  if (!r.left || !r.right) {
    const w = r.left ? r.leftCand : r.rightCand;
    rows.push(cand(w?.name, w?.party, '✓', true));
    rows.push(h('div', { class: 'xs muted' }, r.samePartyGeneral ? `Two ${PARTY_NAME[r.samePartyGeneral]}s advanced` : 'No major-party opponent'));
  } else if (counting) {
    const tot = res.total || 1;
    const lp = res.left / tot, rp = res.right / tot;
    rows.push(cand(r.left, r.leftParty, `${(lp * 100).toFixed(1)}%`, lp >= rp, res.called === 'left', res.left));
    rows.push(cand(r.right, r.rightParty, `${(rp * 100).toFixed(1)}%`, rp > lp, res.called === 'right', res.right));
    rows.push(h('div', { class: 'eevp-bar', title: `${Math.round(c.eevp)}% of expected vote counted` }, h('i', { style: { width: `${Math.min(100, c.eevp)}%` } })));
  } else {
    const shown = Math.min(0.999, Math.max(0.001, p));
    rows.push(cand(r.left, r.leftParty, pct(shown), p >= 0.5));
    rows.push(cand(r.right, r.rightParty, pct(1 - shown), p < 0.5));
  }
  const fav = p >= 0.5 ? r.leftParty : r.rightParty;
  const foot = counting
    ? h('div', { class: 'rc-foot' }, h('span', null, `${Math.round(c.eevp)}% counted`), res.called || !r.left || !r.right
      ? h('span', null, 'Called')
      : h('span', { style: { color: partyVar(fav), fontWeight: 650 } }, `${shortName(r, p >= 0.5 ? 'left' : 'right')} ${pct(Math.min(0.999, Math.max(p, 1 - p)))} to win`))
    : h('div', { class: 'rc-foot' }, h('span', null, r.left && r.right ? `Proj. ${marginText(c.mu, r)}` : ''), flipTag(r, p));
  return card(foot);
}

export function flipTag(r, p) {
  if (!r.holder || p === null || p === undefined || !r.left || !r.right) return h('span');
  const fav = p >= 0.5 ? r.leftParty : r.rightParty;
  if (fav !== r.holder && Math.max(p, 1 - p) >= 0.5) return h('span', { style: { color: partyVar(fav), fontWeight: 700 } }, `${fav} pickup`);
  return h('span', null, `${r.holder} held`);
}

export function candCell(r, side) {
  if (r.duel) {
    // Both candidates share a party: list them together in that party's column.
    if (side !== (r.left ? 'left' : 'right')) return h('span', { class: 'muted' }, '—');
    const inc = (name) => (r.candidates || []).find(c => c.name === name)?.incumbent;
    return h('div', { class: 'duel-cell' }, [r.duel.a, r.duel.b].map(name => h('div', { class: 'cand-line' }, partyChip(r.duel.party), h('span', { class: 'nm' }, name),
      inc(name) ? h('span', { class: 'inc-star', title: 'Incumbent' }, 'INC') : null)));
  }
  const name = side === 'left' ? r.left : r.right;
  const party = side === 'left' ? r.leftParty : r.rightParty;
  const c = side === 'left' ? r.leftCand : r.rightCand;
  if (!name) return h('span', { class: 'muted' }, '—');
  return h('div', { class: 'cand-line' }, partyChip(party), h('span', { class: 'nm' }, name), c?.incumbent ? h('span', { class: 'inc-star', title: 'Incumbent' }, 'INC') : null);
}

/** Standard columns for race tables. */
export function raceColumns({ type } = {}) {
  return [
    { key: 'race', label: 'Race', render: r => h('a', { class: 'race-name', href: r.url }, type === 'house' ? r.short : r.stateName + (r.special ? ' (special)' : '')), sort: r => r.type === 'house' ? r.id : r.stateName, defaultAsc: true },
    { key: 'left', label: 'Democrat / Ind.', render: r => candCell(r, 'left') },
    { key: 'right', label: 'Republican', render: r => candCell(r, 'right') },
    { key: 'p', label: 'Chance of winning', num: true, render: r => (r.left && r.right) || r.duel ? probCell(r) : h('span', { class: 'muted small' }, 'Uncontested'), sort: r => { const p = r.duel ? duelNow(r).pA : cur(r).p; return p === null ? null : -Math.abs(p - 0.5); } },
    { key: 'mu', label: 'Proj. margin', num: true, hideSm: true, render: r => r.left && r.right ? h('span', { class: 'tnum' }, marginText(cur(r).mu, r)) : r.duel ? h('span', { class: 'muted small' }, `${r.duel.party} hold`) : '', sort: r => cur(r).mu },
    { key: 'mk', label: 'Polymarket', num: true, hideSm: true, render: r => {
      if (r.duel) { const m = duelNow(r).marketA; return m === null ? h('span', { class: 'muted' }, '—') : h('span', { class: 'tnum' }, `${pct(Math.max(m, 1 - m))} ${lastName(m >= 0.5 ? r.duel.a : r.duel.b)}`); }
      const p = cur(r).marketP; return p === null || p === undefined ? h('span', { class: 'muted' }, '—') : h('span', { class: 'tnum' }, `${pct(p)} ${shortName(r, 'left')}`);
    }, sort: r => r.duel ? null : cur(r).marketP },
    { key: 'holder', label: 'Held by', hideSm: true, render: r => r.holder ? partyChip(r.holder) : h('span', { class: 'muted xs' }, 'New'), sort: r => r.holder },
  ];
}

export function shortName(r, side) {
  const party = side === 'left' ? r.leftParty : r.rightParty;
  return party === 'D' || party === 'R' ? party : lastName(side === 'left' ? r.left : r.right);
}

/** Countdown or live banner shown at the top of pages. */
export function electionBanner() {
  const now = Date.now();
  const first = Date.parse(CONFIG.firstPollsClose);
  if (store.sim) return null;   // the simulation bar in the header says it all
  if (store.live.active) {
    const t = Object.values(store.live.resultsAt || {}).sort().pop();
    return h('div', { class: 'banner live' }, h('span', { class: 'live-dot' }),
      h('div', { class: 'grow' }, h('b', null, 'Results are coming in. '), 'Projections update as votes are counted. ', h('span', { class: 'muted' }, t ? `Last update ${timeAgo(t)}.` : '')),
      h('a', { class: 'pill live', href: '/live' }, 'Open live dashboard →'));
  }
  if (now < first) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return h('div', { class: 'banner' },
      h('div', { class: 'grow' }, h('b', null, today === CONFIG.electionDay ? 'Today is Election Day. ' : 'Election Day is Tuesday, November 3. '), 'The first polls close at 6 p.m. Eastern; live results and projections start then.'),
      countdown(first));
  }
  if (resultsEnabled()) {
    return h('div', { class: 'banner live' }, h('span', { class: 'live-dot' }),
      h('div', { class: 'grow' }, h('b', null, 'Polls are closing. '), 'Waiting for the first votes to be reported.'),
      h('a', { class: 'pill live', href: '/live' }, 'Live dashboard →'));
  }
  return null;
}

/** Days, hours, minutes and seconds until a time, ticking while it is on the page. */
export function countdown(target) {
  const box = h('div', { class: 'countdown' });
  const tick = () => {
    const d = Math.max(0, target - Date.now());
    const parts = [[Math.floor(d / 864e5), 'days'], [Math.floor(d / 36e5) % 24, 'hrs'], [Math.floor(d / 6e4) % 60, 'min'], [Math.floor(d / 1e3) % 60, 'sec']];
    box.replaceChildren(...parts.map(([v, l]) => h('div', null, h('b', null, String(v).padStart(2, '0')), h('span', null, l))));
  };
  tick();
  const iv = setInterval(() => { if (!document.body.contains(box)) clearInterval(iv); else tick(); }, 1000);
  return box;
}

/** "Ballot Desk is free…" with a Support button; hidden once dismissed in this browser, or with no donation page. */
export function supportNote(text) {
  if (!supportLinks().length) return null;
  try { if (localStorage.getItem('supportNote') === 'hidden') return null; } catch { /* private mode: show it */ }
  const note = h('div', { class: 'card support-note' },
    h('div', { class: 'grow' }, h('b', null, 'Ballot Desk is free, with no ads or paywall. '), text),
    h('a', { class: 'btn small primary', href: '/support' }, 'Support Ballot Desk'),
    h('button', { type: 'button', class: 'icon-btn', title: 'Hide this', 'aria-label': 'Hide this note', onclick: () => {
      try { localStorage.setItem('supportNote', 'hidden'); } catch { /* private mode */ }
      note.remove();
    } }, '✕'));
  return h('section', { class: 'section' }, note);
}

export function pollCloseText(state) {
  const d = pollCloseDate(state);
  return d ? fmtTimeET(d) : '—';
}

export function ratingsRow(r) {
  const rs = r.ratings || {};
  const names = Object.keys(rs);
  if (!names.length) return h('span', { class: 'muted small' }, 'Not rated competitive');
  return h('div', { class: 'chips' }, names.map(n => h('span', { title: n }, ratingChip({ ...rs[n], label: `${n}: ${rs[n].label}` }))));
}

export function seatsLine(type) {
  const s = calledSeats(type);
  return s;
}

export { oddsText };
