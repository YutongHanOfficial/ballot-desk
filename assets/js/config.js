// Site settings. Edit and redeploy; no build step.
export const CONFIG = {
  siteName: 'Midterms 2026',
  electionDay: '2026-11-03',
  firstPollsClose: '2026-11-03T23:00:00Z',   // 6 p.m. Eastern (parts of Indiana and Kentucky)
  lastPollsClose: '2026-11-04T06:00:00Z',    // 1 a.m. Eastern (western Aleutians)

  // Precomputed data written by the GitHub Action (pipeline/refresh.mjs). Re-read every few minutes.
  dataRefreshSec: 300,

  // Live prediction-market prices straight from Polymarket's public API (CORS-enabled, no key).
  markets: { enabled: true, refreshSec: 60 },

  // Live vote counts. 'nyt' reads the public results JSON The New York Times publishes (AP data) directly in each
  // visitor's browser during the election window. It is an undocumented feed, not a licensed API: set
  // provider to 'none' to turn it off. ?results=off / ?results=on in the URL overrides this per visit.
  results: {
    provider: 'nyt',
    window: { start: '2026-11-03T21:00:00Z', end: '2026-11-15T00:00:00Z' },
    urls: {
      senate: 'https://static01.nyt.com/elections-assets/pages/data/2026-11-03/results-senate.json',
      gov: 'https://static01.nyt.com/elections-assets/pages/data/2026-11-03/results-governor.json',
      house: 'https://static01.nyt.com/elections-assets/pages/data/2026-11-03/results-house.json',
    },
    refreshSec: { senate: 30, gov: 45, house: 120 },
  },

  liveSims: 6000,
};

// When the last polls close in each state (Eastern time, Nov 3 2026). States split across time zones use the
// time when most of the state's polls close; the first polls close an hour earlier there.
export const POLL_CLOSE_ET = {
  KY: '6:00', IN: '6:00',
  GA: '7:00', SC: '7:00', VT: '7:00', VA: '7:00', FL: '7:00', NH: '7:00',
  NC: '7:30', OH: '7:30', WV: '7:30',
  AL: '8:00', CT: '8:00', DE: '8:00', IL: '8:00', ME: '8:00', MD: '8:00', MA: '8:00', MS: '8:00', MO: '8:00',
  NJ: '8:00', OK: '8:00', PA: '8:00', RI: '8:00', TN: '8:00', TX: '8:00', MI: '8:00', KS: '8:00', DC: '8:00',
  AR: '8:30',
  AZ: '9:00', CO: '9:00', LA: '9:00', MN: '9:00', NE: '9:00', NM: '9:00', NY: '9:00', ND: '9:00', SD: '9:00',
  WI: '9:00', WY: '9:00',
  IA: '10:00', MT: '10:00', NV: '10:00', UT: '10:00', ID: '10:00',
  CA: '11:00', OR: '11:00', WA: '11:00',
  HI: '12:00', AK: '1:00',
};

/** Poll closing time as a Date (Nov 3, 2026 evening ET = UTC-5 after DST ends). */
export function pollCloseDate(state) {
  const t = POLL_CLOSE_ET[state];
  if (!t) return null;
  let [h, m] = t.split(':').map(Number);
  // Times listed are p.m. except 12:00 (midnight) and 1:00 (a.m. next day).
  const addDay = h === 12 || h === 1;
  const hour24 = h === 12 ? 0 : h === 1 ? 1 : h + 12;
  const d = new Date(Date.UTC(2026, 10, addDay ? 4 : 3, hour24 + 5, m));
  return d;
}
