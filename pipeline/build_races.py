#!/usr/bin/env python3
"""Compile every race on the November 3, 2026 ballot into data/races.json.

Source: English Wikipedia (CC BY-SA 4.0), which aggregates candidate lists, incumbents, Cook PVI and
the published ratings of Cook, Inside Elections, Sabato's Crystal Ball and other forecasters.

Covers U.S. Senate (regular + specials), all 435 House seats, governors, lieutenant governors,
attorneys general, secretaries of state, state legislative chambers and statewide ballot measures.

Usage: python3 pipeline/build_races.py [--refresh]   (--refresh ignores the 6-hour page cache)
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wikitables import tables  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'pipeline', '.cache')
OUT = os.path.join(ROOT, 'data', 'races.json')
UA = 'Midterms2026Site/1.0 (static election site; data pipeline)'
CACHE_HOURS = 6

STATES = [
    ('AL', 'Alabama', '01', 'South'), ('AK', 'Alaska', '02', 'West'), ('AZ', 'Arizona', '04', 'West'),
    ('AR', 'Arkansas', '05', 'South'), ('CA', 'California', '06', 'West'), ('CO', 'Colorado', '08', 'West'),
    ('CT', 'Connecticut', '09', 'Northeast'), ('DE', 'Delaware', '10', 'South'), ('FL', 'Florida', '12', 'South'),
    ('GA', 'Georgia', '13', 'South'), ('HI', 'Hawaii', '15', 'West'), ('ID', 'Idaho', '16', 'West'),
    ('IL', 'Illinois', '17', 'Midwest'), ('IN', 'Indiana', '18', 'Midwest'), ('IA', 'Iowa', '19', 'Midwest'),
    ('KS', 'Kansas', '20', 'Midwest'), ('KY', 'Kentucky', '21', 'South'), ('LA', 'Louisiana', '22', 'South'),
    ('ME', 'Maine', '23', 'Northeast'), ('MD', 'Maryland', '24', 'South'), ('MA', 'Massachusetts', '25', 'Northeast'),
    ('MI', 'Michigan', '26', 'Midwest'), ('MN', 'Minnesota', '27', 'Midwest'), ('MS', 'Mississippi', '28', 'South'),
    ('MO', 'Missouri', '29', 'Midwest'), ('MT', 'Montana', '30', 'West'), ('NE', 'Nebraska', '31', 'Midwest'),
    ('NV', 'Nevada', '32', 'West'), ('NH', 'New Hampshire', '33', 'Northeast'), ('NJ', 'New Jersey', '34', 'Northeast'),
    ('NM', 'New Mexico', '35', 'West'), ('NY', 'New York', '36', 'Northeast'), ('NC', 'North Carolina', '37', 'South'),
    ('ND', 'North Dakota', '38', 'Midwest'), ('OH', 'Ohio', '39', 'Midwest'), ('OK', 'Oklahoma', '40', 'South'),
    ('OR', 'Oregon', '41', 'West'), ('PA', 'Pennsylvania', '42', 'Northeast'), ('RI', 'Rhode Island', '44', 'Northeast'),
    ('SC', 'South Carolina', '45', 'South'), ('SD', 'South Dakota', '46', 'Midwest'), ('TN', 'Tennessee', '47', 'South'),
    ('TX', 'Texas', '48', 'South'), ('UT', 'Utah', '49', 'West'), ('VT', 'Vermont', '50', 'Northeast'),
    ('VA', 'Virginia', '51', 'South'), ('WA', 'Washington', '53', 'West'), ('WV', 'West Virginia', '54', 'South'),
    ('WI', 'Wisconsin', '55', 'Midwest'), ('WY', 'Wyoming', '56', 'West'),
]
BY_NAME = {name: code for code, name, _, _ in STATES}

# Governors whose seats are not on the 2026 ballot (party of the sitting governor).
GOVERNORS_NOT_UP = {'DE': 'D', 'KY': 'D', 'NJ': 'D', 'NC': 'D', 'VA': 'D', 'WA': 'D',
                    'IN': 'R', 'LA': 'R', 'MS': 'R', 'MO': 'R', 'MT': 'R', 'ND': 'R', 'UT': 'R', 'WV': 'R'}

# Senate seats not on the ballot, by caucus (from "Before the elections": D31-D32 + I1-I2 not up -> 34 D caucus).
SENATE_NOT_UP = {'D': 34, 'R': 31}

PAGES = {
    'senate': '2026_United_States_Senate_elections',
    'house': '2026_United_States_House_of_Representatives_elections',
    'house_ratings': '2026_United_States_House_of_Representatives_election_ratings',
    'governor': '2026_United_States_gubernatorial_elections',
    'ltgov': '2026_United_States_lieutenant_gubernatorial_elections',
    'ag': '2026_United_States_attorney_general_elections',
    'sos': '2026_United_States_secretary_of_state_elections',
    'legislature': '2026_United_States_state_legislative_elections',
    'measures': '2026_United_States_ballot_measures',
    'approval': 'Opinion_polling_on_the_second_Trump_presidency',
}


def wiki(title, refresh=False):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, title + '.html')
    if not refresh and os.path.exists(path) and time.time() - os.path.getmtime(path) < CACHE_HOURS * 3600:
        with open(path, encoding='utf-8') as f:
            return f.read()
    q = urllib.parse.urlencode({'action': 'parse', 'page': title, 'prop': 'text', 'format': 'json',
                                'formatversion': 2, 'redirects': 1})
    req = urllib.request.Request('https://en.wikipedia.org/w/api.php?' + q, headers={'User-Agent': UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                data = json.load(r)
            break
        except Exception as e:  # network hiccup: back off and retry
            if attempt == 3:
                raise
            print(f'  retry {title}: {e}', file=sys.stderr)
            time.sleep(3 * (attempt + 1))
    html = data['parse']['text']
    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)
    return html


# ---------------------------------------------------------------- parsing helpers

PARTY_MAP = [
    (r'^(democratic|democrat|dfl|democratic[–-]npl|democratic[–-]farmer)', 'D'),
    (r'^republican', 'R'),
    (r'^independent|^nonpartisan|^no party|^unaffiliated|^unenrolled|^no labels|^forward|^serve america', 'I'),
    (r'^libertarian', 'L'),
    (r'^green|^mountain', 'G'),
]


def party_code(s):
    s = (s or '').strip().lower()
    for pat, code in PARTY_MAP:
        if re.search(pat, s):
            return code
    return 'O' if s else None


def lean(s):
    """Cook PVI text -> signed lean, Democratic positive ('R+7' -> -7, 'EVEN' -> 0)."""
    s = (s or '').strip().upper()
    if s.startswith('EVEN'):
        return 0
    m = re.match(r'([DR])\s*\+\s*(\d+)', s)
    if not m:
        return None
    return int(m.group(2)) * (1 if m.group(1) == 'D' else -1)


RATING_LEVEL = {'safe': 3, 'solid': 3, 'likely': 2, 'lean': 1, 'tilt': 0.5}


def rating(s):
    """'Lean D (flip)' -> {'label': 'Lean D', 'score': 1, 'side': 'D', 'flip': True}. Score is D-positive."""
    s = (s or '').strip()
    if not s or s in ('—', '–', '-', 'N/A'):
        return None
    flip = 'flip' in s.lower()
    base = re.sub(r'\(.*?\)', '', s).strip()
    low = base.lower()
    if low.startswith('toss') or low == 'tossup':
        return {'label': 'Toss-up', 'score': 0, 'side': None, 'flip': False}
    m = re.match(r'(safe|solid|likely|lean|tilt)\s+(.+)$', low)
    if not m:
        return None
    level = RATING_LEVEL[m.group(1)]
    who = m.group(2).strip()
    if who.startswith('d'):
        side = 'D'
    elif who.startswith('r'):
        side = 'R'
    elif who.startswith('i'):
        side = 'I'
    elif who.startswith('coal'):
        side = 'C'
    else:
        side = 'O'
    sign = -1 if side == 'R' else 1
    label = f"{m.group(1).capitalize()} {who.upper() if len(who) <= 2 else who.title()}"
    if side in ('D', 'R', 'I'):
        label = f"{m.group(1).capitalize()} {side}"
    return {'label': label, 'score': sign * level, 'side': side, 'flip': flip}


FORECASTER_ALIASES = {'Econ.': 'Econ', 'Sabato.': 'Sabato', 'State Nav': 'State Nav.'}


def forecaster(header):
    """'Cook / Oct 30, / 2026' (newline separated) -> ('Cook', 'Oct 30, 2026')."""
    parts = [p.strip() for p in header.split('\n') if p.strip()]
    if not parts:
        return None, None
    name = FORECASTER_ALIASES.get(parts[0], parts[0])
    return name, ' '.join(parts[1:]).replace(' ,', ',') or None


CAND_RE = re.compile(r'^(?P<name>.+?)\s*\((?P<party>[^()]*)\)\s*(?P<rest>.*)$')


def candidates(text):
    out = []
    for line in (text or '').split('\n'):
        line = line.replace('▌', '').strip()
        line = re.sub(r'\s*\[[^\]]*\]', '', line)
        if not line or line.lower().startswith(('tbd', 'tba', 'none', 'see ')):
            continue
        m = CAND_RE.match(line)
        if not m:
            continue
        name = m.group('name').strip(' ,')
        ptxt = m.group('party').strip()
        if re.search(r'\d', ptxt) and '%' in ptxt:
            continue
        write_in = 'write-in' in ptxt.lower() or 'write-in' in m.group('rest').lower()
        ptxt_clean = re.sub(r',?\s*write-in', '', ptxt, flags=re.I).strip()
        out.append({'name': name, 'party': party_code(ptxt_clean) or 'O', 'partyName': ptxt_clean or 'Write-in',
                    **({'writeIn': True} if write_in else {})})
    return out


def find_tables(tabs, heading, header_has=None):
    res = []
    for t in tabs:
        if heading is not None and (t['heading'] or '').strip() != heading:
            continue
        if header_has:
            head = ' '.join(' '.join(r) for r in t['rows'][:2])
            if not all(h in head for h in header_has):
                continue
        res.append(t)
    return res


def state_from(cell):
    first = cell.split('\n')[0].strip()
    first = re.sub(r'\s*\(.*$', '', first).strip()
    return BY_NAME.get(first)


def ratings_from(table, first_rating_col):
    """Map row-key -> {'forecasters': [...], 'ratings': {name: rating}} for a predictions table."""
    header = table['rows'][1]
    names = []
    for c in header[first_rating_col:]:
        n, d = forecaster(c)
        names.append((n, d))
    return names


def status_flags(status, member=''):
    s = (status or '').lower() + ' ' + (member or '').lower()
    open_seat = any(k in s for k in ('retiring', 'term-limited', 'term limited', 'lost renomination', 'resigned',
                                     'died', 'not seeking', 'new seat', 'retired', 'vacant', 'open seat',
                                     'to run for', 'lost nomination', 'withdrew', 'moved to'))
    if 'renominated' in s or 'advanced to general' in s or 'running for re-election' in s:
        open_seat = open_seat and 'renominated' not in s and 'advanced' not in s
    return open_seat


# ---------------------------------------------------------------- per-office parsers

def same_person(a, b):
    """Loose name match: same last name and same first initial ('Dan Sullivan' ~ 'Dan S. Sullivan')."""
    if not a or not b:
        return False
    pa, pb = re.sub(r'[^\w\s-]', '', a.lower()).split(), re.sub(r'[^\w\s-]', '', b.lower()).split()
    suf = {'jr', 'sr', 'ii', 'iii', 'iv'}
    pa = [x for x in pa if x not in suf]
    pb = [x for x in pb if x not in suf]
    return bool(pa and pb) and pa[-1] == pb[-1] and pa[0][0] == pb[0][0]


def pick_side(cands, party, incumbent_name=None, prefer=None):
    pool = [c for c in cands if c['party'] == party and not c.get('writeIn')]
    if not pool:
        return None
    for want in (prefer, incumbent_name):
        if not want:
            continue
        exact = [c for c in pool if c['name'].lower() == want.lower()]
        if exact:
            return exact[0]
        loose = [c for c in pool if same_person(c['name'], want)]
        if len(loose) == 1:
            return loose[0]
    return pool[0]


def parse_statewide(tabs, office, summary_heading, header_has, pred_heading='Predictions'):
    """Generic parser for governor / Lt. gov / AG / SoS pages: summary table + optional predictions."""
    races = {}
    for t in find_tables(tabs, summary_heading, header_has):
        hdr = [h.split('\n')[0] for h in t['rows'][0]]
        for row in t['rows'][1:]:
            st = state_from(row[0])
            if not st or len(row) < 6:
                continue
            col = {h: i for i, h in enumerate(hdr)}
            holder_name = row[1].split('\n')[0]
            holder_party = party_code(row[2])
            status = row[col.get('Status', 5)] if col.get('Status', 5) < len(row) else ''
            cands = candidates(row[-1])
            races[st] = {
                'id': f'{st}-{office.upper()}', 'type': office, 'state': st,
                'incumbent': {'name': holder_name, 'party': holder_party},
                'holder': holder_party, 'status': status, 'open': status_flags(status),
                'lastResult': row[col['Last race']] if 'Last race' in col else None,
                'candidates': cands,
            }
    preds = find_tables(tabs, pred_heading, ['Ratings'])
    if preds:
        t = preds[0]
        names = ratings_from(t, 4)
        for row in t['rows'][2:]:
            st = state_from(row[0])
            if not st or st not in races:
                continue
            races[st]['pvi'] = lean(row[1])
            rs = {}
            for (n, d), v in zip(names, row[4:]):
                r = rating(v)
                if n and r:
                    rs[n] = r
            races[st]['ratings'] = rs
            races[st]['ratingDates'] = {n: d for n, d in names if n}
    return races


def parse_senate(html):
    tabs = tables(html)
    races = {}
    regular = find_tables(tabs, 'Elections leading to the next Congress')[0]
    for row in regular['rows'][2:]:
        st = state_from(row[0])
        if not st:
            continue
        status = row[6]
        races[f'{st}-SEN'] = {
            'id': f'{st}-SEN', 'type': 'senate', 'state': st, 'special': False, 'class': 2,
            'pvi': lean(row[1]), 'incumbent': {'name': row[2].split('\n')[0], 'party': party_code(row[3])},
            'holder': party_code(row[3]), 'status': status.replace('\n', ' '), 'open': status_flags(status),
            'lastResult': row[5], 'candidates': candidates(row[7]),
        }
    for t in find_tables(tabs, 'Special elections during the preceding Congress'):
        for row in t['rows'][2:]:
            st = state_from(row[0])
            if not st:
                continue
            status = row[5]
            races[f'{st}-SEN'] = {
                'id': f'{st}-SEN', 'type': 'senate', 'state': st, 'special': True, 'class': 3,
                'pvi': lean(row[1]), 'incumbent': {'name': row[2].split('\n')[0], 'party': party_code(row[3])},
                'holder': party_code(row[3]), 'status': status.replace('\n', ' '), 'open': status_flags(status),
                'lastResult': None, 'candidates': candidates(row[6]),
            }
    pred = find_tables(tabs, 'Predictions', ['Ratings'])[0]
    names = ratings_from(pred, 4)
    for row in pred['rows'][2:]:
        st = state_from(row[0])
        if not st:
            continue
        rid = f'{st}-SEN'
        if rid not in races:
            continue
        rs = {}
        for (n, d), v in zip(names, row[4:]):
            r = rating(v)
            if n and r:
                rs[n] = r
        races[rid]['ratings'] = rs
        races[rid]['ratingDates'] = {n: d for n, d in names if n}
        if races[rid]['lastResult'] is None:
            races[rid]['lastResult'] = row[3].replace('\n', ' ')
    return races


def district_id(loc):
    """'Arizona 1' -> ('AZ', 1); 'Alaska at-large' -> ('AK', 0)."""
    loc = loc.split('\n')[0].strip()
    m = re.match(r'^(.+?)\s+(\d+|at-large|at large|AL)$', loc, flags=re.I)
    if not m:
        return None, None
    st = BY_NAME.get(m.group(1).strip())
    d = m.group(2)
    return st, (0 if not d.isdigit() else int(d))


def rid_house(st, d):
    return f'{st}-{d:02d}' if d else f'{st}-AL'


def parse_house(html, ratings_html):
    tabs = tables(html)
    races = {}
    for t in tabs:
        if not t['rows'] or len(t['rows']) < 3:
            continue
        head0 = ' '.join(t['rows'][0])
        if 'District' not in head0 or 'Candidates' not in head0 or 'Incumbent' not in head0:
            continue
        head = [h.replace('\n', ' ') for h in t['rows'][1]]

        def col(*names):
            for i, h in enumerate(head):
                if any(n.lower() in h.lower() for n in names):
                    return i
            return None
        c_loc, c_pvi, c_mem, c_party = col('Location'), col('PVI'), col('Member'), col('Party')
        c_first, c_status, c_cand = col('First'), col('Status'), col('Candidates')
        if c_loc is None or c_cand is None:
            continue
        for row in t['rows'][2:]:
            st, d = district_id(row[c_loc])
            if not st:
                continue
            rid = rid_house(st, d)
            member = row[c_mem].split('\n')[0] if c_mem is not None else ''
            mparty = party_code(row[c_party]) if c_party is not None else None
            status = row[c_status].replace('\n', ' ') if c_status is not None else ''
            new_seat = 'new seat' in (status + ' ' + member).lower() or member.lower() in ('', 'none', 'vacant')
            vacated = None
            if new_seat or mparty not in ('D', 'R', 'I'):
                m = re.search(r'\((D|R|I)\)\s+(resigned|died|vacated|was expelled)', status)
                if m:
                    vacated = m.group(1)
            if rid in races:  # multiple incumbents share a redrawn seat: keep both names
                races[rid]['incumbents'].append({'name': member, 'party': mparty, 'status': status})
                continue
            races[rid] = {
                'id': rid, 'type': 'house', 'state': st, 'district': d,
                'pvi': lean(row[c_pvi]) if c_pvi is not None else None,
                'incumbent': None if new_seat else {'name': member, 'party': mparty},
                'incumbents': [] if new_seat else [{'name': member, 'party': mparty, 'status': status}],
                'holder': vacated or (None if new_seat else mparty),
                **({'vacant': True} if vacated else {}),
                'firstElected': row[c_first].replace('\n', ' ') if c_first is not None else None,
                'status': status, 'open': new_seat or status_flags(status),
                'candidates': candidates(row[c_cand]),
            }
    rt = find_tables(tables(ratings_html), 'Latest published ratings for competitive seats')[0]
    names = ratings_from(rt, 4)
    for row in rt['rows'][2:]:
        st, d = district_id(row[0])
        if not st:
            continue
        rid = rid_house(st, d)
        if rid not in races:
            continue
        rs = {}
        for (n, dt), v in zip(names, row[4:]):
            r = rating(v)
            if n and r:
                rs[n] = r
        races[rid]['ratings'] = rs
        races[rid]['ratingDates'] = {n: dt for n, dt in names if n}
        races[rid]['lastResult'] = row[3].replace('\n', ' ')
        if races[rid]['pvi'] is None:
            races[rid]['pvi'] = lean(row[1])
    return races


def parse_legislatures(html):
    tabs = tables(html)
    chambers = {}
    pred = find_tables(tabs, 'Electoral predictions')
    if pred:
        t = pred[0]
        names = [forecaster(h) for h in t['rows'][0][4:]]
        for row in t['rows'][1:]:
            st = state_from(row[0])
            if not st:
                continue
            ch = row[2].split('\n')[0].strip()
            key = f'{st}-{"UPPER" if ch.lower() in ("senate", "upper") else "LOWER" if ch.lower() in ("house", "assembly", "house of delegates", "house of representatives", "lower") else ch.upper()}'
            rs = {}
            for (n, d), v in zip(names, row[4:]):
                r = rating(v)
                if n and r:
                    rs[n] = r
            chambers[key] = {'id': key, 'state': st, 'chamber': ch, 'last': row[3].replace('\n', ' '),
                             'pvi': lean(row[1]), 'ratings': rs,
                             'ratingDates': {n: d for n, d in names if n}}
    seats = find_tables(tabs, 'States', ['Upper house', 'Lower house'])
    if seats:
        for row in seats[0]['rows'][2:]:
            st = state_from(row[0])
            if not st:
                continue
            for i, kind in ((1, 'UPPER'), (5, 'LOWER')):
                key = f'{st}-{kind}'
                try:
                    up, total = int(re.sub(r'\D', '', row[i]) or 0), int(re.sub(r'\D', '', row[i + 1]) or 0)
                except (ValueError, IndexError):
                    continue
                if key in chambers:
                    chambers[key].update({'seatsUp': up, 'seatsTotal': total})
                elif up:
                    chambers[key] = {'id': key, 'state': st, 'chamber': 'Senate' if kind == 'UPPER' else 'House',
                                     'seatsUp': up, 'seatsTotal': total, 'ratings': {}}
    return chambers


def parse_measures(html):
    tabs = tables(html)
    out = []
    for t in tabs:
        if not t['rows']:
            continue
        hdr = [h.split('\n')[0] for h in t['rows'][0]]
        if not ('Measure' in hdr and 'Status' in hdr and 'Date' in hdr):
            continue
        st = BY_NAME.get((t['heading'] or '').strip())
        if not st:
            continue
        ci = {h: i for i, h in enumerate(hdr)}
        for row in t['rows'][1:]:
            date = row[ci['Date']]
            if 'Nov' not in date or '3' not in date:
                continue
            name = row[ci['Measure']].replace('\n', ' ').strip()
            out.append({
                'state': st, 'name': name, 'origin': row[ci.get('Origin', 0)],
                'status': row[ci['Status']], 'description': row[ci.get('Description (Result of a "yes" vote)', 3)].replace('\n', ' '),
                'options': [h for h in hdr[ci['Date'] + 1:]],
            })
    return out


def pct_value(s):
    m = re.search(r'(-?\d+(?:\.\d+)?)\s*%', (s or '').replace('−', '-'))
    return float(m.group(1)) if m else None


def parse_generic(html):
    """Generic-ballot aggregates (DDHQ, FiftyPlusOne, ...) as listed on the House elections page."""
    out = []
    for t in find_tables(tables(html), 'Generic congressional ballot aggregate polls'):
        hdr = [x.replace('\n', ' ') for x in t['rows'][0]]
        ci = {h: i for i, h in enumerate(hdr)}
        for row in t['rows'][1:]:
            d = pct_value(row[ci.get('Democrats', 4)]) if 'Democrats' in ci else None
            r = pct_value(row[ci.get('Republicans', 3)]) if 'Republicans' in ci else None
            if d is None or r is None:
                continue
            out.append({'source': row[0].replace('\n', ' '), 'updated': row[ci.get('Dates updated', 2)].replace('\n', ' '),
                        'd': d, 'r': r, 'margin': round(d - r, 2)})
        break
    return out


def parse_approval(html):
    out = []
    for t in find_tables(tables(html), 'Approval', ['Aggregator']):
        hdr = [x.replace('\n', ' ') for x in t['rows'][0]]
        ci = {h: i for i, h in enumerate(hdr)}
        for row in t['rows'][1:]:
            a, dis = pct_value(row[ci.get('Approve', 2)]), pct_value(row[ci.get('Disapprove', 3)])
            if a is None or dis is None:
                continue
            out.append({'source': row[0].replace('\n', ' '), 'updated': row[ci.get('Updated', 1)], 'approve': a, 'disapprove': dis})
        break
    return out


# ---------------------------------------------------------------- assemble

def finalize(race, overrides):
    ov = overrides.get(race['id'], {})
    cands = race.get('candidates') or []
    inc = race.get('incumbent') or {}
    inc_name = inc.get('name')
    for c in cands:
        if inc_name and same_person(c['name'], inc_name) and c['party'] == inc.get('party'):
            c['incumbent'] = True
    if ov.get('incumbentCandidate'):
        for c in cands:
            c.pop('incumbent', None)
            if c['name'] == ov['incumbentCandidate']:
                c['incumbent'] = True
    d = pick_side(cands, 'D', inc_name, ov.get('left'))
    r = pick_side(cands, 'R', inc_name, ov.get('right'))
    i = pick_side(cands, 'I', inc_name, ov.get('left') or ov.get('right'))
    rs = race.get('ratings') or {}
    i_rated = any(v['side'] == 'I' for v in rs.values())
    i_strong = bool(i) and (i.get('incumbent') or i_rated)
    left, right = d, r
    if i and not d and (r or i_strong):
        left = i                      # independent is the main opponent of the Republican
    elif i_strong and d and not r:
        right = i                     # independent (often an ex-Republican) against a Democrat
    elif i and i_rated and d and r:
        left = i                      # ratings say the independent is the real challenger
    if ov.get('left'):
        left = next((c for c in cands if c['name'] == ov['left']), left)
    if ov.get('right'):
        right = next((c for c in cands if c['name'] == ov['right']), right)
    race['left'] = left['name'] if left else None
    race['right'] = right['name'] if right else None
    race['leftParty'] = left['party'] if left else None
    race['rightParty'] = right['party'] if right else None
    same = None
    if not left and not right:
        same = None
    elif not right and left and len([c for c in cands if c['party'] == left['party']]) >= 2:
        same = left['party']
    elif not left and right and len([c for c in cands if c['party'] == right['party']]) >= 2:
        same = right['party']
    race['samePartyGeneral'] = same
    if ov.get('note'):
        race['note'] = ov['note']
    scores = [v['score'] for v in rs.values() if v.get('side') in ('D', 'R', 'I', None)]
    race['ratingScore'] = round(sum(scores) / len(scores), 3) if scores else None
    return race


FREEZE_AT = datetime(2026, 11, 3, 23, 0, tzinfo=timezone.utc)  # first polls close; Wikipedia fills with results


def main():
    if datetime.now(timezone.utc) >= FREEZE_AT and not os.environ.get('FORCE'):
        print('polls have started closing: race list is frozen (set FORCE=1 to override)')
        return
    refresh = '--refresh' in sys.argv
    html = {k: wiki(v, refresh) for k, v in PAGES.items()}
    print('fetched', ', '.join(f'{k} {len(v) // 1024}KB' for k, v in html.items()))

    senate = parse_senate(html['senate'])
    house = parse_house(html['house'], html['house_ratings'])
    gov = parse_statewide(tables(html['governor']), 'gov', 'States', ['Governor', 'Candidates'])
    ltgov = parse_statewide(tables(html['ltgov']), 'ltgov', 'Race summary', ['Candidates'])
    ag = parse_statewide(tables(html['ag']), 'ag', 'States', ['Candidates'])
    sos = parse_statewide(tables(html['sos']), 'sos', 'Race summary', ['Candidates'])
    legis = parse_legislatures(html['legislature'])
    measures = parse_measures(html['measures'])

    ov_path = os.path.join(ROOT, 'pipeline', 'overrides.json')
    overrides = json.load(open(ov_path, encoding='utf-8')) if os.path.exists(ov_path) else {}
    overrides = {k: v for k, v in overrides.items() if not k.startswith('_')}
    races = []
    for group in (senate.values(), house.values(), gov.values(), ltgov.values(), ag.values(), sos.values()):
        for r in group:
            races.append(finalize(r, overrides))

    gov_holders = {r['state']: r['holder'] for r in gov.values()}
    house_holders = {}
    for r in house.values():
        if r['holder']:
            house_holders[r['holder']] = house_holders.get(r['holder'], 0) + 1

    out = {
        'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'electionDate': '2026-11-03',
        'source': 'Wikipedia (CC BY-SA 4.0): ' + ', '.join(
            f'https://en.wikipedia.org/wiki/{v}' for v in PAGES.values()),
        'states': [{'code': c, 'name': n, 'fips': f, 'region': g} for c, n, f, g in STATES],
        'chambers': {
            'senate': {'seats': 100, 'notUp': SENATE_NOT_UP, 'majority': 51, 'tiebreak': 'R',
                       'tiebreakNote': 'Vice President JD Vance (R) breaks 50-50 ties.'},
            'house': {'seats': 435, 'majority': 218, 'current': house_holders},
            'governors': {'seats': 50, 'notUp': GOVERNORS_NOT_UP, 'majority': 26},
        },
        'national': {'generic': parse_generic(html['house']), 'approval': parse_approval(html['approval'])},
        'races': races,
        'legislatures': list(legis.values()),
        'measures': measures,
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))

    by = {}
    for r in races:
        by[r['type']] = by.get(r['type'], 0) + 1
    print('races:', by, '| legislatures:', len(legis), '| measures:', len(measures),
          '| generic aggregates:', len(out['national']['generic']), '| approval aggregates:', len(out['national']['approval']))
    print('house holders:', house_holders, '| governor holders up:',
          {p: list(gov_holders.values()).count(p) for p in set(gov_holders.values())})
    missing = [r['id'] for r in races if r['type'] in ('senate', 'house', 'gov') and not (r['left'] or r['right'])]
    if missing:
        print('WARNING no major candidates:', missing[:20], len(missing))


if __name__ == '__main__':
    main()
