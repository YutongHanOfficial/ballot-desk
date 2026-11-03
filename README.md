# Ballot Desk

**Forecast, live results and simulations for the 2026 U.S. midterms.** A static website covering every race on the November 3, 2026 ballot:
35 Senate races (including the Ohio and Florida specials), all 435 House seats, 36 governors,
lieutenant governors, attorneys general, secretaries of state, 88 state legislative chambers and
144 statewide ballot measures.

Live at **https://ballotdesk.org**. It runs for free on **GitHub Pages**. A **GitHub Action** refreshes the data, and each visitor's
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
- `data/geo/house-hex.json`: the equal-size hexagon map, a cartogram of the states (each sized by its House seats) cut into one hexagon per district (`pipeline/hex_layout.mjs`; `npm run hex` rebuilds just this file)
- `data/geo/counties/XX.json` + `data/geo/counties-2024.json`: county maps and the 2024 presidential vote by county

They are built once and committed. To rebuild: `npm install && npm run geo` (needs `unzip`).

### Forecast history before launch

The model went live late on November 1, so the forecast-history chart's dashed lead-in is a re-run: the same model,
once a day back to June 6, on the inputs published by that day. Ratings and the generic-ballot aggregates come
from the Wikipedia pages' edit history (weekly snapshots, parsed with `build_races.py`'s code), polls from
VoteHub in the order it logged them (`created_at`, counted from the next day) and race prices from Polymarket's
daily price history. Only the race list (this fall's nominees) and each market's total volume come from
hindsight. `data/backcast.json` also stores a check: the re-run at the moment of the first live run, beside what
the live model said. Rebuild: `python3 pipeline/backcast_inputs.py && node pipeline/backcast.mjs` (the data bot
never touches this file).

### Candidate photos

Headshots are the lead images of the candidates' English Wikipedia articles. The article comes from the link on
the candidate's name in the race's own Wikipedia table (`wiki` on each candidate in `races.json`), never from a
name search, and must be about a person (Wikidata: instance of human). Only freely licensed images are used
(public domain, CC0, CC BY, CC BY-SA). `pipeline/facecrop.swift` (macOS Vision) crops a square around the face
and rejects anything without exactly one clear, large enough face, so a logo or group photo never stands in for
a candidate. Output: `assets/img/people/*.jpg` (192px) and `data/photos.json`; every photo is credited on its
race page, on `/credits` and, on the broadcast, on screen. Rebuild on a Mac: `python3 pipeline/build_photos.py`.

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

Useful addresses and switches:

- `/simulate`: the simulator (quick outcomes, or a full election-night replay with playback controls)
- `?demo=live`: starts a simulated election night immediately
- `?results=on` / `?results=off`: force the live results feed on or off (`?results=on` also shows the
  election-night front page)

## Live streams

`/stream` is a kit for streaming election night on YouTube or TikTok: scenes and overlays to add to OBS Studio
or Streamlabs as Browser Sources (`/broadcast`, 1920×1080; `/broadcast?format=vertical`, 1080×1920; transparent
`?overlay=scoreboard|ticker|alerts`). They update themselves, rotate through maps and key races, and flash an
alert when a race is projected. `?demo=live&speed=10` rehearses on a simulated night.

## Addresses

Pages have plain addresses (`/live`, `/state/PA`, `/race/GA-SEN`). The app is one page that switches views
with the History API; so that every address also loads directly, `pipeline/build_pages.mjs` writes a copy of
`index.html` for each one (`live.html`, `state/PA.html`, `race/GA-SEN.html`, …) with its own title and
link-preview text, plus `sitemap.xml`. **After editing `index.html`, run `npm run pages`** and commit the
result. `404.html` sends other spellings (`/pennsylvania`, `/pa-07`) to the right page and shows a not-found
page for anything else. Old `/#/…` links are rewritten to plain addresses when they load.

## Deploying (GitHub Pages)

1. Push this folder to a GitHub repository.
2. **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root.**
3. **Actions → Refresh forecast data → Run workflow** starts the refresh loop. It re-launches itself
   every ~6 hours until the polls close. A cron watchdog also refreshes every 30 minutes.

## Configuration

`assets/js/config.js` holds the poll-closing times, refresh intervals and the results provider.

**Donations:** add your donation pages to `support.links` in `assets/js/config.js` (for example
`{ name: 'Ko-fi', url: 'https://ko-fi.com/yourname' }`). That turns on a Support button in the header, a line in
the footer, a dismissible note on the live and forecast pages, and the `/support` page. With no links, none of it
shows.

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
| Candidate photos | Lead images of the candidates' Wikipedia articles (Wikimedia Commons / Wikipedia), cropped | Each file's own: public domain, CC0, CC BY or CC BY-SA (listed on `/credits`) |
| State shapes | us-atlas (U.S. Census Bureau) | ISC / public domain |

This is an independent project, not affiliated with any campaign, party or news organization.
Forecasts are probabilities, not predictions. Official results come from state election offices.
