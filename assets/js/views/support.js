// Support page: what keeping Ballot Desk running involves, and how to chip in.
import { h } from '../ui.js';
import { supportLinks } from '../config.js';

const HEART = 'M12 21s-7.5-4.6-9.6-9.3C.9 8.3 3 4.5 6.7 4.5c2.1 0 3.6 1.1 4.3 2.5h2c.7-1.4 2.2-2.5 4.3-2.5 3.7 0 5.8 3.8 4.3 7.2C19.5 16.4 12 21 12 21z';

/** Small heart icon used by the Support buttons. */
export function heart() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'heart');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', HEART);
  svg.appendChild(p);
  return svg;
}

export function render(root) {
  const links = supportLinks();
  const button = (l, i) => h('a', { class: `btn${i === 0 ? ' primary' : ''}`, href: l.url, target: '_blank', rel: 'noopener' },
    i === 0 ? heart() : null, `Donate on ${l.name}`, h('span', { 'aria-hidden': 'true' }, ' ↗'));
  root.append(
    h('header', { class: 'page-head' },
      h('div', { class: 'eyebrow' }, 'Support'),
      h('h1', null, 'Help keep Ballot Desk running'),
      h('p', { class: 'dek' }, 'Ballot Desk is free and independent, with no ads and no paywall. If it helped you follow the 2026 midterms, you can chip in toward the cost of keeping it going.')),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card support-card' },
        h('div', { class: 'card-title' }, 'Chip in'),
        links.length
          ? [h('p', { style: { marginTop: 0 } }, 'Any amount helps, once or now and then.'), h('div', { class: 'nf-links' }, links.map(button)),
            h('p', { class: 'xs muted', style: { margin: '14px 0 0' } }, 'Payments are handled by the donation service; Ballot Desk never sees your card details.')]
          : h('p', { class: 'muted', style: { margin: 0 } }, 'Donations aren’t open yet. Thanks for wanting to help!')),
      h('div', { class: 'card' },
        h('div', { class: 'card-title' }, 'What it goes toward'),
        h('ul', { class: 'support-list' },
          h('li', null, 'Running costs, like the ballotdesk.org domain'),
          h('li', null, 'Keeping polls, prices and live results flowing as sources change'),
          h('li', null, 'Time for new features and fixes, and for staying up through the count')))),
    h('div', { class: 'grid g2 section' },
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Other ways to help'),
        h('p', { style: { margin: 0 } }, 'Share Ballot Desk with anyone following the election. Spotted a mistake? ',
          h('a', { href: 'https://github.com/YutongHanOfficial/ballot-desk/issues', target: '_blank', rel: 'noopener' }, 'Report it on GitHub'), '.')),
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'The fine print'),
        h('p', { class: 'small', style: { margin: 0 } }, 'Ballot Desk is not affiliated with any campaign, party or news organization. Donations support the website only: they are not political contributions, are not tax-deductible, and have no effect on the forecast.'))));
}

export const title = () => 'Support';
