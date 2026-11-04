// DOM helpers, formatting and the colour system.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export const svgNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const c of children.flat()) if (c !== null && c !== undefined) el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export const esc = (str) => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- formatting

/** A probability as a percentage, to one decimal by default (close races read apart: 51.4% vs 54.2%). */
export function pct(p, { digits = 1, extremes = true } = {}) {
  if (p === null || p === undefined || Number.isNaN(p)) return '—';
  if (p >= 1) return '100%';
  if (p <= 0) return '0%';
  const edge = 10 ** -(digits + 2);   // the smallest step shown: 0.1% at one decimal
  if (extremes && p > 1 - edge) return `>${(100 - edge * 100).toFixed(digits)}%`;
  if (extremes && p < edge) return `<${(edge * 100).toFixed(digits)}%`;
  return `${(p * 100).toFixed(digits)}%`;
}

/** "3 in 4" style odds for a probability. */
export function oddsText(p) {
  if (p >= 0.995) return 'almost certain';
  if (p <= 0.005) return 'almost no chance';
  const q = Math.max(p, 1 - p);
  const n = Math.round(1 / (1 - q));
  const fav = p >= 0.5;
  if (q < 0.55) return 'about even';
  return fav ? `${n - 1} in ${n}` : `1 in ${n}`;
}

/** A simulation count as the site quotes it: "20,000", or "1 million" for round millions. */
export function simCount(n) {
  return n >= 1e6 && n % 1e6 === 0 ? `${n / 1e6} million` : num(n);
}

export function num(x, d = 0) {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  return x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
}

export function compact(x) {
  if (!x && x !== 0) return '—';
  if (x >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${Math.round(x / 1e3)}K`;
  return `$${Math.round(x)}`;
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function lastName(name) {
  if (!name) return '';
  const parts = name.replace(/\b(Jr\.?|Sr\.?|II|III|IV)$/i, '').trim().split(/\s+/);
  // keep compound surnames like "De La Cruz", "Wasserman Schultz"
  const joiners = ['de', 'la', 'del', 'van', 'von', 'der', 'di', 'da', 'le', 'st.', 'mc'];
  let i = parts.length - 1;
  while (i > 1 && joiners.includes(parts[i - 1].toLowerCase())) i--;
  return parts.slice(i).join(' ');
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const sec = Math.round((Date.now() - new Date(iso)) / 1000);
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} hr ago`;
  return `${Math.round(sec / 86400)} days ago`;
}

export function fmtDate(iso, opts = { month: 'short', day: 'numeric' }) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00Z' : iso);
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', ...opts });
}

export function fmtTimeET(d) {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
}

export const PARTY_NAME = { D: 'Democrat', R: 'Republican', I: 'Independent', L: 'Libertarian', G: 'Green', O: 'Other', C: 'Coalition' };
export const PARTY_SHORT = { D: 'Dem.', R: 'Rep.', I: 'Ind.', L: 'Lib.', G: 'Grn.', O: 'Oth.', C: 'Coal.' };

/** Signed margin text for the left side: 'D+4.2', or 'Osborn +3' when the left candidate is not a Democrat. */
export function marginText(mu, race, d = 1) {
  if (mu === null || mu === undefined || Number.isNaN(mu)) return '—';
  const leftWins = mu >= 0;
  const party = leftWins ? race.leftParty : race.rightParty;
  const name = leftWins ? race.left : race.right;
  const v = Math.abs(mu);
  const tag = party === 'D' || party === 'R' ? party : lastName(name);
  if (v < 0.05) return 'Even';
  return `${tag}+${v.toFixed(d)}`;
}

// ---------------------------------------------------------------- colour

export const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const FAMILY = { D: 'dem', R: 'rep', I: 'ind' };

export function partyVar(party, level = 1) {
  const f = FAMILY[party];
  if (!f) return level === 1 ? 'var(--oth)' : 'var(--toss)';
  return `var(--${f}${level === 1 ? '' : '-' + level})`;
}

/** Fill colour for a probability (left side) given each side's party. */
/** "Likely D", "Tilt Osborn"…: a race's margin band in words (margin = left minus right, in points). */
export function bandLabel(margin, race) {
  if (margin === null || margin === undefined) return '—';
  if (margin === 0) return 'Toss-up';
  const party = margin > 0 ? race.leftParty : race.rightParty;
  const who = party === 'D' || party === 'R' ? party : lastName(margin > 0 ? race.left : race.right);
  return `${marginBand(margin).label} ${who}`;
}

// Every map shades a race by its margin in points, on one scale: the final forecast's projected margin before
// results (and on forecast pages), the margin in the count once votes are in. Darker always means a bigger margin.
export const MARGIN_BANDS = [
  { key: 'safe', label: 'Safe', min: 15, range: '15+' },
  { key: 'likely', label: 'Likely', min: 5, range: '5–15' },
  { key: 'lean', label: 'Lean', min: 1, range: '1–5' },
  { key: 'tilt', label: 'Tilt', min: 0, range: '<1' },
];
export const marginBand = (margin) => MARGIN_BANDS.find(b => Math.abs(margin) >= b.min);
/** Map fill for a race `party` wins or leads by `margin` points (the --dem-safe… tokens in app.css). */
export function marginFill(party, margin) {
  if (margin === null || margin === undefined || Number.isNaN(margin)) return 'var(--none)';
  if (margin === 0) return 'var(--toss)';
  const f = FAMILY[party];
  return f ? `var(--${f}-${marginBand(margin).key})` : 'var(--oth)';
}

let hatchSeq = 0;
/** Adds the stripe pattern for races still counting to an SVG; returns the fill that draws it. */
export function hatchFill(svg) {
  const id = `bd-hatch-${++hatchSeq}`;
  svg.appendChild(s('defs', null, s('pattern', { id, width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
    s('rect', { width: 2.6, height: 7, class: 'hatch-stripe' }))));
  return `url(#${id})`;
}

export const RATING_COLORS = (r) => {
  if (!r) return { bg: 'var(--none)', fg: 'var(--muted)' };
  if (r.score === 0) return { bg: 'var(--toss)', fg: '#121417' };
  const party = r.side === 'D' ? 'D' : r.side === 'R' ? 'R' : r.side === 'I' ? 'I' : null;
  const lvl = Math.abs(r.score) >= 3 ? 1 : Math.abs(r.score) >= 2 ? 2 : 3;
  return { bg: party ? partyVar(party, lvl) : 'var(--oth)', fg: lvl === 1 ? '#fff' : '#121417' };
};

export function partyChip(party) {
  return h('span', { class: `party-chip ${party || 'O'}`, title: PARTY_NAME[party] || 'Other' }, party || '?');
}

export function ratingChip(r) {
  const c = RATING_COLORS(r);
  return h('span', { class: 'rating-chip', style: { background: c.bg, color: c.fg } }, r ? r.label : '—');
}

// ---------------------------------------------------------------- tooltip

let tipEl = null;
export function tooltip() {
  if (!tipEl) {
    tipEl = h('div', { class: 'tooltip', role: 'tooltip' });
    document.body.appendChild(tipEl);
  }
  return {
    show(html, ev) {
      tipEl.innerHTML = html;
      tipEl.classList.add('on');
      this.move(ev);
    },
    move(ev) {
      if (!ev) return;
      const pad = 14, w = tipEl.offsetWidth, hgt = tipEl.offsetHeight;
      let x = ev.clientX + pad, y = ev.clientY + pad;
      if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
      if (y + hgt > window.innerHeight - 8) y = ev.clientY - hgt - pad;
      tipEl.style.left = `${Math.max(8, x)}px`;
      tipEl.style.top = `${Math.max(8, y)}px`;
    },
    hide() { tipEl.classList.remove('on'); },
  };
}

// Sort choices survive the periodic live re-render (keyed by the caller's stateKey).
const SORTS = {};

export function sortableTable(columns, rows, { sortKey, desc = true, onRow, rowClass, empty = 'No races match.', stateKey, limit = Infinity } = {}) {
  const saved = stateKey ? SORTS[stateKey] : null;
  let key = saved?.key ?? sortKey ?? columns.find(c => c.sort)?.key;
  let dir = saved?.dir ?? (desc ? -1 : 1);
  let all = !!saved?.all;
  const save = () => { if (stateKey) SORTS[stateKey] = { key, dir, all }; };
  const table = h('table', { class: 'data' });
  const thead = h('thead');
  const tbody = h('tbody');
  table.append(thead, tbody);
  function draw() {
    thead.innerHTML = '';
    const tr = h('tr');
    for (const c of columns) {
      const th = h('th', { class: [c.num ? 'num' : '', c.sort ? 'sortable' : '', key === c.key ? 'sorted' : '', key === c.key && dir === 1 ? 'asc' : '', c.hideSm ? 'hide-sm' : ''].join(' ') }, c.label);
      if (c.sort) th.addEventListener('click', () => {
        if (key === c.key) dir = -dir; else { key = c.key; dir = c.defaultAsc ? 1 : -1; }
        save();
        draw();
      });
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    tbody.innerHTML = '';
    const col = columns.find(c => c.key === key);
    const sorted = col && col.sort ? rows.slice().sort((a, b) => {
      const va = col.sort(a), vb = col.sort(b);
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      return (va < vb ? -1 : 1) * dir;
    }) : rows;
    if (!sorted.length) tbody.appendChild(h('tr', null, h('td', { colspan: columns.length, class: 'empty' }, empty)));
    const shown = all ? sorted : sorted.slice(0, limit);
    for (const r of shown) {
      const tr2 = h('tr', { class: [onRow ? 'clickable' : '', rowClass ? rowClass(r) : ''].join(' ') });
      if (onRow) tr2.addEventListener('click', (e) => { if (!e.target.closest('a')) onRow(r); });
      for (const c of columns) {
        const v = c.render(r);
        tr2.appendChild(h('td', { class: [c.num ? 'num' : '', c.hideSm ? 'hide-sm' : '', c.cls || ''].join(' ') }, v));
      }
      tbody.appendChild(tr2);
    }
    if (shown.length < sorted.length) {
      const more = h('button', { type: 'button', class: 'linkish' }, `Show all ${sorted.length}`);
      more.addEventListener('click', () => { all = true; save(); draw(); });
      tbody.appendChild(h('tr', { class: 'more-row' }, h('td', { colspan: columns.length }, more)));
    }
  }
  draw();
  return h('div', { class: 'table-wrap' }, table);
}
