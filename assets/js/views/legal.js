// Terms of service and privacy policy, in plain language. Both describe what the site actually does (index.html,
// store.js, live.js, analytics.js, config.js): when that changes, update them and bump UPDATED.
import { h, fmtDate } from '../ui.js';
import { CONFIG, supportLinks } from '../config.js';
import { analyticsOn } from '../analytics.js';

// The visit counter's paragraphs appear only once it is switched on, so the date moves with them.
const UPDATED = analyticsOn() ? 'November 4, 2026' : 'November 3, 2026';
const CONTACT = 'https://github.com/YutongHanOfficial/ballot-desk/issues';
const POLICIES = {
  pages: 'https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages#data-collection',
  github: 'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement',
  polymarket: 'https://polymarket.com/privacy',
  nyt: 'https://www.nytimes.com/privacy/privacy-policy',
  cloudflare: 'https://www.cloudflare.com/privacypolicy/',
  cloudflareAnalytics: 'https://www.cloudflare.com/web-analytics/',
};

const p = (...kids) => h('p', null, ...kids);
const ext = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
const listOf = (items) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

function head(title, dek) {
  return h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, 'About'), h('h1', null, title), h('p', { class: 'dek' }, dek));
}

const contact = () => [h('h2', null, 'Contact'),
  p('Questions about these pages: ', ext(CONTACT, 'open an issue on GitHub'), '. Issues are public, so leave out anything private.')];

// Donation platforms, named once a donation page is set up in config.js.
function donors() {
  const names = supportLinks().map(l => l.name);
  if (!names.length) return null;
  const one = names.length === 1;
  return { names: listOf(names), its: one ? 'its' : 'their', handles: one ? 'handles' : 'handle', shows: one ? 'it shows' : 'they show' };
}

export function renderTerms(root) {
  const d = donors();
  root.append(head('Terms of service', `Last updated ${UPDATED}. By using Ballot Desk you agree to these terms, so they’re written to be read.`),
    h('div', { class: 'prose' },
      h('h2', null, 'What Ballot Desk is'),
      p('Ballot Desk is an independent website with forecasts, live results and maps for the 2026 U.S. midterm elections. It is free, with no accounts and no ads, and it is not affiliated with any campaign, party, government agency, news organization or prediction market.'),
      h('h2', null, 'Forecasts are probabilities'),
      p('Our forecasts come from a statistical model, explained in ', h('a', { href: '/methodology' }, 'How the forecast works'), '. A 75% chance means the other outcome should happen about one time in four. Forecasts can be wrong, and they change as new information comes in.'),
      h('h2', null, 'Results are unofficial'),
      p('Vote counts and race calls come from the Associated Press, read from public results files published by The New York Times, and are shown as received. They can be late, incomplete or wrong, and they change as counting goes on. Official results come only from state and local election officials. Check with them for anything that matters, including where, when and how to vote.'),
      h('h2', null, 'Not advice'),
      p('Nothing on Ballot Desk is financial, betting, legal or voting advice. Polymarket prices are shown for information only. We don’t endorse Polymarket or any prediction market, and trading on one may be illegal where you live.'),
      h('h2', null, 'Using the site'),
      p('You’re welcome to read Ballot Desk, link to it and share screenshots with credit. Please don’t:'),
      h('ul', null,
        h('li', null, 'present our forecasts or results as official, or use them to mislead anyone about voting;'),
        h('li', null, 'download pages or data so heavily or so often that it slows the site down for everyone else;'),
        h('li', null, 'try to break into, overload or interfere with the site.')),
      p('To republish our forecasts or data, or to use them commercially, ask first.'),
      h('h2', null, 'Content from others'),
      p('Candidate lists and ratings come from Wikipedia (CC BY-SA 4.0), polls from VoteHub (CC BY 4.0), district maps from the U.S. Census Bureau, prices from Polymarket and vote counts from the AP through The New York Times. Candidate photos come from Wikipedia under their own free licenses and are credited on the ', h('a', { href: '/credits' }, 'photo credits'), ' page. That material belongs to its owners and is used under their terms. The rest of the site, including its text, design, code and forecasts, is ours.'),
      h('h2', null, 'Links to other sites'),
      p('We link to other websites, such as Wikipedia, VoteHub and Polymarket. We don’t control them and aren’t responsible for them; their own terms apply.'),
      d ? [h('h2', null, 'Donations'),
        p(`Donations are voluntary gifts that help keep the site running. They aren’t tax-deductible, don’t buy anything and never affect the forecast. ${d.names} ${d.handles} the payment under ${d.its} own terms.`)] : null,
      h('h2', null, 'No warranty'),
      p('Ballot Desk is provided as is, without warranties of any kind. We work to keep it accurate and online, but we can’t promise it will be correct, complete, current or available at any given moment, election night included.'),
      h('h2', null, 'Limits on liability'),
      p('To the fullest extent the law allows, we aren’t liable for any loss or damage that comes from using Ballot Desk, or from not being able to use it, including anything you decide based on it. Some places don’t allow these limits, so they may not all apply to you.'),
      h('h2', null, 'Changes'),
      p('We may update these terms. The date at the top shows the current version, and using the site after a change means you accept the new terms. The ', h('a', { href: '/privacy' }, 'privacy policy'), ` explains what happens to your data (in short, ${analyticsOn() ? 'we count visits, but collect nothing that identifies you' : 'we don’t collect any'}).`),
      ...contact()));
}

export function renderPrivacy(root) {
  const d = donors();
  const counted = analyticsOn();
  const kept = ['your light or dark theme', 'the House map view you picked'];
  if (d) kept.push('whether you closed the note asking for support');
  const day = (iso, year) => fmtDate(iso, { month: 'long', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
  const services = [
    h('li', null, h('b', null, 'GitHub Pages'), ' hosts the site. GitHub logs visitors’ IP addresses for security (', ext(POLICIES.pages, 'GitHub’s note'), ', ', ext(POLICIES.github, 'privacy statement'), ').'),
    CONFIG.markets.enabled ? h('li', null, h('b', null, 'Polymarket'), ` supplies live market prices, checked every ${CONFIG.markets.nightRefreshSec} to ${CONFIG.markets.refreshSec} seconds while a page is open (`, ext(POLICIES.polymarket, 'privacy policy'), ').') : null,
    CONFIG.results.provider === 'nyt' ? h('li', null, h('b', null, 'The New York Times'), ` supplies live vote counts from ${day(CONFIG.results.window.start)} to ${day(CONFIG.results.window.end, true)} (`, ext(POLICIES.nyt, 'privacy policy'), ').') : null,
    counted ? h('li', null, h('b', null, 'Cloudflare Web Analytics'), ' counts visits, as described above (', ext(POLICIES.cloudflare, 'privacy policy'), ').') : null,
  ];
  root.append(head('Privacy policy', counted
    ? `Last updated ${UPDATED}. The short version: Ballot Desk has no accounts, cookies or ads. It counts visits, but nothing it records identifies you, and it doesn’t sell or share personal information.`
    : `Last updated ${UPDATED}. The short version: Ballot Desk has no accounts, cookies, analytics or ads, and it doesn’t collect, sell or share personal information.`),
    h('div', { class: 'prose' },
      h('h2', null, 'What we collect'),
      counted
        ? [p('Nothing that identifies you. There is no sign-up, no contact form, no cookies and no advertising code.'),
          p('To see how many people use the site and what they read, we count visits with ', ext(POLICIES.cloudflareAnalytics, 'Cloudflare Web Analytics'), '. For each page you open, it records the page’s address (without anything after a “?”), the site that linked you here, your browser, operating system and type of device, your country, and how quickly the page loaded. It doesn’t use cookies or local storage, and Cloudflare says it doesn’t fingerprint visitors or follow them across websites. We see only totals, such as visits per day or the most-read pages, never a record of any one person.')]
        : p('Nothing that identifies you. There is no sign-up, no contact form, no cookies and no analytics or advertising code, so we don’t know who visits or what they look at.'),
      h('h2', null, 'What your browser keeps'),
      p(`A few settings are saved in your browser’s local storage so the site remembers them: ${listOf(kept)}. They stay on your device, are never sent to us, and you can clear them at any time in your browser’s settings.`),
      p('Your browser also keeps a copy of the site’s own pages, code and data, so Ballot Desk still opens if our host has a brief outage. The copy holds nothing about you, is refreshed as you browse, and goes away when you clear the site’s data.'),
      h('h2', null, 'Services your browser connects to'),
      p('To show the site and keep it live, your browser connects directly to these services. As with any website, each one receives your IP address and basic details such as your browser type, and may keep logs under its own privacy policy:'),
      h('ul', null, services),
      p('Ballot Desk itself sends these services nothing about you beyond what your browser includes in each request.'),
      h('h2', null, 'Links to other sites'),
      p('When you follow a link to another site, such as a candidate’s Wikipedia article, that site’s privacy policy applies.'),
      d ? [h('h2', null, 'Donations'),
        p(`If you donate, ${d.names} ${d.handles} your payment and details under ${d.its} own privacy policy. We see only what ${d.shows} creators, such as your name and any message you leave, and use that only to say thank you.`)] : null,
      h('h2', null, 'Children'),
      p('Ballot Desk is for a general audience and isn’t aimed at children under 13. We don’t collect personal information from anyone, children included.'),
      h('h2', null, 'Do Not Track'),
      p(counted
        ? 'If your browser sends Do Not Track or Global Privacy Control, the site doesn’t load the visit counter, so your visit isn’t counted at all.'
        : 'Ballot Desk doesn’t track you, so there is nothing for Do Not Track or Global Privacy Control to switch off.'),
      h('h2', null, 'Changes'),
      p('If what the site does with data changes, this page changes first, with a new date at the top. See also the ', h('a', { href: '/terms' }, 'terms of service'), '.'),
      ...contact()));
}

export const termsTitle = () => 'Terms of service';
export const privacyTitle = () => 'Privacy policy';
