import { h, num, timeAgo } from '../ui.js';
import { store } from '../store.js';
import { MODEL } from '../model.js';

export function render(root) {
  const f = store.forecast;
  const p = (...kids) => h('p', null, ...kids);
  const a = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  root.append(h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, 'Methodology'), h('h1', null, 'How the forecast works'),
    h('p', { class: 'dek' }, `Model ${MODEL.version}. Last run ${timeAgo(f.updated)}, ${num(f.sims)} simulations.`)),
  h('div', { class: 'prose' },
    h('h2', null, 'One number per race'),
    p('Every race is boiled down to the expected margin between its two leading candidates. Usually that is the Democrat and the Republican; where an independent is the main opposition (Dan Osborn in Nebraska, for example), the independent takes the Democratic side of the ledger. The top two are chosen from Polymarket prices and polls, so a minor nominee never displaces the real contender.'),
    h('h2', null, 'Four signals'),
    h('ul', null,
      h('li', null, h('b', null, 'Fundamentals. '), 'Twice the Cook Partisan Voting Index (PVI is a share gap; doubling it gives a margin) plus the national environment from the generic-ballot average, plus a few points for an incumbent running.'),
      h('li', null, h('b', null, 'Polls. '), `A weighted average of every public poll of the matchup in the VoteHub database. Weights fall by half every ${MODEL.pollHalfLife} days, grow with sample size, favor likely-voter samples, halve for partisan or internal polls, and halve again for each older poll from the same pollster.`),
      h('li', null, h('b', null, 'Expert ratings. '), 'Up to twelve forecasters (Cook, Inside Elections, Sabato’s Crystal Ball, The Economist, Split Ticket, Decision Desk HQ, FiftyPlusOne, Silver Bulletin and others). Each rating maps to a win probability: Toss-up 50%, Tilt 60%, Lean 72%, Likely 88%, Safe 98.5%. The average becomes a margin.'),
      h('li', null, h('b', null, 'Prediction markets. '), 'The Polymarket price of the leading candidate, read as a probability and turned into a margin. Thinly traded markets count for less.')),
    p('Each signal is an estimate of the margin with its own uncertainty, and the forecast is their precision-weighted average. Because the signals overlap (forecasters read the same polls traders do), the combined uncertainty is inflated and never drops below about five points for a single race. When ratings or markets sit at their ceiling ("Safe", 99 cents), they only say a race is lopsided, so partisan lean sets how lopsided.'),
    h('h2', null, 'Simulating the election'),
    p(`The model plays out the election ${num(MODEL.sims)} times. Each simulation draws a national polling error (standard deviation ${MODEL.natSd} points) shared by every race, a regional error for each Census region (${MODEL.regSd}), a state error shared by every race in a state (${MODEL.stateSd}), and race-specific noise. That correlation matters: if polls underestimate one party in Ohio, they probably did in Michigan too.`),
    p('Democrats need 51 Senate seats, because Vice President JD Vance breaks ties, and 218 House seats. Independents count for neither party. The tipping-point race is the one that delivers the deciding seat when races are lined up from most to least Democratic.'),
    h('h2', null, 'Election night'),
    p('Once votes are reported, each race’s projection becomes a blend of the counted margin and the pre-election forecast, weighted by the share of the expected vote still out. Uncounted ballots get extra uncertainty, since mail, early and Election Day votes often lean differently. Across races that are at least 60% counted, the median gap between results and the forecast becomes a national swing applied to everything still uncounted. Races called by the AP are locked in. Chamber odds are then re-simulated in your browser.'),
    h('h2', null, 'Data sources'),
    h('ul', null,
      h('li', null, h('b', null, 'Candidates, incumbents, partisan lean and ratings: '), a('https://en.wikipedia.org/wiki/2026_United_States_elections', 'Wikipedia'), ' (CC BY-SA 4.0), which compiles Cook PVI and the forecasters’ published ratings.'),
      h('li', null, h('b', null, 'Polls: '), a('https://votehub.com/polls', 'VoteHub'), ' open polling API (CC BY 4.0).'),
      h('li', null, h('b', null, 'Prediction markets: '), a('https://polymarket.com', 'Polymarket'), ' public Gamma and CLOB APIs. Prices update live in your browser.'),
      h('li', null, h('b', null, 'Election-night results: '), 'Associated Press vote counts and race calls, read from the public results files The New York Times publishes, fetched directly by your browser. This is an unofficial use of an undocumented feed; official results come from each state’s election office.'),
      h('li', null, h('b', null, 'District maps: '), 'the Census Bureau’s ', a('https://www2.census.gov/geo/tiger/TIGER2026/CD/', 'TIGER/Line 2026 congressional districts'), ' (the lines in use for this election, including the mid-decade redraws), clipped to the coastline. The equal-size map gives every district one hexagon, arranged automatically from where the districts are.'),
      h('li', null, h('b', null, 'State maps: '), a('https://github.com/topojson/us-atlas', 'us-atlas'), ' (U.S. Census Bureau boundaries).')),
    h('h2', null, 'Update schedule'),
    p('A GitHub Action re-runs the pipeline about every 20 minutes: it pulls polls and markets, recomputes the forecast and publishes the data files. Candidate lists and ratings are rebuilt from Wikipedia every six hours. When the first polls close at 6 p.m. Eastern on Nov. 3, the pre-election forecast is frozen, because markets start reacting to returns and would double count them. From then on your browser does the work: market prices refresh every minute, vote counts every 30 seconds to 2 minutes, and the live model re-runs on every update.'),
    h('h2', null, 'Caveats'),
    p('This is an independent, automated project, not affiliated with any news organization or campaign. Forecasts are probabilities, not predictions: a 75% favorite loses one time in four. Prediction-market prices reflect traders’ money, not voters. Always check official results with your state’s election office.')));
}

export const title = () => 'Methodology';
