#!/usr/bin/env python3
"""Point-in-time inputs for the forecast backcast (pipeline/backcast.mjs).

Forecaster ratings and the generic-ballot aggregates as Wikipedia showed them on each date: for every
snapshot date, the last revision of each source page at or before noon UTC is parsed with the same code
that builds races.json (build_races.py), so a June snapshot holds exactly the June ratings.

Writes pipeline/.cache/backcast/snapshots.json. Usage: python3 pipeline/backcast_inputs.py
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_races as B  # noqa: E402

UA = 'BallotDesk/1.0 (https://ballotdesk.org; https://github.com/YutongHanOfficial/ballot-desk)'
API = 'https://en.wikipedia.org/w/api.php'
DIR = os.path.join(B.CACHE, 'backcast')
REVS = os.path.join(DIR, 'revs')
FIRST, LAST = date(2026, 6, 6), date(2026, 11, 1)   # the chart's Polymarket history starts June 6
STEP = 7                                            # days between snapshots; ratings change a few times a week at most


def get(params):
    q = urllib.parse.urlencode({'format': 'json', 'formatversion': 2, **params})
    req = urllib.request.Request(f'{API}?{q}', headers={'User-Agent': UA})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # network hiccup or throttling: back off and retry
            if attempt == 4:
                raise
            print(f'  retry ({e})', file=sys.stderr)
            time.sleep(4 * (attempt + 1))


def revision_at(title, when):
    """The id of the last revision of a page at or before `when` (ISO time)."""
    d = get({'action': 'query', 'prop': 'revisions', 'rvprop': 'ids|timestamp', 'rvlimit': 1, 'rvdir': 'older',
             'rvstart': when, 'titles': title})
    rev = d['query']['pages'][0]['revisions'][0]
    return rev['revid'], rev['timestamp']


def revision_html(revid):
    path = os.path.join(REVS, f'{revid}.html')
    if os.path.exists(path):
        return open(path, encoding='utf-8').read()
    html = get({'action': 'parse', 'oldid': revid, 'prop': 'text'})['parse']['text']
    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)
    time.sleep(0.5)
    return html


def generic_aggregates(html):
    """build_races.parse_generic, also finding the table under its earlier heading ("Opinion polling", until the summer)."""
    out = B.parse_generic(html)
    if out:
        return out
    for t in B.tables(html):
        hdr = [x.replace('\n', ' ') for x in (t['rows'][0] if t['rows'] else [])]
        if not hdr or not hdr[0].startswith('Source of poll') or 'Democrats' not in hdr or 'Republicans' not in hdr:
            continue
        ci = {h: i for i, h in enumerate(hdr)}
        for row in t['rows'][1:]:
            d, r = B.pct_value(row[ci['Democrats']]), B.pct_value(row[ci['Republicans']])
            if d is None or r is None:
                continue
            out.append({'source': row[0].replace('\n', ' '), 'updated': row[ci.get('Dates updated', 2)].replace('\n', ' '),
                        'd': d, 'r': r, 'margin': round(d - r, 2)})
        if out:
            break
    return out


def main():
    os.makedirs(REVS, exist_ok=True)
    whens = []
    d = FIRST
    while d <= LAST:
        whens.append(f'{d.isoformat()}T12:00:00Z')
        d += timedelta(days=STEP)
    # One more at the moment of the live model's first run, for backcast.mjs's check against it.
    first_live = json.load(open(os.path.join(B.ROOT, 'data', 'history.json'), encoding='utf-8'))['points'][0]['t']
    whens.append(first_live[:19] + 'Z')
    snaps = []
    for when in whens:
        revs, html = {}, {}
        for key in ('senate', 'house', 'house_ratings'):
            revid, ts = revision_at(B.PAGES[key], when)
            revs[key] = {'rev': revid, 'at': ts}
            html[key] = revision_html(revid)
        snap = {'at': when, 'revs': revs, 'ratings': {}, 'generic': [], 'errors': []}
        try:
            for rid, r in B.parse_senate(html['senate']).items():
                snap['ratings'][rid] = r.get('ratings') or {}
        except Exception as e:  # an older layout the parser does not know: leave the gap, say so
            snap['errors'].append(f'senate: {e!r}')
        try:
            for rid, r in B.parse_house(html['house'], html['house_ratings']).items():
                snap['ratings'][rid] = r.get('ratings') or {}
        except Exception as e:
            snap['errors'].append(f'house: {e!r}')
        try:
            snap['generic'] = generic_aggregates(html['house'])
        except Exception as e:
            snap['errors'].append(f'generic: {e!r}')
        rated = sum(1 for v in snap['ratings'].values() if v)
        print(f"{when[:16]}: {rated} rated races, {len(snap['generic'])} generic aggregates"
              f"{'; ' + '; '.join(snap['errors']) if snap['errors'] else ''}", flush=True)
        snaps.append(snap)
    with open(os.path.join(DIR, 'snapshots.json'), 'w', encoding='utf-8') as f:
        json.dump({'step': STEP, 'snapshots': snaps}, f, ensure_ascii=False)
    print(f'wrote {len(snaps)} snapshots')


if __name__ == '__main__':
    main()
