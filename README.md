# Ballot Desk

**Forecast, live results and simulations for the 2026 U.S. midterms.** A static website covering every race on the November 3, 2026 ballot:
35 Senate races (including the Ohio and Florida specials), all 435 House seats, 36 governors,
lieutenant governors, attorneys general, secretaries of state, 88 state legislative chambers and
144 statewide ballot measures.

It runs for free on **GitHub Pages**. A **GitHub Action** refreshes the data, and each visitor's
browser pulls live prediction-market prices and election-night vote counts directly, so the
site needs no server.

## How it works

```
GitHub Action (about every 20 min until the polls close)
  pipeline/build_races.py   Wikipedia  ->  data/races.json     candidates, incumbents, Cook PVI, ratings (every 6 h)
  pipeline/refresh.mjs      VoteHub    ->  data/polls.json     every public poll, weighted averages
                            Polymarket ->  data/markets.json   ~530 race markets + chamber control
                            model      ->  data/forecast.json  race probabilities, 20,000 simulations
                                       ->  data/history.json   topline over time

Browser (index.html + assets/)
  reads data/*.json, then live:
    Polymarket CLOB midpoints        every 60 s
    AP vote counts (NYT results JSON) every 30-120 s during the election window
  and re-runs the projection model (assets/js/model.js) on every update
```

The model code in `assets/js/model.js` runs both in the pipeline (Node) and in the browser, so the
pre-election forecast and the election-night projection use the same math.

### Simulator

`assets/js/sim.js` draws one correlated outcome from the forecast (`drawMargins` in `model.js`). For the
election-night replay it also gives every race a turnout, its state's real poll-closing time, a counting
pace and an early-vote skew (so leads can shift), then projects races the way a decision desk does: safe
seats at poll close, the rest once the live model is 99.7% sure. Results are a pure function of
(scenario, time), so the timeline can be scrubbed. While a replay runs, the whole site reads its simulated
results through the same code path as the real election night.

### Maps

The House maps use the Census Bureau's TIGER/Line 2026 congressional districts (the 120th Congress lines
used in this election, including the mid-decade redraws), clipped to the coastline. `pipeline/build_geo.mjs`
turns them into:

- `data/geo/districts-2026.json`: all 435 districts for the national map (zoomable, click a state to zoom in)
- `data/geo/cd/XX.json`: each state at higher detail, for state pages and the district locator on race pages
- `data/geo/house-hex.json`: the equal-size hexagon map, laid out automatically from district locations
- `data/geo/counties/XX.json` + `data/geo/counties-2024.json`: county maps and the 2024 presidential vote by county

They are built once and committed. To rebuild: `npm install && npm run geo` (needs `unzip`).

### The model

Each race comes down to the expected margin between its two leading candidates. Four signals estimate
it and are combined by inverse-variance weighting:

- **Fundamentals:** 2 × Cook PVI + the national environment (the average of the generic-ballot trackers) + incumbency
- **Polls:** VoteHub polls of the matchup, weighted by recency (12-day half-life), sample size and population, with repeat polls from one pollster down-weighted
- **Ratings:** Cook, Inside Elections, Sabato, Economist, Split Ticket, DDHQ, FiftyPlusOne, Silver Bulletin and others, each mapped to a probability and then to a margin
- **Markets:** Polymarket prices, discounted when thinly traded

Chamber control comes from 20,000 simulations with correlated national, regional and state errors.
On election night the counted vote replaces the prior in proportion to the expected vote reported.
A national swing estimated from mostly counted races shifts the races still out, and AP calls are locked in.
The pre-election forecast freezes when the first polls close (6 p.m. ET), because markets then start
reacting to returns.

## Running locally

```bash
python3 pipeline/build_races.py      # candidates and ratings from Wikipedia (cached 6 h; --refresh to force)
node pipeline/refresh.mjs            # polls + markets + model -> data/*.json  (~20 s)
python3 pipeline/serve.py            # open http://localhost:8026
```

Requires Python 3.9+ and Node 20+. No packages to install.

Useful URL switches:

- `#/simulate`: the simulator (quick outcomes, or a full election-night replay with playback controls)
- `?demo=live`: starts a simulated election night immediately
- `?results=on` / `?results=off`: force the live results feed on or off

## Deploying (GitHub Pages)

1. Push this folder to a GitHub repository.
2. **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root.**
3. **Actions → Refresh forecast data → Run workflow** starts the refresh loop. It re-launches itself
   every ~6 hours until the polls close. A cron watchdog also refreshes every 30 minutes.

## Configuration

`assets/js/config.js` holds the poll-closing times, refresh intervals and the results provider.

`results.provider: 'nyt'` reads the public results JSON that The New York Times publishes (AP data),
directly in each visitor's browser and only during the election window. It is an undocumented feed,
not a licensed API: set `provider: 'none'` to turn it off. The site then shows the forecast and live
Polymarket prices without vote counts.

`pipeline/overrides.json` corrects anything the Wikipedia parser gets wrong (e.g. the two Dan Sullivans in Alaska).

## Data sources and licenses

| Data | Source | License |
|---|---|---|
| Candidates, incumbents, PVI, ratings, legislatures, ballot measures, generic-ballot and approval aggregates | Wikipedia | CC BY-SA 4.0 |
| Polls | VoteHub open polling API | CC BY 4.0 |
| Prediction markets | Polymarket Gamma + CLOB public APIs | Polymarket terms |
| Election-night counts and calls | AP via The New York Times public results JSON | Unofficial; see above |
| 2026 congressional district boundaries | U.S. Census Bureau TIGER/Line 2026 (`cd120`) + cartographic state outlines | Public domain |
| County boundaries | U.S. Census Bureau cartographic boundaries, 2025 | Public domain |
| 2024 presidential vote by county | [tonmcg/US_County_Level_Election_Results_08-24](https://github.com/tonmcg/US_County_Level_Election_Results_08-24) | MIT |
| Election-night county results | AP via each race's NYT results file (fetched in the browser) | Unofficial; see above |
| State shapes | us-atlas (U.S. Census Bureau) | ISC / public domain |

This is an independent project, not affiliated with any campaign, party or news organization.
Forecasts are probabilities, not predictions. Official results come from state election offices.
