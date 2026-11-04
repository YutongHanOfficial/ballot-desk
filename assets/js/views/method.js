import { h, num, timeAgo } from '../ui.js';
import { store } from '../store.js';
import { MODEL } from '../model.js';

/** How the re-run part of the forecast-history chart was made, with the check against the live model. */
function backcastText() {
  const b = store.backcast;
  if (!b?.points?.length) return h('p', null, 'The forecast’s history starts when the model went live.');
  const pc = (x) => `${Math.round(x * 100)}%`;
  const day = (t) => new Date(t).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const from = day(b.points[0].t);
  const live = day(b.check?.t || store.history.points?.[0]?.t || b.points.at(-1).t);
  return [
    h('p', null, `The forecast went live on ${live}. To show how it would have moved before then, the same model was re-run for every day back to ${from}, each time using only what had been published by that day: the forecasters’ ratings and the generic-ballot aggregates as Wikipedia listed them then (weekly snapshots from the pages’ edit history), the polls VoteHub had logged by the end of that day, and each race’s Polymarket price at the end of that day. That is the forecast-history chart up to its “Forecast went live” line.`),
    h('p', null, 'Two inputs come from hindsight: the candidates (this fall’s nominees are used throughout, including before some primaries were held) and each market’s total trading volume, which sets how much its price counts. ',
      b.check ? `As a check, re-running it for the moment of the model’s first live run gives ${pc(b.check.sen)} for Democratic control of the Senate and ${pc(b.check.house)} for the House; the live run said ${pc(b.check.liveSen)} and ${pc(b.check.liveHouse)}.` : ''),
  ];
}

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
    h('h2', null, 'Two candidates from one party'),
    p('California’s top-two primary sometimes sends two Democrats or two Republicans to November. The party keeps the seat either way, so these races count as settled for control, but we still forecast who wins: Polymarket’s market on the two candidates, nudged slightly toward the edge incumbents usually have in these races (about 3 in 4). With no market, that incumbent edge alone sets the odds. On election night the count between the two takes over, as in any other race.'),
    h('h2', null, 'Election night'),
    p('Once votes are reported, each race’s projection becomes a blend of the counted margin and the pre-election forecast, weighted by the share of the expected vote still out. Uncounted ballots get extra uncertainty, since mail, early and Election Day votes often lean differently. Across races that are at least 60% counted, the median gap between results and the forecast becomes a national swing applied to everything still uncounted. Races called by the AP are locked in. Chamber odds are then re-simulated in your browser.'),
    p('For a race still being counted, the results show what the trailing candidate needs of the votes left to pull even. Votes left is the AP’s estimate of the total vote, less the votes counted so far, and other candidates are assumed to keep their share. Where a winner needs a majority (Georgia’s and Louisiana’s runoff rules, Vermont), it shows what the leader needs to stay above 50% instead. In Alaska and Maine, which use ranked-choice voting, it is about first choices.'),
    h('h2', null, 'The simulator'),
    p('A quick simulation draws one outcome using exactly the errors the forecast uses: one national polling miss (or one you choose), plus regional, state and race-level misses. That way a surprise in Ohio tends to come with surprises in Michigan and Pennsylvania.'),
    p('Statewide races in the replay are counted county by county: each county starts from its 2024 presidential lean, shifted to the simulated statewide result with some county-level noise, and gets its own reporting pace (big urban counties tend to finish later) and its own early-vote skew. The statewide totals are the sum of the counties, so the county maps fill in exactly as the totals move.'),
    p('The election-night replay adds the mechanics of a count. Each race gets a turnout and the real poll-closing time for its state. Each state gets a counting pace (Florida reports almost everything within hours; California counts for days) and an "early-vote skew": the first ballots counted often lean one way, so early leads can shrink or flip. Races are projected the way a decision desk works, at poll closing for safe seats, otherwise only when the live model is at least 99.7% sure. Ranked-choice races in Alaska and Maine wait for tabulation, Georgia sends races under 50% to a runoff, and anything within half a point goes to a likely recount. All of it is simulated: none of these numbers are real results.'),
    h('h2', { id: 'backcast' }, 'The forecast before it went live'),
    backcastText(),
    h('h2', null, 'Data sources'),
    h('ul', null,
      h('li', null, h('b', null, 'Candidates, incumbents, partisan lean and ratings: '), a('https://en.wikipedia.org/wiki/2026_United_States_elections', 'Wikipedia'), ' (CC BY-SA 4.0), which compiles Cook PVI and the forecasters’ published ratings.'),
      h('li', null, h('b', null, 'Polls: '), a('https://votehub.com/polls', 'VoteHub'), ' open polling API (CC BY 4.0).'),
      h('li', null, h('b', null, 'Prediction markets: '), a('https://polymarket.com', 'Polymarket'), ' public Gamma and CLOB APIs. Prices update live in your browser, on the forecast pages too. When a market resolves and trading closes, its final price is shown.'),
      h('li', null, h('b', null, 'Election-night results: '), 'Associated Press vote counts and race calls, read from the public results files The New York Times publishes, fetched directly by your browser. This is an unofficial use of an undocumented feed; official results come from each state’s election office.'),
      h('li', null, h('b', null, 'District maps: '), 'the Census Bureau’s ', a('https://www2.census.gov/geo/tiger/TIGER2026/CD/', 'TIGER/Line 2026 congressional districts'), ' (the lines in use for this election, including the mid-decade redraws), clipped to the coastline. The equal-size map gives every district one hexagon, arranged automatically from where the districts are.'),
      h('li', null, h('b', null, 'County maps: '), 'Census Bureau 2025 cartographic county boundaries, with the 2024 presidential vote by county from ', a('https://github.com/tonmcg/US_County_Level_Election_Results_08-24', 'tonmcg/US_County_Level_Election_Results_08-24'), ' (MIT licence). On election night, counties switch to live AP counts from each race’s New York Times results file as soon as it is published. Alaska reports by state House district, so it has no county map.'),
      h('li', null, h('b', null, 'State maps: '), a('https://github.com/topojson/us-atlas', 'us-atlas'), ' (U.S. Census Bureau boundaries).')),
    h('h2', null, 'Update schedule'),
    p('A GitHub Action re-runs the pipeline about every 20 minutes: it pulls polls and markets, recomputes the forecast and publishes the data files, which open pages pick up within a minute. Candidate lists and ratings are rebuilt from Wikipedia every six hours. When the first polls close at 6 p.m. Eastern on Nov. 3, the pre-election forecast is frozen, because markets start reacting to returns and would double count them. From then on your browser does the work: market prices refresh every minute, vote counts every 30 seconds to 2 minutes, and the live model re-runs on every update.'),
    h('h2', null, 'Caveats'),
    p('This is an independent, automated project, not affiliated with any news organization or campaign. Forecasts are probabilities, not predictions: a 75% favorite loses one time in four. Prediction-market prices reflect traders’ money, not voters. Always check official results with your state’s election office.')));
}

export const title = () => 'Methodology';
