// Visit counting with Cloudflare Web Analytics, which uses no cookies or local storage and doesn't fingerprint
// visitors or follow them across sites. Off until config.js has the site's token. The privacy policy
// (views/legal.js) describes it from analyticsOn(), so the page and the site can't disagree about it.
import { CONFIG } from './config.js';

export const analyticsOn = () => !!CONFIG.analytics?.cloudflareToken;

/** The browser has asked not to be tracked (Do Not Track, or Global Privacy Control). */
export const optedOut = () => navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1';

/**
 * Load Cloudflare's beacon once, on the public site only: not on local copies, not on /broadcast (the stream's OBS
 * source is not a visitor) and not for browsers that opt out. The beacon follows the History API, so page changes
 * inside the app are counted without a hook in the router. This is the form Cloudflare gives for a script added by
 * code: a module, with the token in its address (developers.cloudflare.com/web-analytics/faq).
 */
export function startAnalytics() {
  const a = CONFIG.analytics || {};
  if (!a.cloudflareToken || location.hostname !== a.host || location.pathname === '/broadcast' || optedOut()) return;
  if (document.querySelector('script[data-visit-counter]')) return;
  const s = document.createElement('script');
  s.type = 'module';
  s.src = `https://static.cloudflareinsights.com/beacon.min.js?token=${encodeURIComponent(a.cloudflareToken)}`;
  s.dataset.visitCounter = '';
  document.head.appendChild(s);
}
