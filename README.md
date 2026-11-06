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
                            model      ->  data/forecast.json  race probabilities, 1 million simulations
                                       ->  data/history.json   topline over time

Browser (index.html + assets/)
  reads data/*.json, then live:
    Polymarket CLOB midpoints        every 60 s (30 s on election night); last trades for closed markets
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

Every map shades a race by its margin on one scale (`MARGIN_BANDS` in `assets/js/ui.js`, colours `--dem-safe` etc.
in `app.css`): tilt under 1 point, lean 1–5, likely 5–15, safe 15+, darker for bigger margins in both themes. Before
results it is the final forecast's projected margin; on election night, the lead in the count, with stripes on
races still being counted and a check mark on projected states. The same scale shades counties and the simulator.

### Archive and swing map

`/archive/` lists every federal general election from 1976 to 2024 (an `index.html` in `archive/`, so `/archive/2024`
can sit beside it), and `/archive/2024` shows one: the presidential vote by state and, from 2000, by county; every
Senate race; and all 435 House seats with the popular vote. `/swing` compares any two presidential elections, in
either order, by county (2000 on) or state, as arrows (left toward Democrats, right toward Republicans, longer for a
bigger shift) or shading, with the choice in the address (`?from=2016&to=2020&level=states&style=shading`).

On election night the 2026 Senate and governor race pages can switch their county map to "Shift from 2024": each
county's margin for the Democrat (or an independent running against a Republican) against Harris's margin over Trump
(`view: 'shift'` in `countyMap()`, maps.js; the 2024 numbers are `data/geo/counties-2024.json`). Counties under 95% of
their expected vote are striped. A midterm can move much further than one presidential election from the next, so
that map picks its shift scale from the race's typical county (`shiftScaleFor()` in ui.js) and its key says which. Both are built from the
official returns compiled by the MIT Election Data and Science Lab (CC0, Harvard Dataverse) by
`pipeline/build_archive.mjs` (`npm run archive`), which writes `data/archive/` and the national county map
`data/geo/counties-us.json`. Run once; the output is committed and the GitHub Action never touches it.

The president and Senate files download directly, but the county and House files sit behind a Dataverse guestbook:
download `countypres_2000-2024.csv` (doi:10.7910/DVN/VOQCHQ) and `1976-2024-house.tab` (doi:10.7910/DVN/IG0UN2) in a
browser into `pipeline/.cache/archive/`. The build checks itself and stops on a mismatch: electoral votes from the
state results (House seats plus two, Maine's and Nebraska's split districts) must equal the official count once
faithless electors are added back, and House seats must match the official totals for 2008-2024. Known gaps in the
data are patched in the script with their sources: Louisiana's December runoffs (the file mixes the rounds), a few
Senate races missing or mislabelled (North Dakota 1980, North Carolina 1986, Illinois 2010, Connecticut 2022, from
the official results on Wikipedia), candidates listed without a party, and Kansas City's 2024 county code. Counties
are matched to today's map; Alaska (which reports by state House district) and Connecticut (whose counties became
planning regions in 2022) are shown as whole states, and states whose county returns don't add up to the official
state total are noted on the swing map.

### Forecast history before launch

The model went live late on November 1, so the forecast-history chart before its "Forecast went live" line is a
re-run: the same model, once a day back to June 6, on the inputs published by that day. Ratings and the
generic-ballot aggregates come from the Wikipedia pages' edit history (weekly snapshots, parsed with
`build_races.py`'s code), polls from VoteHub in the order it logged them (`created_at`, as of the end of each
day) and race prices from Polymarket's daily price history. Only the race list (this fall's nominees) and each
market's total volume come from hindsight. `data/backcast.json` also stores a check: the re-run at the moment of
the first live run, beside what the live model said. Rebuild: `python3 pipeline/backcast_inputs.py && node
pipeline/backcast.mjs` (the data bot never touches this file).

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

Chamber control comes from a million simulations (`MODEL.sims`) with correlated national, regional and state
errors, about 40 seconds a run; the final 2026 forecast, frozen on Nov. 3, ran 20,000. The backcast re-runs 100,000 a
day (`SIMS=` to change).
On election night the counted vote replaces the prior in proportion to the expected vote reported.
A national swing estimated from mostly counted races shifts the races still out, and AP calls are locked in.
The pre-election forecast freezes when the first polls close (6 p.m. ET), because markets then start
reacting to returns. The forecast pages (Forecast, Senate, House, Governors) and each race page's forecast card keep
showing that final forecast while results come in: the router sets `store.frozen` on those pages and `cur()`,
`chamber()` and the map colours return the frozen numbers. Polymarket prices stay live everywhere. The count and live
odds are on the live dashboard, the race pages' results card, the state pages and the broadcast.

Until each of the three results files has answered once (12 seconds at most), the live dashboard, race pages'
results card and the banner on every page draw placeholder shapes (`resultsLoading()` in live.js) instead of the
pre-results screen, which would otherwise flash the forecast's odds and "waiting for results" first. A file that
fails ends the placeholders straight away, so the page can say the feed isn't answering.

Polymarket closes a market's order book when the market resolves, and the midpoint API then has nothing for it. The
browser asks for those outcomes' last trades instead (`refreshMarkets()` in live.js): the outcome that last traded
near 1 won and the rest go to 0, since an empty book still reads 0.5. The race page's market card then says
"Trading closed".

While a race is counted, `catchUp()` in store.js works out what the runner-up needs of the votes left to draw level
(called races too, worded "would need", until the count puts them out of reach): AP's expected total vote (`total_expected_vote` in the feed) less the count, with other
candidates keeping their share. Races that need a majority (Georgia and Louisiana runoffs, Vermont) show what the
leader needs to stay above 50% instead, and Alaska's and Maine's ranked-choice races are about first choices. It
shows on the race page, race cards, map tooltips, the live results table and the broadcast. Being built on AP's
estimate of the votes left, it keeps one decimal.

Vote shares show two decimals (53.52%), and more where two numbers that matter would otherwise read the same:
`voteDigits()` in store.js (on `shareDigits()` in ui.js) adds decimals, up to six, until the top two candidates read
apart with at least one step of the last digit between them, so the margin never reads zero while the counts differ
(48.949% to 48.942%). Where second place goes to a runoff it also separates second from third, and where a majority
wins outright, the leader from 50%. Every view of a race uses the same count of decimals.

Louisiana's House races are all-party primaries with a December runoff (`race_type_id` 'L' in the feed). There,
`seatCount()` gives the live model, the map colours and the broadcast's tallies each party's combined vote, while the
tables show each candidate's own count. The race list's main candidates for LA-05 and LA-06 come from
`pipeline/overrides.json` (the leading Democrat and Republican in the count), since Wikipedia's lists gave the parser
no way to tell the contenders apart.

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

The site icon is `favicon.svg`. Search engines need an icon they can fetch from a real address (Google shows
none for one inlined as a `data:` URI), so `pipeline/build_icons.mjs` (`npm run icons`) draws the same shapes
into `favicon.ico` (16, 32 and 48 px), `icon-192.png` and `apple-touch-icon.png`. If the logo changes, change
both files, then run it and `npm run pages`.

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

## Outage fallback

`sw.js` is a service worker that keeps a copy of the site's own files in each visitor's browser. Requests still go
to the network first; the copy is used only when GitHub Pages fails or answers with a server error, as it can for a
few seconds while a deploy spreads (its "unicorn" page). It covers returning visitors, not a first visit. To switch
it off everywhere, replace `sw.js` with a file that calls `self.registration.unregister()`. The data bot commits
nothing after the first polls close, so the site is not redeployed overnight unless someone pushes.

## Terms and privacy

`/terms` and `/privacy` (`assets/js/views/legal.js`) describe what the site actually does: no accounts, cookies or
ads; three settings in local storage; requests to GitHub Pages, Polymarket and the NYT feed (fonts are self-hosted);
and visit counts once the counter below is switched on.
The Polymarket, NYT, donation and visit-counter parts follow `config.js`. If the site starts storing or sending
anything else (a new script, font host or data source), update both pages and their `UPDATED` date in the same change.

## Visitor counts

`assets/js/analytics.js` loads Cloudflare Web Analytics (no cookies or local storage, no fingerprinting) once
`analytics.cloudflareToken` in `config.js` holds the site token: in Cloudflare's dashboard, Web Analytics > Add a
site > `ballotdesk.org`, then copy the `token` from the JS snippet under Manage site. Empty means off, and the privacy
policy then says there is no analytics. It counts only on `analytics.host`, never on local copies, `/broadcast` (the
stream's OBS source) or browsers that send Do Not Track or Global Privacy Control. Page changes inside the app are
counted by the beacon itself (it follows the History API). Ad and tracker blockers stop it, so the counts are a floor.

## Data sources and licenses

| Data | Source | License |
|---|---|---|
| Candidates, incumbents, PVI, ratings, legislatures, ballot measures, generic-ballot and approval aggregates | Wikipedia | CC BY-SA 4.0 |
| Polls | VoteHub open polling API | CC BY 4.0 |
| Prediction markets | Polymarket Gamma + CLOB public APIs | Polymarket terms |
| Election-night counts and calls | AP via The New York Times public results JSON | Unofficial; see above |
| 2026 congressional district boundaries | U.S. Census Bureau TIGER/Line 2026 (`cd120`) + cartographic state outlines | Public domain |
| County boundaries | U.S. Census Bureau cartographic boundaries, 2025 | Public domain |
| Past results (archive and swing map): president by state and county, Senate, House | [MIT Election Data and Science Lab](https://electionlab.mit.edu/data), Harvard Dataverse; a few gaps from Wikipedia | CC0 (Wikipedia: CC BY-SA 4.0) |
| 2024 presidential vote by county | [tonmcg/US_County_Level_Election_Results_08-24](https://github.com/tonmcg/US_County_Level_Election_Results_08-24) | MIT |
| Election-night county results | AP via each race's NYT results file (fetched in the browser) | Unofficial; see above |
| Candidate photos | Lead images of the candidates' Wikipedia articles (Wikimedia Commons / Wikipedia), cropped | Each file's own: public domain, CC0, CC BY or CC BY-SA (listed on `/credits`) |
| State shapes | us-atlas (U.S. Census Bureau) | ISC / public domain |
| Fonts (Inter, Source Serif 4) | Google Fonts' files, self-hosted in `assets/fonts` | SIL Open Font License 1.1 (`OFL.txt` beside each) |

This is an independent project, not affiliated with any campaign, party or news organization.
Forecasts are probabilities, not predictions. Official results come from state election offices.
