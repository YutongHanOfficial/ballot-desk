// Stream kit: the broadcast scenes to add to OBS or Streamlabs as Browser Sources, with options and a preview.
import { h } from '../ui.js';

const SCENES = [
  { id: 'landscape', name: 'YouTube', what: 'Full screen, landscape', size: [1920, 1080], params: {} },
  { id: 'vertical', name: 'TikTok', what: 'Full screen, vertical (the bottom strip is left clear for the chat)', size: [1080, 1920], params: { format: 'vertical' } },
  { id: 'scoreboard', name: 'Scoreboard overlay', what: 'Senate, House and governors along the top, on a transparent background', size: [1920, 1080], params: { overlay: 'scoreboard' }, overlay: true },
  { id: 'ticker', name: 'Ticker overlay', what: 'A scrolling bar of calls and close races along the bottom, transparent', size: [1920, 1080], params: { overlay: 'ticker' }, overlay: true },
  { id: 'alerts', name: 'Projection alerts overlay', what: 'Pops up when a race is called, otherwise empty and transparent', size: [1920, 1080], params: { overlay: 'alerts' }, overlay: true },
];
const PANELS = [['senate', 'Senate map'], ['house', 'House map'], ['gov', 'Governors map'], ['races', 'Key races'], ['calls', 'Latest projections']];
const OPTS = { panels: PANELS.map(p => p[0]), rotate: 15, odds: false, rehearse: false, light: false, preview: 'landscape' };

function urlFor(scene) {
  const q = new URLSearchParams(scene.params);
  if (!scene.overlay) {
    if (OPTS.panels.length && OPTS.panels.length < PANELS.length) q.set('panel', OPTS.panels.join(','));
    if (OPTS.rotate !== 15) q.set('rotate', OPTS.rotate);
    if (OPTS.odds) q.set('map', 'odds');
  }
  if (OPTS.light) q.set('theme', 'light');
  if (OPTS.rehearse) { q.set('demo', 'live'); q.set('speed', '10'); }
  const qs = q.toString();
  return `${location.origin}/broadcast${qs ? `?${qs}` : ''}`;
}

export function render(root) {
  const list = h('div', { class: 'sk-scenes' });
  const frameBox = h('div', { class: 'sk-preview' });
  const draw = () => {
    list.replaceChildren(...SCENES.map(sc => {
      const url = urlFor(sc);
      const input = h('input', { class: 'sk-url', value: url, readonly: true, 'aria-label': `${sc.name} address`, onfocus: (e) => e.target.select() });
      const copy = h('button', { type: 'button', class: 'btn small primary', onclick: async () => {
        try { await navigator.clipboard.writeText(url); } catch { input.select(); document.execCommand?.('copy'); }
        copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      } }, 'Copy');
      return h('div', { class: `card sk-scene${OPTS.preview === sc.id ? ' on' : ''}` },
        h('div', { class: 'sk-top' }, h('div', null, h('b', null, sc.name), h('span', { class: 'xs muted' }, `${sc.size[0]} × ${sc.size[1]}`)),
          h('button', { type: 'button', class: 'btn small', onclick: () => { OPTS.preview = sc.id; draw(); } }, OPTS.preview === sc.id ? 'Previewing' : 'Preview')),
        h('p', { class: 'small muted' }, sc.what),
        h('div', { class: 'sk-row' }, input, copy));
    }));
    const sc = SCENES.find(x => x.id === OPTS.preview);
    const frame = h('iframe', { src: urlFor(sc), title: `${sc.name} preview`, loading: 'lazy' });
    frameBox.className = `sk-preview ${sc.size[0] > sc.size[1] ? 'wide' : 'tall'}${sc.overlay ? ' overlay' : ''}`;
    frameBox.replaceChildren(frame);
  };

  const check = (label, on, set) => h('label', { class: 'sk-check' }, h('input', { type: 'checkbox', checked: on || null, onchange: (e) => { set(e.target.checked); draw(); } }), label);
  const options = h('div', { class: 'card sk-options' },
    h('div', { class: 'card-title' }, 'Options'),
    h('div', { class: 'sk-opt' }, h('b', null, 'Rotate through'),
      h('div', { class: 'sk-checks' }, PANELS.map(([k, label]) => check(label, OPTS.panels.includes(k), (v) => {
        OPTS.panels = PANELS.map(p => p[0]).filter(p => p === k ? v : OPTS.panels.includes(p));
        if (!OPTS.panels.length) OPTS.panels = [k];
      })))),
    h('div', { class: 'sk-opt' }, h('b', null, 'Seconds per panel'),
      h('select', { class: 'input', onchange: (e) => { OPTS.rotate = +e.target.value; draw(); } }, [10, 15, 20, 30, 60].map(v => h('option', { value: v, selected: v === OPTS.rotate || null }, `${v} seconds`)))),
    h('div', { class: 'sk-opt' }, h('b', null, 'Look'),
      h('div', { class: 'sk-checks' },
        check('Shade maps by projected final margin instead of the count', OPTS.odds, (v) => { OPTS.odds = v; }),
        check('Light background', OPTS.light, (v) => { OPTS.light = v; }))),
    h('div', { class: 'sk-opt' }, h('b', null, 'Rehearsal'),
      h('div', { class: 'sk-checks' }, check('Play a simulated election night at 10× speed (switch off before you go live)', OPTS.rehearse, (v) => { OPTS.rehearse = v; }))));

  root.append(
    h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, 'Stream kit'), h('h1', null, 'Ballot Desk on your live stream'),
      h('p', { class: 'dek' }, 'Full-screen scenes and overlays that update themselves all night: the balance of power, maps, key races, a ticker, and an alert whenever a race is projected. Add them to OBS Studio or Streamlabs as a Browser Source.')),
    h('div', { class: 'sk-grid' }, h('div', null, options, list), h('div', { class: 'sk-side' }, h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Preview'), frameBox,
      h('p', { class: 'xs muted', style: { margin: '10px 0 0' } }, 'Overlays are transparent, so the preview shows them on a checkerboard.')),
      h('div', { class: 'card sk-howto' }, h('div', { class: 'card-title' }, 'Set up in OBS or Streamlabs'),
        h('ol', null,
          h('li', null, 'Sources → ', h('b', null, '+'), ' → ', h('b', null, 'Browser'), '.'),
          h('li', null, 'Paste a scene’s address and set the width and height shown next to it.'),
          h('li', null, 'Leave “Shutdown source when not visible” off so it keeps updating between scenes.'),
          h('li', null, 'Put overlays above your camera; they are transparent everywhere else.')),
        h('p', { class: 'small', style: { margin: '10px 0 0' } }, h('b', null, 'TikTok: '), 'use the vertical scene at 1080 × 1920. ', h('b', null, 'YouTube: '), 'the landscape scene at 1920 × 1080.'),
        h('p', { class: 'small muted', style: { margin: '8px 0 0' } }, 'Rehearse with the simulation option, then copy the addresses again with it switched off. Counts come from the AP via The New York Times and projections are the AP’s; the scenes say so on screen.')))));
  draw();
}

export const title = () => 'Stream kit';
