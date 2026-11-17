#!/usr/bin/env python3
"""Politician profiles: who they are, and every race of theirs in the archive.

A profile is a person with an English Wikipedia article who appears in the site's data: a member of the House or
Senate from 1977 on, a presidential candidate (1788-2024), a Senate nominee in the archive's years (1976-2024), or a
2026 candidate. As with the photos (build_photos.py), a person is tied to a result through a link or a seat, never a
bare name:
- House and Senate winners, 1976-2024: Wikidata's record of who held that seat in the Congress that followed
  (position held, with the district or seat and the Congress), checked against the winner's surname.
- Senate nominees, winners or not: the links in the infobox of Wikipedia's "YEAR United States Senate election in
  STATE" article. Presidential candidates: the links in each presidential election article's infobox.
- 2026 candidates: the link on their name in the race tables (data/races.json).
The one exception: once a person is known, their other House and Senate runs in a state where they ran or served are
found by name (same state, same surname, a first name Wikidata knows them by, an age at which they could run).

About each person, from Wikidata (CC0): born, died, party, offices held. From Wikipedia (CC BY-SA): the first
sentences of the article, credited on the page. A photo only where data/photos.json already has one.

Output:
  data/people/index.json      everyone, for the people page and search: [{s, n, d, st, y}]
  data/people/p/<slug>.json   one profile
  data/people/years/<y>.json  the names on each archive year page (and 2026's race pages) that have a profile
Slugs come from the article title, so a profile's address is stable and unique.

Usage: python3 pipeline/build_people.py [--refresh]
Network replies are cached in pipeline/.cache/people/ (--refresh starts over). Run after `npm run archive`.
"""
import glob
import hashlib
import html
import http.client
import json
import os
import re
import shutil
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'pipeline', '.cache', 'people')
OUT = os.path.join(ROOT, 'data', 'people')
UA = 'BallotDesk/1.0 (https://ballotdesk.org; https://github.com/YutongHanOfficial/ballot-desk)'
REFRESH = '--refresh' in sys.argv

STATES = {
    'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California', 'CO': 'Colorado', 'CT': 'Connecticut',
    'DE': 'Delaware', 'DC': 'District of Columbia', 'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii', 'ID': 'Idaho', 'IL': 'Illinois',
    'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland',
    'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi', 'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska',
    'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York', 'NC': 'North Carolina',
    'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island',
    'SC': 'South Carolina', 'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia',
    'WA': 'Washington', 'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming',
}
CODE = {v: k for k, v in STATES.items()}
congress_of = lambda year: (year - 1789) // 2 + 1          # the Congress sitting on Jan 3 of an odd year
next_congress = lambda election: congress_of(election + 1)  # the Congress chosen in an even-year election


def log(*a):
    print(*a, flush=True)


# ------------------------------------------------------------------------------------------- network, cached

def fetch(url, data=None, accept='application/json'):
    key = hashlib.sha1((url + '\n' + (data or '')).encode()).hexdigest()
    path = os.path.join(CACHE, key + '.json')
    if not REFRESH and os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    body = data.encode() if data is not None else None
    for attempt in range(6):
        req = urllib.request.Request(url, data=body, headers={'User-Agent': UA, 'Accept': accept})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                out = json.load(r)
            break
        except json.JSONDecodeError:
            # The query service cuts a reply short when a query runs out of time partway through sending it.
            if attempt < 5:
                time.sleep(5 * (attempt + 1))
                continue
            raise
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 5:
                time.sleep(int(e.headers.get('Retry-After') or 0) or 5 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError, http.client.HTTPException, ConnectionError):
            # A dropped connection (RemoteDisconnected, IncompleteRead) or a timeout: wait and ask again.
            if attempt < 5:
                time.sleep(3 * (attempt + 1))
                continue
            raise
    os.makedirs(CACHE, exist_ok=True)
    with open(path, 'w') as f:
        json.dump(out, f)
    time.sleep(0.3)   # be gentle with Wikimedia: only uncached requests wait
    return out


def sparql(query):
    out = fetch('https://query.wikidata.org/sparql', urllib.parse.urlencode({'query': query}), 'application/sparql-results+json')
    return [{k: v['value'] for k, v in row.items()} for row in out['results']['bindings']]


def wp(params):
    q = urllib.parse.urlencode({**params, 'format': 'json', 'formatversion': 2})
    return fetch('https://en.wikipedia.org/w/api.php?' + q)


qid_of = lambda uri: uri.rsplit('/', 1)[-1]


def isodate(v):
    """A Wikidata date as 'YYYY-MM-DD...', or '' for none. "Unknown value" comes back as a made-up address
    (http://www.wikidata.org/.well-known/genid/...), not a date."""
    return v if v and re.match(r'^\d{4}-\d\d-\d\d', v) else ''


def chunks(xs, n):
    xs = list(xs)
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def stable_batches(keys, buckets, most):
    """Batches that stay the same from run to run: each key always lands in the same one of a fixed number of
    buckets (split into sorted chunks of at most `most`), so a few new people change a few cached requests, not all."""
    out = {}
    for k in sorted(set(keys)):
        out.setdefault(int(hashlib.sha1(k.encode()).hexdigest()[:8], 16) % buckets, []).append(k)
    for b in sorted(out):
        yield from chunks(out[b], most)


# ------------------------------------------------------------------------------------------- names

SUFFIX = {'jr', 'sr', 'ii', 'iii', 'iv', 'v'}


def fold(s):
    return unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()


def tokens(name):
    """Name words, lowercase and unaccented, without suffixes (Jr., III) or bracketed asides."""
    s = re.sub(r'\(.*?\)|".*?"', ' ', fold(name)).replace("'", '').replace('.', ' ')
    return [t for t in re.split(r'[^a-z]+', s) if t and t not in SUFFIX]


def surname(name):
    t = tokens(name)
    return t[-1] if t else ''


def pick(shown, title, names):
    """Which of a race's candidate names is this infobox nominee: the same full name, else the same first and last
    name, else the only one with that surname. None when it can't be told (two Adamses, 1796, need first names)."""
    want = [n for n in (shown, title) if n]
    full = {' '.join(tokens(n)) for n in want}
    hits = [n for n in names if ' '.join(tokens(n)) in full]
    if len(hits) == 1:
        return hits[0]
    ends = {(tokens(n)[0], tokens(n)[-1]) for n in want if len(tokens(n)) >= 2}
    hits = [n for n in names if len(tokens(n)) >= 2 and (tokens(n)[0], tokens(n)[-1]) in ends]
    if len(hits) == 1:
        return hits[0]
    sur = {surname(n) for n in want}
    hits = [n for n in names if surname(n) in sur]
    if len(hits) == 1:
        return hits[0]
    # A typo in the archive's spelling (Lowell P. Weicher Jr. for Lowell Weicker, 1988), with given names that fit.
    hits = [n for n in names if any(close_surname(tokens(n), tokens(w)) and compatible(given_names(w), given_names(n)) for w in want)]
    return hits[0] if len(hits) == 1 else None


def osa(a, b):
    """Edit distance counting a swap of two neighbouring letters as one edit (Hammerschimdt, Hammerschmidt)."""
    d = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) + 1):
        d[i][0] = i
    for j in range(len(b) + 1):
        d[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] != b[j - 1]))
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[len(a)][len(b)]


def same_surname(t, u):
    """Do two names (as tokens) share a surname: the same last word, or one's last word among the other's words
    (Marilyn Lloyd Bouquard, Marilyn Lloyd)."""
    return bool(t and u) and (t[-1] == u[-1] or t[-1] in u or u[-1] in t)


def close_surname(t, u):
    """The same surname give or take a typo, as in the 1970s-80s returns (Albert H Quic for Al Quie, Joseph A Le
    Fante for Lefante, Byron L Dorgansteve Sydness for Dorgan): one or two letters apart, or run together."""
    if not t or not u:
        return False
    a, b = t[-1], u[-1]
    if min(len(a), len(b)) >= 4 and osa(a, b) <= (2 if min(len(a), len(b)) >= 6 else 1):
        return True
    if ''.join(t[-2:]) == b or ''.join(u[-2:]) == a:
        return True
    return len(b) >= 5 and any(x.startswith(b) for x in t) or len(a) >= 5 and any(x.startswith(a) for x in u)


NICKNAMES = [   # first names that can be one person's: William and Bill, Thomas and Tip
    'william bill billy will willie', 'robert bob bobby rob robbie bert', 'richard dick rick rich richie',
    'charles chuck charlie chas', 'james jim jimmy jamie', 'thomas tom tommy tip', 'edward ed eddie ted ned',
    'theodore ted teddy', 'michael mike mickey', 'joseph joe joey', 'daniel dan danny', 'david dave davy',
    'donald don donnie', 'ronald ron ronnie', 'anthony tony', 'patrick pat', 'patricia pat patty trish',
    'katherine kathy kate katie kay', 'catherine cathy kate katie', 'kathleen kathy kate katie', 'elizabeth liz beth betsy betty libby',
    'susan sue susie', 'margaret peggy maggie meg marge', 'john jack johnny jon', 'henry hank harry hal',
    'lawrence larry', 'gerald jerry gerry', 'jerome jerry', 'samuel sam sammy', 'stephen steve', 'steven steve',
    'christopher chris kit', 'matthew matt', 'nicholas nick', 'gregory greg', 'jeffrey jeff', 'kenneth ken kenny',
    'benjamin ben', 'francis frank', 'frederick fred freddie', 'albert al bert', 'alan al', 'allen al', 'alfred al fred',
    'andrew andy drew', 'bernard bernie', 'newton newt', 'chester chet', 'leonard len lenny', 'louis lou',
    'raymond ray', 'eugene gene', 'harold hal harry', 'walter walt', 'philip phil', 'phillip phil', 'douglas doug',
    'timothy tim', 'zachary zach', 'jacob jake', 'joshua josh', 'abraham abe', 'alexander alex', 'alexandra alex',
    'deborah debbie deb', 'pamela pam', 'cynthia cindy', 'barbara barb', 'virginia ginny', 'jennifer jenny jen',
    'rebecca becky', 'victoria vicky', 'kimberly kim', 'jacqueline jackie', 'judith judy', 'carolyn carol',
    'clifford cliff', 'russell russ', 'randolph randy', 'randall randy', 'mitchell mitch', 'herbert herb',
    'stanley stan', 'vincent vince', 'nathaniel nate nat', 'nathan nate', 'jonathan jon', 'calvin cal',
    'clarence clay', 'augustus gus', 'ernest ernie', 'howard howie', 'leroy roy', 'norman norm', 'oliver ollie',
    'peter pete', 'salvatore sal sonny', 'sylvester sly', 'terrence terry', 'terence terry', 'vernon vern',
    'wesley wes', 'wilbur will', 'woodrow woody', 'everett ev', 'mortimer mort', 'maurice mo', 'morris mo',
    'alfonse al', 'alphonse al', 'rudolph rudy', 'rudolf rudy', 'jesus chuy', 'enrique kiki', 'guadalupe lupe',
]
NICK = {}
for group in NICKNAMES:
    for name in group.split():
        NICK.setdefault(name, set()).update(group.split())


def given_names(name):
    """Every name but the surname, with nicknames in quotes or brackets: 'Robert E "Bud" Cramer Jr.' -> robert, e, bud."""
    t = tokens(name)
    extra = [x for part in re.findall(r'\(([^)]*)\)|"([^"]*)"|“([^”]*)”', fold(name)) for x in part if x]
    return set(t[:-1]) | {w for x in extra for w in re.split(r'[^a-z]+', x.replace("'", '')) if w}


def call_names(name):
    """The names someone goes by: the first given name (the second when the first is an initial, as in J. Dennis
    Hastert) and any nickname in quotes or brackets. Not middle names: Robert Patrick Casey Jr. is never "Patrick",
    which was his brother's name."""
    t = tokens(name)
    if len(t) < 2:
        return set()
    out = {t[1] if len(t[0]) == 1 and len(t) > 2 else t[0]}
    extra = [x for part in re.findall(r'\(([^)]*)\)|"([^"]*)"|“([^”]*)”', fold(name)) for x in part if x]
    return out | {w for x in extra for w in re.split(r'[^a-z]+', x.replace("'", '')) if len(w) > 1}


def compatible(a, b, initials=True):
    """Could two sets of given names be one person's: a name in common, one a nickname or a short form (three letters
    or more) of the other, or (initials=True) an initial of the other."""
    for x in a:
        for y in b:
            if x == y or y in NICK.get(x, ()) or (min(len(x), len(y)) >= 3 and (x.startswith(y) or y.startswith(x))):
                return True
            if initials and ((len(x) == 1 and y.startswith(x)) or (len(y) == 1 and x.startswith(y))):
                return True
    return False


def middles(t):
    """Middle initials: John B Anderson -> {b}."""
    return {x[0] for x in t[1:-1]}


def suffixes(name):
    """A generational suffix at the end of a name: 'William J Hughes Jr.' -> {jr}. II counts as Jr. (people write
    John J. Loughlin II and John J. Loughlin Jr. for one man); III is the next generation."""
    t = [x for x in re.split(r'[^a-z]+', fold(name)) if x]
    return {'jr' if x == 'ii' else x for x in ({t[-1]} & SUFFIX if t else set())}


def slugify(title):
    s = fold(title).replace("'", '').replace('’', '')
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


# ------------------------------------------------------------------------------------------- the archive

def load_archive():
    """Every race in the archive: (year, kind, key, [[name, party, votes], ...], total, winner name)."""
    races = []
    for f in sorted(glob.glob(os.path.join(ROOT, 'data', 'archive', '[12][0-9][0-9][0-9].json'))):
        d = json.load(open(f))
        y = d['year']
        for r in d.get('senate', []):
            key = r['state'] + ('-special' if r.get('special') else '')
            races.append({'year': y, 'kind': 'S', 'key': key, 'state': r['state'], 'special': bool(r.get('special')),
                          'cands': r['cands'], 'total': r.get('total'), 'winner': (r.get('winner') or {}).get('name'),
                          'unopposed': r.get('unopposed')})
        for r in d.get('house', []):
            races.append({'year': y, 'kind': 'H', 'key': r['id'], 'state': r['id'][:2], 'cands': r['cands'], 'total': r.get('total'),
                          'winner': (r.get('winner') or {}).get('name'), 'unopposed': r.get('unopposed'),
                          'void': r.get('decided') == 'void'})
    return races


def load_presidential():
    """Presidential candidates by year: {year: [{name, party, ev, pv, total, won, vp}]}, 1788-2024, with the same
    figures as the year pages: before 1976 each year's file (popular votes reconciled to the states' returns, the
    winner as the House chose in 1800 and 1824), from 1976 data/archive/president.json."""
    out = {}
    for f in sorted(glob.glob(os.path.join(ROOT, 'data', 'archive', '[12][0-9][0-9][0-9].json'))):
        d = json.load(open(f))
        p = d.get('president')
        if not d.get('early') or not p:
            continue
        y = d['year']
        total = sum((st.get('total') or 0) for st in p['states'].values())
        cands = [c for c in p['candidates'] if not re.match(r'^(unpledged|no candidate)', c['name'], re.I)]
        # Until 1804 each elector had two votes; the runner-up became vice president (Burr in 1800, after the tie).
        rest = sorted((c for c in cands if c['id'] != p['winner']), key=lambda c: -c['ev'])
        vp = rest[0]['id'] if y < 1804 and rest else None
        out[y] = [{'name': c['name'], 'party': c['party'], 'ev': c['ev'], 'pv': c.get('pv'), 'total': total,
                   'won': c['id'] == p['winner'], 'vp': c['id'] == vp} for c in cands]
    pres = json.load(open(os.path.join(ROOT, 'data', 'archive', 'president.json')))
    for y, r in pres['years'].items():
        y = int(y)
        if r.get('early'):
            continue
        win = 'D' if r['ev']['D'] > r['ev']['R'] else 'R'
        total = r['votes']['total']
        rows = [{'name': r[p], 'party': 'Democratic' if p == 'D' else 'Republican', 'ev': r['ev'][p], 'pv': r['votes'][p], 'total': total,
                 'won': p == win} for p in ('D', 'R')]
        for o in r.get('others') or []:
            rows.append({'name': o['name'], 'party': None, 'ev': 0, 'pv': o['votes'], 'total': total, 'won': False})
        for name, ev in (r['ev'].get('other') or []):
            if not any(x['name'] == name for x in rows):
                rows.append({'name': name, 'party': None, 'ev': ev, 'pv': None, 'total': total, 'won': False})
        out[y] = rows
    return out


# The kinds of race in a history: P president, S Senate, H House, and 2026's statewide offices: G governor,
# L lieutenant governor, A attorney general, C secretary of state. ORDER sorts a year's races.
KIND_2026 = {'senate': 'S', 'house': 'H', 'gov': 'G', 'ltgov': 'L', 'ag': 'A', 'sos': 'C'}
ORDER = 'PSGLACH'


# ------------------------------------------------------------------------------------------- Wikidata seats

def congresses(start, end, term):
    """The Congresses a statement covers: its own (P2937) when it has an end date; else every one from its start to
    its end, or to now if it has none (Wikidata leaves most continuing members' latest term open)."""
    if term and end:
        return [term]
    first = term or congress_of(int(start[:4]))
    if end:
        y, m, d = int(end[:4]), int(end[5:7]), int(end[8:10])
        last = congress_of(y - 1) if (y % 2 and m == 1 and d <= 3) else congress_of(y)   # a term ends on Jan 3
    else:
        last = congress_of(time.localtime().tm_year)
    return range(first, max(first, last) + 1)


def seat_holders():
    """{('H', 'CA', '12', 119) or ('S', 'CT', None, 119): {qid: (label, from the start)}} from Wikidata's positions
    held since 1975. "From the start": they held the seat on the Congress's first days, as the winner of the election
    before it does (a successor after a death or a resignation starts later)."""
    holders = {}
    # One query per decade of start dates, so none runs out of time (the first also takes terms begun before 1975).
    q = '''SELECT ?p ?pLabel ?start ?end ?distLabel ?termLabel WHERE {
      ?p p:P39 ?st . ?st ps:P39 wd:%s . ?st pq:P580 ?start . OPTIONAL { ?st pq:P582 ?end }
      FILTER(?start < "%s-01-01"^^xsd:dateTime && %s)
      ?p wdt:P31 wd:Q5 .   # people: Wikidata also seats a few television characters (Arnold Vinick, Selina Meyer)
      OPTIONAL { ?st pq:P768 ?dist } OPTIONAL { ?st pq:P2937 ?term }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". } }'''
    first = '(?start >= "1975-01-01"^^xsd:dateTime || ?end >= "1975-01-01"^^xsd:dateTime)'
    spans = [(1985, first)] + [(y + 10, f'?start >= "{y}-01-01"^^xsd:dateTime') for y in range(1985, 2035, 10)]
    rows_all = []
    for kind, pos in (('H', 'Q13218630'), ('S', 'Q4416090')):
        rows = [r for until, cond in spans for r in sparql(q % (pos, until, cond))]
        rows_all += [(kind, r) for r in rows]
        log(f'  {kind}: {len(rows)} seat statements')
    # The label service now and then answers with the item's id instead of its name (Q6294 for Hillary Clinton).
    bare = sorted({qid_of(r['p']) for _, r in rows_all if re.match(r'^Q\d+$', r.get('pLabel', ''))})
    names = {}
    for batch in chunks(bare, 150):
        for r in sparql('SELECT ?p ?l WHERE { VALUES ?p { %s } ?p rdfs:label ?l FILTER(LANG(?l) IN ("en", "mul")) }' % ' '.join(f'wd:{x}' for x in batch)):
            names[qid_of(r['p'])] = r['l']
    for kind, r in rows_all:
        dist = r.get('distLabel', '')
        if kind == 'H':
            m = re.match(r"^(.+?)['’]s? (?:(\d+)(?:st|nd|rd|th)|(at-large)) congressional district", dist)
            if not m or m.group(1) not in CODE:
                continue
            state, num = CODE[m.group(1)], (m.group(2) or 'AL')
        else:
            m = re.match(r'^(.+?) Class \d senate seat', dist)
            if not m or m.group(1) not in CODE:
                continue
            state, num = CODE[m.group(1)], None
        t = re.match(r'^(\d+)(?:st|nd|rd|th) United States Congress', r.get('termLabel', ''))
        qid = qid_of(r['p'])
        label = names.get(qid) or r.get('pLabel', '')
        if not isodate(r['start']):
            continue
        span = list(congresses(r['start'], isodate(r.get('end')) or None, int(t.group(1)) if t else None))
        for c in span:
            opens = 1789 + 2 * (c - 1)   # the year the Congress first met, on January 3 or 4 (March 4 before 1935)
            at_start = c != span[0] or r['start'][:10] <= f'{opens}-01-15'
            key = (kind, state, num, c)
            was = holders.setdefault(key, {}).get(qid)
            holders[key][qid] = (label, at_start or bool(was and was[1]))
    return holders


def house_key(race_id):
    st, num = race_id.split('-')
    return st, ('AL' if num in ('AL', '00') else str(int(num)))


def choose(name, pool, house):
    """The one holder of a seat (pool: {qid: (label, from the start)}) who is the archive's winner, or None.
    - The same surname and given names that fit (Tip and Thomas, J. Dennis and Dennis), narrowed by middle initial
      and by who held the seat from the start (Hubert Humphrey, not Muriel Humphrey, his widow). Where nobody's
      given names fit, the one holder from the start (a nickname we don't know), except that in the Senate a
      governor can appoint someone from the first day (Jean Carnahan for her late husband Mel): the Senate leaves
      that to the election article's link.
    - Else a surname a typo away (Albert H Quic for Al Quie), with given names that fit or the only holder.
    - Else, for a House seat, the only holder from the start with the same first name (Blanche Lambert, who married
      and became Blanche Lincoln)."""
    t = tokens(name)
    if not t:
        return None
    labels = {q: tokens(label) for q, (label, _) in pool.items()}
    gn = given_names(name)
    fits = lambda q: compatible(gn, given_names(pool[q][0]))
    hits = [q for q, u in labels.items() if same_surname(t, u)]
    if hits:
        good = [q for q in hits if fits(q)]
        if not good:
            good = [q for q in hits if pool[q][1]] if house else []
        hits = good
    else:
        hits = [q for q, u in labels.items() if close_surname(t, u) and (fits(q) or len(pool) == 1)]
        if not hits and house:
            hits = [q for q, u in labels.items() if pool[q][1] and u and len(t[0]) >= 3 and (u[0] == t[0] or u[0] in NICK.get(t[0], ()))]
    for narrow in (lambda q: not (middles(t) and middles(labels[q])) or bool(middles(t) & middles(labels[q])),
                   lambda q: pool[q][1]):
        if len(hits) > 1:
            hits = [q for q in hits if narrow(q)] or hits
    return hits[0] if len(hits) == 1 else None


def match_winners(races, holders):
    """Each House and Senate winner's Wikidata person, from the seat they won: {(year, kind, key, name): qid}."""
    out, missed = {}, []
    for r in races:
        if not r['winner']:
            continue
        if r['kind'] == 'H':
            st, num = house_key(r['key'])
            pool = holders.get(('H', st, num, next_congress(r['year'])), {})
        else:
            pool = {}
            for (k, st, _, c), people in holders.items():
                if k == 'S' and st == r['state'] and c == next_congress(r['year']):
                    pool.update(people)
        q = choose(r['winner'], pool, r['kind'] == 'H')
        if q:
            out[(r['year'], r['kind'], r['key'], r['winner'])] = q
        else:
            missed.append((r['year'], r['key'], r['winner'], [label for label, _ in pool.values()]))
    log(f'  winners matched by seat: {len(out)}; not matched: {len(missed)} '
        f'({sum(1 for m in missed if not m[3])} where Wikidata has no one in the seat)')
    for m in [m for m in missed if m[3]][:12]:
        log('    no seat match:', m)
    return out


# ------------------------------------------------------------------------------------------- Wikipedia infoboxes

def infobox(text, kind='election', at=0):
    """The parameters of the first {{Infobox election}} in some wikitext, from position at on (kind=None: any
    kind of infobox): {name: value}."""
    m = re.compile(r'\{\{\s*Infobox' + (r'\s+' + kind if kind else r'\b'), re.I).search(text or '', at)
    if not m:
        return {}
    i, depth, start = m.start(), 0, m.start()
    while i < len(text):
        if text.startswith('{{', i):
            depth += 1
            i += 2
        elif text.startswith('}}', i):
            depth -= 1
            i += 2
            if depth == 0:
                break
        else:
            i += 1
    body = text[start + 2:i - 2]
    params, depth, cur = [], 0, ''
    j = 0
    while j < len(body):   # split on top-level pipes only
        two = body[j:j + 2]
        if two in ('{{', '[['):
            depth += 1
            cur += two
            j += 2
            continue
        if two in ('}}', ']]'):
            depth -= 1
            cur += two
            j += 2
            continue
        if body[j] == '|' and depth == 0:
            params.append(cur)
            cur = ''
        else:
            cur += body[j]
        j += 1
    params.append(cur)
    out = {}
    for p in params[1:]:
        if '=' in p:
            k, v = p.split('=', 1)
            out[k.strip().lower()] = v.strip()
    return out


def first_link(value):
    m = re.search(r'\[\[([^\]|#]+)', value or '')
    return m.group(1).strip().lstrip(':') if m else None


def nominees(box):
    """The infobox's candidates: [(article title, shown name)] in its order."""
    out = []
    for k, v in box.items():
        m = re.match(r'^(nominee|candidate)(\d+)$', k)
        if m and first_link(v):
            text = re.sub(r"'''|''", '', re.sub(r'\[\[(?:[^\]|]*\|)?([^\]]*)\]\]', r'\1', v))
            out.append((int(m.group(2)), first_link(v), re.sub(r'<[^>]+>|\{\{.*?\}\}', '', text).strip()))
    return [(t, n) for _, t, n in sorted(out)]


def wikitexts(titles):
    """Wikitext of each article (following redirects): {asked title: (final title, text)}."""
    out = {}
    for batch in chunks(titles, 20):
        d = wp({'action': 'query', 'prop': 'revisions', 'rvprop': 'content', 'rvslots': 'main', 'redirects': 1, 'titles': '|'.join(batch)})
        q = d.get('query', {})
        back = {}
        for n in q.get('normalized', []):
            back[n['to']] = n['from']
        for rd in q.get('redirects', []):
            back[rd['to']] = back.get(rd['from'], rd['from'])
        for page in q.get('pages', []):
            if page.get('missing') or not page.get('revisions'):
                continue
            asked = back.get(page['title'], page['title'])
            out[asked] = (page['title'], page['revisions'][0]['slots']['main']['content'])
    return out


def senate_titles(r):
    y, name = r['year'], STATES[r['state']]
    if r['special']:
        return [f'{y} United States Senate special election in {name}', f'{y}–{(y + 1) % 100:02d} United States Senate special election in {name}']
    return [f'{y} United States Senate election in {name}', f'{y}–{(y + 1) % 100:02d} United States Senate election in {name}']


def presidential_title(y):
    return '1788–89 United States presidential election' if y == 1788 else f'{y} United States presidential election'


# ------------------------------------------------------------------------------------------- Wikidata people

def qids_of_titles(titles):
    """{title: (qid, final title)} via Wikipedia's page properties, following redirects."""
    out = {}
    for batch in chunks(sorted(set(titles)), 50):
        d = wp({'action': 'query', 'prop': 'pageprops', 'ppprop': 'wikibase_item', 'redirects': 1, 'titles': '|'.join(batch)})
        q = d.get('query', {})
        back = {}
        for n in q.get('normalized', []):
            back[n['to']] = n['from']
        for rd in q.get('redirects', []):
            back[rd['to']] = back.get(rd['from'], rd['from'])
        for page in q.get('pages', []):
            item = (page.get('pageprops') or {}).get('wikibase_item')
            if item:
                out[back.get(page['title'], page['title'])] = (item, page['title'])
    return out


def people_details(qids):
    """Label, description, article, birth and death, aliases, parties and offices for each person."""
    info = {q: {'aliases': set(), 'parties': [], 'offices': []} for q in qids}
    for batch in stable_batches(qids, 40, 150):
        values = ' '.join(f'wd:{q}' for q in batch)
        for r in sparql('''SELECT ?p ?label ?mul ?desc ?article ?born ?died ?bpLabel ?human WHERE { VALUES ?p { %s }
            OPTIONAL { ?p rdfs:label ?label FILTER(LANG(?label) = "en") } OPTIONAL { ?p rdfs:label ?mul FILTER(LANG(?mul) = "mul") }
            OPTIONAL { ?p schema:description ?desc FILTER(LANG(?desc) = "en") }
            OPTIONAL { ?article schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> }
            OPTIONAL { ?p wdt:P569 ?born } OPTIONAL { ?p wdt:P570 ?died } OPTIONAL { ?p wdt:P19 ?bp }
            BIND(EXISTS { ?p wdt:P31 wd:Q5 } AS ?human)
            SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". } }''' % values):
            x = info[qid_of(r['p'])]
            for k in ('born', 'died'):
                r[k] = isodate(r.get(k))
            for k in ('label', 'desc', 'born', 'died', 'bpLabel'):
                if r.get(k) and not x.get(k):
                    x[k] = r[k]
            if r.get('mul') and not r.get('label') and not x.get('label'):   # a multilingual label only
                x['label'] = r['mul']
            if r.get('article') and not x.get('article'):
                x['article'] = urllib.parse.unquote(r['article'].rsplit('/wiki/', 1)[-1]).replace('_', ' ')
            x['human'] = r.get('human') == 'true'
        for r in sparql('SELECT ?p ?alias WHERE { VALUES ?p { %s } ?p skos:altLabel ?alias FILTER(LANG(?alias) IN ("en", "mul")) }' % values):
            info[qid_of(r['p'])]['aliases'].add(r['alias'])
        for r in sparql('''SELECT ?p ?partyLabel ?from ?to WHERE { VALUES ?p { %s } ?p p:P102 ?s . ?s ps:P102 ?party .
            OPTIONAL { ?s pq:P580 ?from } OPTIONAL { ?s pq:P582 ?to }
            SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". } }''' % values):
            info[qid_of(r['p'])]['parties'].append((r.get('partyLabel', ''), isodate(r.get('from'))[:4], isodate(r.get('to'))[:4]))
        # One row per statement, with each date's precision. A statement can hold two terms (Dan Burton's Indiana
        # House seat, 1966-68 and 1976-80): its starts and ends are paired in order, not crossed.
        stmts = {}
        for r in sparql('''SELECT ?p ?s ?posLabel ?from ?fp ?to ?tp ?distLabel WHERE { VALUES ?p { %s } ?p p:P39 ?s . ?s ps:P39 ?pos .
            OPTIONAL { ?s pqv:P580 ?fv . ?fv wikibase:timeValue ?from ; wikibase:timePrecision ?fp }
            OPTIONAL { ?s pqv:P582 ?tv . ?tv wikibase:timeValue ?to ; wikibase:timePrecision ?tp }
            OPTIONAL { ?s pq:P768 ?dist }
            SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". } }''' % values):
            st = stmts.setdefault(r['s'], {'p': qid_of(r['p']), 'label': r.get('posLabel', ''), 'dist': r.get('distLabel', ''), 'from': set(), 'to': set()})
            if isodate(r.get('from')):
                st['from'].add((isodate(r['from'])[:10], int(r.get('fp') or 9)))
            if isodate(r.get('to')):
                st['to'].add((isodate(r['to'])[:10], int(r.get('tp') or 9)))
        for st in stmts.values():
            starts, ends = sorted(st['from']), sorted(st['to'])
            if not starts:
                info[st['p']]['offices'].append((st['label'], '', ends[0][0] if ends else '', st['dist'], 'wd', 0, ends[0][1] if ends else 0))
                continue
            for a in starts:
                e = next((x for x in ends if x[0] >= a[0]), None)
                if e:
                    ends.remove(e)
                info[st['p']]['offices'].append((st['label'], a[0], e[0] if e else '', st['dist'], 'wd', a[1], e[1] if e else 0))
    # Born and died, each from its best statement: not deprecated, preferred rank first, then the most precise. A
    # value known only to the decade or century is no date at all (Wikidata has 2000 for Kathy Jennings, born 1953);
    # one known to the year or month is kept as "1735" or "1735-10", so the page shows no made-up day or age.
    best = {}
    for batch in stable_batches(qids, 40, 150):
        for r in sparql('''SELECT ?p ?which ?t ?prec ?rank WHERE { VALUES ?p { %s }
            VALUES (?prop ?psv ?which) { (p:P569 psv:P569 "born") (p:P570 psv:P570 "died") }
            ?p ?prop ?st . ?st ?psv ?v . ?v wikibase:timeValue ?t ; wikibase:timePrecision ?prec . ?st wikibase:rank ?rank }''' % ' '.join(f'wd:{q}' for q in batch)):
            if r['rank'].endswith('DeprecatedRank') or not isodate(r.get('t')):
                continue
            k = (qid_of(r['p']), r['which'])
            score = (r['rank'].endswith('PreferredRank'), int(r['prec']))
            if k not in best or score > best[k][0]:
                best[k] = (score, r['t'], int(r['prec']))
    for q in qids:
        for which in ('born', 'died'):
            got = best.get((q, which))
            prec = got[2] if got else 0
            info[q][which] = None if prec < 9 else got[1][:4] if prec == 9 else got[1][:7] if prec == 10 else got[1][:10]
    return info


PARTY_LABEL = {'independent politician': 'Independent'}   # Wikidata's party for independents


def party_order(rows):
    """A person's parties, the current or latest first: rows are (party, from year, to year)."""
    last = {}
    for party, _, to in rows:
        party = PARTY_LABEL.get(party, party)
        if party and not re.match(r'^Q\d+$', party):
            last[party] = max(last.get(party, 0), int(to) if to else 9999)
    return [p for p, _ in sorted(last.items(), key=lambda kv: -kv[1])]


def extracts(titles):
    """The first sentences of each article, plain text: {title: text}."""
    out = {}
    for batch in stable_batches(titles, 250, 20):
        d = wp({'action': 'query', 'prop': 'extracts', 'exintro': 1, 'explaintext': 1, 'exsentences': 3, 'exlimit': 20,
                'redirects': 1, 'titles': '|'.join(batch)})
        for page in d.get('query', {}).get('pages', []):
            if page.get('extract'):
                out[page['title']] = page['extract'].strip()
    return out


# ------------------------------------------------------------------------------------------- offices, shown

OFFICE_RULES = [   # (pattern on the position's label, short name, rank: lower shows first)
    (r'^President of the United States$', 'President', 0),
    (r'^Vice President of the United States$', 'Vice President', 1),
    (r'^United States [Ss]enator$', 'U.S. Senator', 3),
    (r'^(member of the United States House of Representatives|United States [Rr]epresentative)$', 'U.S. Representative', 4),
    (r'^Speaker of the United States House of Representatives$', 'Speaker of the House', 2),
    (r'^United States Secretary of ', None, 2),
    (r'^United States Attorney General$', 'Attorney General', 2),
    # A military governorship is listed under its own name (John C. Frémont's of California in 1847, before statehood).
    (r'^(Governor of |Governor of the State of |Military Governor of )', None, 3),
    (r'^Lieutenant Governor of ', None, 5),
    (r'^Mayor of ', None, 6),
    (r'^(Attorney General|Secretary of State|State Treasurer|Treasurer) of ', None, 6),
    # The same offices named state first: "North Carolina Attorney General", "Ohio Secretary of State".
    (r'^(%s) (Governor|Lieutenant Governor)$' % '|'.join(re.escape(n) for n in STATES.values()), None, 3),
    (r'^(%s) (Attorney General|Secretary of State|State Treasurer|Treasurer)$' % '|'.join(re.escape(n) for n in STATES.values()), None, 6),
    (r'^United States Ambassador to ', None, 5),
    (r'^(Chief Justice of the United States|Associate Justice of the Supreme Court of the United States)$', None, 2),
    (r'^White House Chief of Staff$', None, 4),
    # A state legislature: "member of the Vermont House of Representatives", "member of the Ohio Senate", and with the
    # state last, "member of the State Senate of South Carolina".
    (r'^[Mm]ember of the (%s) (State )?(House of Representatives|Senate|Assembly|House of Delegates|Legislature|General Assembly)$'
     % '|'.join(re.escape(n) for n in STATES.values()), None, 7),
    (r'^[Mm]ember of the (State Senate|State Assembly|House of Representatives|House of Delegates|Senate|Assembly|General Assembly|Legislature) of (the State of )?(%s)$'
     % '|'.join(re.escape(n) for n in STATES.values()), None, 7),
]


# ------------------------------------------------------------------------------------------- offices from Wikipedia

STATE_RE = '|'.join(re.escape(n) for n in sorted(STATES.values(), key=len, reverse=True))   # West Virginia first
STATE_SENATE = {'New York', 'California', 'Wisconsin', 'Louisiana', 'Mississippi', 'Arizona', 'Pennsylvania',
                'Washington', 'Oregon', 'Georgia', 'Utah', 'Connecticut'}   # chambers called "<State> State Senate"
LOWER_NAME = {'California': 'California State Assembly', 'New York': 'New York State Assembly', 'Wisconsin': 'Wisconsin State Assembly',
              'Nevada': 'Nevada Assembly', 'New Jersey': 'New Jersey General Assembly', 'Virginia': 'Virginia House of Delegates',
              'Maryland': 'Maryland House of Delegates', 'West Virginia': 'West Virginia House of Delegates'}
STATE_PAGE = {'New York (state)': 'New York', 'Washington (state)': 'Washington', 'Georgia (U.S. state)': 'Georgia'}
# Missions are named one way whichever source has them: with "the" where the place takes it (an infobox's country
# field has "Holy See" where Wikidata has "the Holy See"), and by one name (Micronesia is the Federated States of
# Micronesia).
THE_NAMES = {'Bahamas', 'Holy See', 'Netherlands', 'Philippines', 'United Kingdom', 'Federated States of Micronesia',
             'Marshall Islands', 'Solomon Islands', 'Gambia', 'Czech Republic', 'Dominican Republic', 'Central African Republic',
             'Democratic Republic of the Congo', 'Republic of the Congo', 'United Arab Emirates', 'Maldives', 'Comoros',
             'Soviet Union', 'Russian Empire', 'Ottoman Empire', 'Netherlands Antilles'}
THE_PREFIX = r'^(United Nations|Organi[sz]ation|European|Republic of|Kingdom of|Empire of|Court of|Conference on|Association of|African Union)\b'
MISSION_ALIAS = {'Micronesia': 'Federated States of Micronesia', 'Great Britain': 'United Kingdom', 'Vatican': 'Holy See',
                 'Vatican City': 'Holy See', 'USSR': 'Soviet Union'}
MONTH_NUM = {m: i + 1 for i, m in enumerate(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
                                             'september', 'october', 'november', 'december'])}
MONTH_RE = r'(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)'


def chamber_name(kind, state):
    if kind == 'lower':
        return LOWER_NAME.get(state, f'{state} House of Representatives')
    if state == 'Nebraska':
        return 'Nebraska Legislature'
    return f'{state} State Senate' if state in STATE_SENATE else f'{state} Senate'


def office_title(title):
    """One name for one office, however a source words it: "State Senate of South Carolina" and "South Carolina
    Senate" are one office; so are "North Carolina Attorney General" and "Attorney General of North Carolina",
    "Mayor of Parker, Colorado" and "Mayor of Parker" (the place's state is shown where a source gives it),
    "Ambassador to Holy See" and "to the Holy See", and "Governor of the Territory of Arizona" and "Governor of
    Arizona Territory" (both "Governor of the Arizona Territory")."""
    m = re.match(r'^United States Ambassador to (?:the )?(.+)$', title)
    if m:
        place = MISSION_ALIAS.get(m.group(1), m.group(1))
        return f"United States Ambassador to {'the ' if place in THE_NAMES or re.match(THE_PREFIX, place) else ''}{place}"
    m = re.match(r'^Governor of (?:the )?(?:Territory of (.+)|(.+) Territory)$', title)
    if m:
        return f'Governor of the {m.group(1) or m.group(2)} Territory'
    lower, upper = r'(?:State )?(?:House of Representatives|House of Delegates|Assembly|General Assembly)', r'(?:State )?Senate'
    for pat, kind in ((rf'^({STATE_RE}) {lower}$', 'lower'), (rf'^{lower} of (?:the State of )?({STATE_RE})$', 'lower'),
                      (rf'^({STATE_RE}) {upper}$', 'upper'), (rf'^{upper} of (?:the State of )?({STATE_RE})$', 'upper'),
                      (rf'^({STATE_RE}) Legislature$', 'upper')):
        m = re.match(pat, title)
        if m:
            return chamber_name(kind, m.group(1)) if m.group(1) == 'Nebraska' or 'Legislature' not in pat else f'{m.group(1)} Legislature'
    offices = r'(Governor|Lieutenant Governor|Attorney General|Secretary of State|State Treasurer|Treasurer)'
    m = re.match(rf'^{offices} of (?:the State of )?({STATE_RE})$', title)
    if m:
        office, state = m.group(1), m.group(2)
    else:
        m = re.match(rf'^({STATE_RE}) {offices}$', title)
        if not m:
            m = re.match(rf'^Mayor of (.+?), ({STATE_RE})$', title)
            return f'Mayor of {m.group(1)}' if m else title
        state, office = m.group(1), m.group(2)
    return f"{'Treasurer' if office == 'State Treasurer' else office} of {state}"


def _date_template(m):
    y, mo, d = m.group(1), m.group(2), m.group(3)
    return f'{y}-{int(mo):02d}-{int(d):02d}' if mo and d else (f'{y}-{int(mo):02d}' if mo else y)


def wikiclean(v):
    """Wikitext to plain text: links to their text; references, notes ({{efn}}), comments and other templates out;
    a date template to its date; a list template ({{br separated entries}}, {{ubl}}) to its items; entities such as
    &ndash; and &nbsp; to their characters."""
    v = re.sub(r'<ref[^>]*/>|<ref[^>]*>.*?</ref>|<!--.*?-->', '', v or '', flags=re.S)
    v = html.unescape(re.sub(r'<br\s*/?>', ' ', v))
    v = re.sub(r'\{\{\s*(?:start[ _]date|end[ _]date|start date and age|end date and age|dts|date)\s*\|(?:\s*[a-z]+\s*=\s*[a-z0-9]*\s*\|)*'
               r'\s*(\d{4})(?:\s*\|\s*(\d{1,2}))?(?:\s*\|\s*(\d{1,2}))?[^{}]*\}\}', _date_template, v, flags=re.I)
    lists = r'\{\{\s*(?:br separated entries|ubl|unbulleted list|plainlist|plain list|flatlist|hlist|nowrap|nobr|small)\s*\|([^{}]*)\}\}'
    for _ in range(4):
        v = re.sub(lists, lambda m: ' '.join(x.strip(' *\n') for x in m.group(1).split('|') if '=' not in x or '[[' in x), v, flags=re.I)
        v = re.sub(r'\{\{[^{}]*\}\}', '', v)
    v = re.sub(r'\[\[(?:[^\]|]*\|)?([^\]]*)\]\]', r'\1', v)
    v = re.sub(r"'{2,}|<[^>]+>", '', v)
    return re.sub(r'\s+', ' ', v).strip()


def year_in(v):
    m = re.search(r'\b(1[6-9]\d\d|20\d\d)\b', v or '')
    return int(m.group(1)) if m else None


def date_in(text):
    """The first date in some plain text: ('YYYY-MM-DD', precision 11 for a day, 10 a month, 9 a year) or (None, 0)."""
    for pat, prec, order in ((r'\b(\d{4})-(\d{2})-(\d{2})\b', 11, 'ymd'),
                             (rf'\b{MONTH_RE}\.?\s+(\d{{1,2}}),?\s+(\d{{4}})\b', 11, 'mdy'),
                             (rf'\b(\d{{1,2}})\s+{MONTH_RE}\.?,?\s+(\d{{4}})\b', 11, 'dmy'),
                             (r'\b(\d{4})-(\d{2})\b', 10, 'ym'),
                             (rf'\b{MONTH_RE}\.?,?\s+(\d{{4}})\b', 10, 'my'),
                             (r'\b(1[6-9]\d\d|20\d\d)\b', 9, 'y')):
        m = re.search(pat, text or '', re.I)
        if not m:
            continue
        g = m.groups()
        month = lambda s: next((v for k, v in MONTH_NUM.items() if k.startswith(s.lower().rstrip('.')[:3])), 1)
        if order == 'ymd':
            y, mo, d = int(g[0]), int(g[1]), int(g[2])
        elif order == 'mdy':
            y, mo, d = int(g[2]), month(g[0]), int(g[1])
        elif order == 'dmy':
            y, mo, d = int(g[2]), month(g[1]), int(g[0])
        elif order == 'ym':
            y, mo, d = int(g[0]), int(g[1]), 1
        elif order == 'my':
            y, mo, d = int(g[1]), month(g[0]), 1
        else:
            y, mo, d = int(g[0]), 1, 1
        if 1600 <= y <= 2100 and 1 <= mo <= 12:
            return f'{y:04d}-{mo:02d}-{max(1, min(d, 28 if mo == 2 else 30)):02d}', prec
    return None, 0


def house_seats(value, f, u):
    """The districts of an infobox's House block, from {{ushr|KY|2|...}} or a link to "Kentucky's 2nd congressional
    district", with or without the years beside each: [(district code, or '' when it can't be told, from, to)]."""
    found = []
    for m in re.finditer(r'\{\{\s*ushr\s*\|\s*([^|}]+?)\s*\|\s*([^|}]+?)\s*(?:\|[^}]*)?\}\}|\[\[\s*(' + STATE_RE + r")['’]s\s+(?:(\d+)(?:st|nd|rd|th)|(at-large))\s+congressional district",
                         value or '', re.I):
        st, num = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4) or 'AL')
        years = re.match(r'[^(\n]{0,80}?\((\d{4})\s*[–-]\s*(\d{4}|present)\)', (value or '')[m.end():])
        code = st.upper() if st.upper() in STATES else CODE.get(st.strip())
        num = num.strip()
        num = 'AL' if re.match(r'^(al|at-?large)$', num, re.I) else (f'{int(num):02d}' if num.isdigit() else None)
        if not code or not num:
            return [('', f, u)]
        a = int(years.group(1)) if years else None
        b = (None if years.group(2) == 'present' else int(years.group(2))) if years else None
        found.append((f'{code}-{num}', a, b))
    if len(found) == 1:
        return [(found[0][0], f, u)]
    if found and all(a for _, a, _ in found):
        return [(code, a, b) for code, a, b in found]
    return [('', f, u)]


def first_infobox_with_terms(text):
    """The parameters of the first infobox in the text that lists terms of office (a military-service or other
    infobox can come first)."""
    at = 0
    while text:
        i = text.lower().find('{{infobox', at)
        if i < 0:
            return {}
        box = infobox(text, kind=None, at=i)
        if any(k.startswith(('term_start', 'term')) for k in box):
            return box
        at = i + 2
    return {}


DATE_TOKEN = re.compile(rf'{MONTH_RE}\.?\s+\d{{1,2}},?\s+\d{{4}}|\d{{1,2}}\s+{MONTH_RE}\.?,?\s+\d{{4}}|{MONTH_RE}\.?,?\s+\d{{4}}'
                        r'|\b\d{4}-\d{2}-\d{2}\b|\b(?:1[6-9]\d\d|20\d\d)\b|\b(?:present|incumbent)\b', re.I)


def term_spans(value):
    """The spans in a single termN field, as (from, precision, to, precision) like term_start and term_end give:
    "1782" is a year; "1786–1787; 1810–1811" two spans; "January 3, 1949 – January 3, 1959" one span of ten years
    (Bizz Johnson's state Senate term), not a year at each end."""
    text = wikiclean(value)
    found = list(DATE_TOKEN.finditer(text))
    out, i = [], 0
    while i < len(found):
        a = found[i]
        b = found[i + 1] if i + 1 < len(found) else None
        joined = b is not None and re.fullmatch(r'\s*(?:[–—-]|to|until)\s*', text[a.end():b.start()], re.I)
        i += 2 if joined else 1
        if re.match(r'present|incumbent', a.group(0), re.I):
            continue
        fd, fp = date_in(a.group(0))
        if joined and re.match(r'present|incumbent', b.group(0), re.I):
            out.append((fd, fp, None, 0))
            continue
        ud, up = date_in(b.group(0)) if joined else (fd, fp)
        out.append((fd, fp, ud[:4] + '-12-31' if up == 9 else ud, up))
    return out


def office_name(t):
    """An infobox's name for an office, worded as Wikidata words it: "64th Governor of Virginia" is "Governor of
    Virginia", "U.S. Minister to Great Britain" "United States Ambassador to the United Kingdom", and a chamber named
    alone ("Florida House of Representatives") "Member of the Florida House of Representatives"."""
    t = re.sub(r'^(?:\d+(?:st|nd|rd|th)(?:,\s*|\s+and\s+|\s+))+', '', t).replace('U.S. ', 'United States ')
    t = re.sub(r'^(?:United States )?Minister to (?:Great Britain|the United Kingdom)\b', 'United States Ambassador to the United Kingdom', t)
    t = re.sub(r'^(?:United States )?(?:Minister|Envoy) to ', 'United States Ambassador to ', t)
    if re.match(rf'^(?:{STATE_RE}) (?:State )?(?:House of Representatives|Senate|Assembly|House of Delegates|Legislature|General Assembly)$', t):
        t = 'Member of the ' + t
    return t


def office_label(t):
    """The label for an office name that isn't a seat in Congress: "Member of the Maryland House of Delegates from
    Montgomery County" is "member of the Maryland House of Delegates"."""
    if re.match(r'^Member of the ', t, re.I):
        t = re.sub(r'\s+(?:from|for|representing)\s+.*$', '', t)
    return re.sub(r'^Member of the ', 'member of the ', t)


ELECT = r'-elect\b|\belect\b'   # "Senator-elect", "Governor-elect": won, not held


def congress_seat(t):
    """'house' or 'senate' for an infobox name for a seat in Congress, else None."""
    if re.search(ELECT, t, re.I):
        return None
    if 'House of Representatives' in t and 'United States' in t and re.match(r'^(Member|Representative)', t):
        return 'house'
    return 'senate' if re.match(r'^United States Senator', t) else None


def listed(t):
    """Whether the profiles list an office of this name (a seat in Congress, or a label an office rule takes)."""
    return not re.search(ELECT, t, re.I) and (congress_seat(t) is not None or any(re.match(r[0], office_label(t)) for r in OFFICE_RULES))


def infobox_offices(text, born=None, died=None, now=None):
    """The offices in a person's Wikipedia infobox, as rows like Wikidata's (label, from, to, district, 'wp',
    from precision, to precision), with what the infobox has that Wikidata may lack (Henry Clay's earlier House
    terms, DeWitt Clinton's years as lieutenant governor, Tip O'Neill's Massachusetts House years from 1937 where
    Wikidata starts at 1947). Blocks are numbered (office1, term_start1, ...). A block names its office in officeN
    (or orderN, titleN), as a mission (ambassador_fromN or minister_fromN with countryN), a state legislature
    (state_senateN, state_houseN, state_legislatureN...), or a seat in Congress (stateN with a district is a House
    seat, alone a Senate seat); a block that names none continues the one before, House district and all. Dates are
    read from the text with footnotes, notes ({{efn}}) and comments taken out first. Terms that can't be right (begun
    before 16 or after death, ending before they begin or after death, still open after death) are left out, and so
    are offices won but not held (an office-elect, a nominee, an election won after death) and terms not yet begun.
    Returns (rows, left out)."""
    now = now or time.localtime().tm_year
    today = min(time.strftime('%Y-%m-%d'), f'{now:04d}-12-31')
    blocks = {}
    for k, v in first_infobox_with_terms(text).items():
        m = re.match(r'^([a-z_/]+?)(\d*)$', k.strip())
        if m and v.strip():
            blocks.setdefault(int(m.group(2) or 0), {})[m.group(1)] = v
    born = int(born[:4]) if born else None
    died = int(died[:4]) if died else None
    rows, left, office, seats_value = [], [], None, ''
    for n in sorted(blocks):
        b = blocks[n]
        state = STATE_PAGE.get(wikiclean(b.get('state', '')), wikiclean(b.get('state', '')))
        legislature = next((k for k in ('state_senate', 'state_house', 'state_assembly', 'state_delegate', 'state_legislature') if b.get(k)), None)
        # The office's name is in officeN, or in orderN beside its number ("64th Governor of Virginia", Chuck Robb's
        # governorship, which would otherwise read as more of the Senate term above it), or in titleN.
        named = b.get('office') or next((b[k] for k in ('order', 'title') if b.get(k)
                                         and re.search(r'[A-Za-z]{3,}', re.sub(r'\b\d+(st|nd|rd|th)\b', '', wikiclean(b[k])))), None)
        held = True
        if named:
            t = office_name(wikiclean(named))
            if re.search(ELECT, t, re.I):
                # Won but not held, or not yet: Mel Carnahan was elected to the Senate three weeks after he died. This
                # block's dates are left out; a block after it that names no office is an earlier term of the office
                # (Marc Molinaro's New York Assembly seat, 2007-2011).
                held = False
                t = office_name(re.sub(r'[-\s]elect\b', '', t, flags=re.I))
            if not listed(t) and re.search(r'\b(?:Representative|Senator|Assembly(?:man|woman|member|person)?|Delegate|Member|Legislator)\b', t) \
                    and not re.search(r'\b(?:Speaker|President|Leader|Whip|Chair\w*|Clerk|pro tempore|Dean)\b', t, re.I):
                # A seat in a legislature named by a piped link whose text names no office: "[[Florida House of
                # Representatives|State Representative from Palm Beach, Florida]]" (Skip Bafalis) is a seat in the
                # chamber linked.
                targets = (office_name(wikiclean(g.replace('_', ' '))) for g in re.findall(r'\[\[\s*([^\]|#]+)[^\]|]*\|', named))
                t = next((g for g in targets if re.match(rf'^Member of the (?:{STATE_RE}) ', g) and listed(g)), t)
            fm = re.search(rf'\bfrom ({STATE_RE})\b', t)
            if congress_seat(t):
                office = (congress_seat(t), fm.group(1) if fm else state)
            else:
                office = ('label', office_label(t))
        elif b.get('ambassador_from') or b.get('minister_from') or b.get('country'):
            # A mission abroad: James Buchanan's to Russia and to Britain, which would otherwise read as House terms.
            country = wikiclean(b.get('country', ''))
            office = ('label', office_title(f'United States Ambassador to {country}')) if country else ('other', None)
        elif legislature:
            # "state_senate = Louisiana State" is the Louisiana State Senate.
            st = re.sub(r'\s+State$', '', STATE_PAGE.get(wikiclean(b[legislature]), wikiclean(b[legislature])))
            kind = 'upper' if legislature == 'state_senate' else 'lower'
            name = f'{st} Legislature' if legislature == 'state_legislature' else chamber_name(kind, st)
            office = ('label', f'member of the {name}') if st in STATES.values() else ('other', None)
        elif state:
            office = ('house', state) if (b.get('district') or b.get('constituency')) else ('senate', state)
        if office and office[0] == 'house' and (b.get('constituency') or b.get('district')):
            seats_value = b.get('constituency') or b.get('district')
        elif office and office[0] != 'house':
            seats_value = ''
        if not office or office[0] == 'other':
            continue
        # A block for an office not held: "term_label = Elected posthumously" (Mel Carnahan), "status = Nominee".
        if not held or re.search(r'\belect|nominee|designate', wikiclean(b.get('term_label', '') + ' ' + b.get('status', '')), re.I):
            continue
        # The dates: term_startN and term_endN, or one termN field ("1786–1787").
        if b.get('term_start'):
            s_text, e_text = wikiclean(b['term_start']), wikiclean(b.get('term_end', ''))
            fd, fp = date_in(s_text)
            current = not e_text or bool(re.search(r'\b(present|incumbent)\b', e_text, re.I))
            ud, up = (None, 0) if current else date_in(e_text)
            if fd is None or (ud is None and not current):
                continue
            spans = [(fd, fp, ud, up)]
        elif b.get('term'):
            spans = term_spans(b['term'])
        else:
            continue
        for fd, fp, ud, up in spans:
            f, u = int(fd[:4]), (int(ud[:4]) if ud else None)
            # New Hampshire's legislature is sworn in in December, so a January date in an odd year (Wikipedia has
            # "January 1989" for Charles Bass's state Senate term) is the December before.
            if office[0] == 'label' and re.search(r'New Hampshire (House of Representatives|Senate)', office[1]):
                if fd[5:7] == '01' and f % 2 == 1:
                    f, fd, fp = f - 1, f'{f - 1:04d}-12-01', 10
                if ud and ud[5:7] == '01' and u % 2 == 1:
                    u, ud, up = u - 1, f'{u - 1:04d}-12-01', 10
            if (born and f < born + 16) or f > (died or now) or (u is not None and u < f) or (died and (u is None or u > died + 1)):
                left.append((office, f, u))
                continue
            if not died and fd > today:   # begins later this year (Alaska's governor takes office in December)
                continue
            if office[0] == 'house':
                if office[1] not in STATES.values():
                    continue
                for seat, a, z in house_seats(seats_value, f, u):
                    st, num = (STATES[seat[:2]], seat[3:]) if seat else (None, None)
                    dist = '' if not seat else (f"{st}'s at-large congressional district" if num == 'AL' else f"{st}'s {int(num)}th congressional district")
                    whole = (a, z) == (f, u)
                    rows.append(('United States representative', fd if whole else f'{a:04d}-01-01', (ud or '') if whole else (f'{z:04d}-01-01' if z else ''),
                                 dist, 'wp', fp if whole else 9, up if whole else 9))
            elif office[0] == 'senate':
                if office[1] in STATES.values():
                    rows.append(('United States senator', fd, ud or '', f'{office[1]} Class 1 senate seat', 'wp', fp, up))
            else:
                rows.append((office[1], fd, ud or '', '', 'wp', fp, up))
    return rows, left


def lead_texts(titles):
    """The wikitext of each article's lead section (where its infobox is): {title: text}, following redirects."""
    out = {}
    for batch in stable_batches(titles, 200, 20):
        d = wp({'action': 'query', 'prop': 'revisions', 'rvprop': 'content', 'rvslots': 'main', 'rvsection': 0,
                'redirects': 1, 'titles': '|'.join(batch)})
        q = d.get('query', {})
        back = {}
        for n in q.get('normalized', []):
            back[n['to']] = n['from']
        for rd in q.get('redirects', []):
            back[rd['to']] = back.get(rd['from'], rd['from'])
        for page in q.get('pages', []):
            if page.get('revisions'):
                out[back.get(page['title'], page['title'])] = page['revisions'][0]['slots']['main']['content']
    return out


# Wikidata statements known to be wrong, left out: (person, position label, start year or None), each with the source.
WIKIDATA_WRONG = {
    # John Adams was commissioner to France in 1778-79, never minister; Jefferson was minister in 1788
    # (Wikipedia, John Adams and List of ambassadors of the United States to France).
    ('Q11806', 'United States Ambassador to France', 1788),
    # James Madison sat in the House in 1793-97 but was never its Speaker (Wikipedia, List of speakers of the United
    # States House of Representatives).
    ('Q11813', 'Speaker of the United States House of Representatives', 1793),
    # John C. Breckinridge declined the mission to Spain (Wikipedia, John C. Breckinridge).
    ('Q273212', 'United States Ambassador to Spain', None),
    # George H. W. Bush headed the Liaison Office in Beijing in 1974-75; the United States had no ambassador to China
    # until 1979 (Wikipedia, George H. W. Bush and List of ambassadors of the United States to China).
    ('Q23505', 'United States Ambassador to China', 1974),
}
# Terms both sources get wrong, set from other sources: {person: {title: [(where, from, to)]}}.
OFFICES_FIXED = {
    # Benjamin Butler: the 5th district 1867-73, the 6th 1873-75, the 7th 1877-79 (The Political Graveyard; Wikipedia's
    # member lists for Massachusetts's 5th, 6th and 7th districts); his infobox has the 6th and the 7th for the first two.
    'Q817488': {'U.S. Representative': [('MA-05', 1867, 1873), ('MA-06', 1873, 1875), ('MA-07', 1877, 1879)]},
    # Lynn Martin left the Illinois Senate in 1980, before she entered the House: W. Timothy Simms took her seat in
    # December 1980 (Wikipedia, W. Timothy Simms; the Biographical Directory has her state Senate years as 1979-1980).
    # Her infobox ends the term in January 1981.
    'Q275753': {'Illinois Senate': [('', 1979, 1980)]},
}


def offices_shown(raw, died=None, wins=(), now=None, qid=None):
    """The offices worth listing, merged into spans: [{t: title, w: where, f: from year, u: to year (None: now)}].
    raw: rows (label, from, to, district, source 'wd' or 'wp', from precision, to precision) from Wikidata and the
    Wikipedia infobox. Where the two give the same term within a year at each end, each end comes from whichever
    states it more exactly (Wikidata knows Jim Risch's first Idaho Senate term only as 1974-1989; the infobox has
    December 1, 1988). For someone who has died, a term with no end date has an unknown end, not "present": x marks
    those spans. wins: the person's House and Senate wins in the archive, [(kind, race key, year)]: an open House or
    Senate term closes when the term of their last win in that seat has run out, and a term the archive shows them
    winning since 2020 is added where neither source has it. Terms that haven't begun (2027) are left out."""
    now = now or time.localtime().tm_year
    spans, rank_of, undated, names = {}, {}, {}, {}
    for row in raw:
        label, frm, to, dist = row[:4]
        src = row[4] if len(row) > 4 else 'wd'
        fp = row[5] if len(row) > 5 else 9
        up = row[6] if len(row) > 6 else 9
        rule = next((r for r in OFFICE_RULES if re.match(r[0], label)), None)
        if not rule or (qid, label, int(frm[:4]) if frm else None) in WIKIDATA_WRONG:
            continue
        shown = rule[1] or re.sub(r'^[Mm]ember of the ', '', label)
        title = office_title(shown)
        if not frm:
            # No dates in either source (Thomas Pinckney's mission to Britain): listed by name only, last.
            undated[title] = rule[2]
            names.setdefault(title, set()).add(shown)
            continue
        f, u = int(frm[:4]), (int(to[:4]) if to else None)
        # Nebraska's legislature has had one chamber since 1937: Wikidata's "Nebraska House of Representatives" for
        # a later term is the Legislature (Deb Fischer, 2005-2013).
        if title == 'Nebraska House of Representatives' and f >= 1937:
            title = shown = 'Nebraska Legislature'
        names.setdefault(title, set()).add(shown)
        where = ''
        if title == 'U.S. Senator':
            m = re.match(r'^(.+?) Class \d senate seat', dist)
            where = m.group(1) if m else ''
        elif title == 'U.S. Representative':
            m = re.match(r"^(.+?)['’]s? (?:(\d+)(?:st|nd|rd|th)|(at-large)) congressional district", dist)
            if m and m.group(1) in CODE:
                where = f"{CODE[m.group(1)]}-{int(m.group(2)):02d}" if m.group(2) else f"{CODE[m.group(1)]}-AL"
        key = (title, where)
        spans.setdefault(key, []).append([f, u, src, fp, up, frm[:10], (to or '')[:10]])
        rank_of[key] = rule[2]
    # Wikidata gives a seat in Congress Congress by Congress, and can start a member who came in partway through one
    # on the Congress's first day: Joseph Gaydos won a special election on November 5, 1968, and Wikidata has him from
    # January 3, 1967. Where the infobox starts a term inside such a statement, and no term of its own covers the
    # statement's first day, the statement starts when the infobox's term does; the same for a term ending inside one.
    for (title, where), terms in spans.items():
        if title not in ('U.S. Representative', 'U.S. Senator'):
            continue
        ours = [t for t in terms if t[2] == 'wp']
        covers = lambda day: any(t[5] <= day and (not t[6] or t[6] >= day) for t in ours)
        for d in terms:
            if d[2] != 'wd' or not d[6] or d[3] < 11 or d[4] < 11 or d[1] - d[0] > 2:
                continue
            starts = [t for t in ours if t[3] >= 10 and d[5] < t[5] < d[6]]
            if starts and not covers(d[5]):
                first = min(starts, key=lambda t: t[5])
                d[0], d[3], d[5] = first[0], first[3], first[5]
            ends = [t for t in ours if t[6] and t[4] >= 10 and d[5] < t[6] < d[6]]
            if ends and not covers(d[6]):
                last = max(ends, key=lambda t: t[6])
                d[1], d[4], d[6] = last[1], last[4], last[6]
    # One term from both sources: each end from the more exact of the two.
    near = lambda a, b: (a is None and b is None) or (a is not None and b is not None and abs(a - b) <= 1)
    for key, terms in spans.items():
        kept, used = [], set()
        for i, w in enumerate(terms):
            if w[2] != 'wp':
                continue
            for j, d in enumerate(terms):
                if d[2] == 'wd' and j not in used and near(w[0], d[0]) and near(w[1], d[1]):
                    used.add(j)
                    w = [w[0] if w[3] >= d[3] else d[0], w[1] if w[4] >= d[4] else d[1], 'wp', max(w[3], d[3]), max(w[4], d[4])]
            kept.append(w)
        spans[key] = [[t[0], t[1]] for t in kept] + [[t[0], t[1]] for j, t in enumerate(terms) if t[2] == 'wd' and j not in used]
    for fixed_title, rows in OFFICES_FIXED.get(qid, {}).items():
        rank = next((rank_of[k] for k in spans if k[0] == fixed_title), None)
        for k in [k for k in spans if k[0] == fixed_title]:
            del spans[k]
        for where, f, u in rows:
            spans.setdefault((fixed_title, where), []).append([f, u])
            rank_of[(fixed_title, where)] = rank if rank is not None else next(r[2] for r in OFFICE_RULES if r[1] == fixed_title)
    for title in ('U.S. Representative', 'U.S. Senator'):
        placed = [t for (ti, w), ts in spans.items() if ti == title and w for t in ts]
        bare = spans.get((title, ''), [])
        keep = [t for t in bare if not any(t[0] <= (p[1] if p[1] is not None else 9999) and p[0] <= (t[1] if t[1] is not None else 9999) for p in placed)]
        if (title, '') in spans:
            if keep:
                spans[(title, '')] = keep
            else:
                del spans[(title, '')]
    seat = lambda kind, key: ('U.S. Representative', key) if kind == 'H' else ('U.S. Senator', STATES[key[:2]])
    last_win = {}
    for kind, key, y in wins:
        last_win[seat(kind, key)] = max(last_win.get(seat(kind, key), 0), y)
        if y >= 2020:
            k = seat(kind, key)
            end = y + (3 if kind == 'H' else 7)
            if not any(f <= y + 1 and (u is None or u >= y + 2) for f, u in spans.get(k, [])):
                spans.setdefault(k, []).append([y + 1, end if end <= now else None])
                rank_of[k] = 4 if kind == 'H' else 3
    out = []
    for (title, where), terms in spans.items():
        # [from, to, end unknown]; an unknown end counts as the start year while merging.
        terms = sorted(([f, f if (u is None and died) else u, u is None and bool(died)] for f, u in terms), key=lambda t: t[0])
        merged = [terms[0][:]]
        for f, u, x in terms[1:]:
            last = merged[-1]
            if last[1] is not None and f <= last[1] + 1:
                if u is None:
                    last[1] = None
                elif u >= last[1]:
                    last[1], last[2] = u, x
            elif last[1] is None:
                continue
            else:
                merged.append([f, u, x])
        shown = max(names.get(title, {title}), key=len) if title.startswith('Mayor of ') else title
        for f, u, x in merged:
            if f > now:
                continue
            last = last_win.get((title, where))
            if u is None and not x and last:
                end = last + (3 if title == 'U.S. Representative' else 7)
                if end <= now:
                    u = max(end, f)
            o = {'t': shown, 'w': where, 'f': f, 'u': None if x else u, 'r': rank_of[(title, where)], 'e': u}
            if x:
                o['x'] = True
            out.append(o)
    for title, rank in undated.items():
        shown = max(names.get(title, {title}), key=len) if title.startswith('Mayor of ') else title
        if not any(office_title(o['t']) == title for o in out) and title not in ('U.S. Representative', 'U.S. Senator'):
            out.append({'t': shown, 'w': '', 'f': None, 'u': None, 'r': rank, 'e': None, 'n': True})
    # A territory's governorship under the state's name (Wikidata has Lewis Cass as "Governor of Michigan" for his
    # years governing the Michigan Territory): the state's line goes where the territory's covers the same years.
    for t in [o for o in out if re.match(r'^Governor of (the )?.+ Territory$', o['t']) and o['f']]:
        state = re.sub(r'^Governor of (the )?(.+) Territory$', r'\2', t['t'])
        out = [o for o in out if not (o['t'] == f'Governor of {state}' and o['f'] and o['f'] < (t['e'] or now + 1) and t['f'] < (o['e'] or now + 1))]
    # A member holds one House district at a time. Where the spans of two districts overlap (Wikidata has Tip
    # O'Neill in MA-11 until 1987, though he moved to MA-08 in 1963, and Chuck Schumer in NY-09 for his whole House
    # career, 1981-1999), each year goes to the most specific span covering it: the shortest.
    house = [o for o in out if o['t'] == 'U.S. Representative' and o['w'] and o['f'] is not None]
    if len(house) > 1:
        def years(o):
            end = o['u'] if o['u'] is not None else (o['e'] if o.get('x') else now + 1)
            return range(o['f'], max(o['f'] + 1, end))
        owner = {}
        for i, o in sorted(enumerate(house), key=lambda io: len(years(io[1]))):
            for y in years(o):
                owner.setdefault(y, i)
        rebuilt = []
        for i, o in enumerate(house):
            mine = [y for y in years(o) if owner[y] == i]
            last_year = years(o)[-1]
            start = None
            for k, y in enumerate(mine):
                start = y if start is None else start
                if k + 1 == len(mine) or mine[k + 1] != y + 1:
                    span = dict(o, f=start)
                    if y != last_year:   # cut short by another district: it ends where that one begins
                        span['u'] = span['e'] = y + 1
                        span.pop('x', None)
                    rebuilt.append(span)
                    start = None
        out = [o for o in out if not any(o is h for h in house)] + rebuilt
    # House seats change number with redistricting: one line per district, newest first, then by rank.
    end = lambda o: o['u'] if o['u'] is not None else (o['e'] if o.get('x') else 9999)   # e: the last year known
    out.sort(key=lambda o: (bool(o.get('n')), -end(o) if not o.get('n') else 0, o['r'], -(o['f'] or 0)))
    for o in out:
        del o['r'], o['e']
    return out


# ------------------------------------------------------------------------------------------- main

def main():
    os.makedirs(CACHE, exist_ok=True)
    log('Archive')
    races = load_archive()
    presidential = load_presidential()
    log(f'  {len(races)} House and Senate races, {len(presidential)} presidential elections')

    log('Seats (Wikidata)')
    holders = seat_holders()
    winners = match_winners(races, holders)

    links = {}   # (year, kind, key, candidate name) -> qid, from a seat or a link
    links.update(winners)
    how = {k: 'seat' for k in winners}   # how each link was made, for checking (pipeline/.cache/people-links.json)
    titles = {}  # article title -> qid

    log('Senate nominees (Wikipedia infoboxes)')
    want = {}
    for r in races:
        if r['kind'] == 'S':
            for t in senate_titles(r):
                want[t] = r
    texts = wikitexts(list(want))
    senate_boxes = {}
    for asked, (final, text) in texts.items():
        r = want[asked]
        senate_boxes.setdefault((r['year'], r['key']), (r, nominees(infobox(text)), final))
    log(f'  {len(senate_boxes)} of {sum(1 for r in races if r["kind"] == "S")} Senate races have an article with an infobox')

    # House candidates in the latest elections, where Wikidata's seat records lag (most of 2022's and 2024's
    # winners have none yet): the links on their names in Wikipedia's article on that year's House elections in
    # their state. A link counts when it is the only one whose name fits a candidate (same surname, a first name
    # they go by) and no one else in the state's races that year has that name. Where it and the seat disagree,
    # the article wins: in those years the seat records hold stale, open-ended terms (Tom Malinowski still "in"
    # NJ-07 after Tom Kean Jr. beat him in 2022).
    log('House candidates 2020-2024 (Wikipedia state articles)')
    want_h = {}
    for r in races:
        if r['kind'] == 'H' and r['year'] >= 2020:
            want_h[f"{r['year']} United States House of Representatives elections in {STATES[r['state']]}"] = (r['year'], r['state'])
    found_h = {}
    for asked, (final, text) in wikitexts(sorted(want_h)).items():
        y, st = want_h[asked]
        cands = [(r['key'], c[0]) for r in races if r['kind'] == 'H' and r['year'] == y and r['state'] == st for c in r['cands']]
        twice = {name for name in {n for _, n in cands} if sum(1 for _, n in cands if n == name) > 1}
        by_surname = {}   # surname -> [(key, name, call names)], so each link is checked against a few candidates only
        for key, name in cands:
            t = tokens(name)
            if len(t) >= 2 and name not in twice:
                by_surname.setdefault(t[-1], []).append((key, name, call_names(name)))
        targets = {}
        for m in re.finditer(r'\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]', text):
            target, shown = m.group(1).strip().lstrip(':'), (m.group(2) or m.group(1)).strip()
            for label in {shown, target}:
                u = tokens(label)
                if len(u) < 2 or u[-1] not in by_surname:
                    continue
                calls = call_names(label)
                for key, name, cn in by_surname[u[-1]]:
                    if compatible(calls, cn, initials=False):
                        targets.setdefault((key, name), set()).add(target)
        for (key, name), ts in targets.items():
            if len(ts) == 1:
                found_h[(y, 'H', key, name)] = next(iter(ts))
    t3 = qids_of_titles(sorted(set(found_h.values())))
    h_added, h_clash = 0, []
    for k, title in found_h.items():
        if title not in t3 or links.get(k) == t3[title][0]:
            continue
        if k in links:
            h_clash.append((k, links[k], t3[title][0], title))
        else:
            h_added += 1
        links[k] = t3[title][0]
        how[k] = 'article'
    log(f'  House candidates linked through the state articles: {h_added} more; seat and article disagree: {len(h_clash)} (the article kept)')
    for c in h_clash[:12]:
        log('    clash:', c)

    log('Presidential candidates (Wikipedia infoboxes, then Wikidata)')
    pres_titles = [presidential_title(y) for y in sorted(presidential)]
    pres_boxes, pres_texts = {}, {}
    for asked, (final, text) in wikitexts(pres_titles).items():
        y = 1788 if asked.startswith('1788') else int(asked[:4])
        pres_boxes[y] = nominees(infobox(text))
        pres_texts[y] = text
    # An infobox shows the main nominees only. Wikidata's item for each election lists more of its candidates
    # (P726), and some people list their candidacies (P3602): Aaron Burr in 1792, Ralph Nader in 2000.
    items = qids_of_titles(pres_titles)
    e2y = {items[t][0]: (1788 if t.startswith('1788') else int(t[:4])) for t in pres_titles if t in items}
    listed = sparql('''SELECT ?e ?c ?cLabel WHERE { VALUES ?e { %s } { ?e wdt:P726 ?c } UNION { ?c wdt:P3602 ?e }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". } }''' % ' '.join(f'wd:{q}' for q in e2y))

    log('2026 candidates')
    race26 = json.load(open(os.path.join(ROOT, 'data', 'races.json')))['races']
    runs26 = [(r, c) for r in race26 for c in r.get('candidates', []) if c.get('wiki')]

    all_titles = [t for _, noms, _ in senate_boxes.values() for t, _ in noms]
    all_titles += [t for noms in pres_boxes.values() for t, _ in noms]
    all_titles += [c['wiki'] for _, c in runs26]
    t2q = qids_of_titles(all_titles)
    log(f'  {len(t2q)} of {len(set(all_titles))} linked articles have a Wikidata item')

    # Senate nominees: the infobox name that is one of the candidates in our race (pick). Where the seat already
    # named the winner, the two should agree; where they don't, the infobox names the nominee and the seat someone
    # appointed to it (Jean Carnahan for her late husband Mel, 2000), so the infobox's answer is kept.
    clashes = []
    for (y, key), (r, noms, _) in senate_boxes.items():
        for title, shown in noms:
            name = pick(shown, title, [c[0] for c in r['cands']]) if title in t2q else None
            if not name:
                continue
            k = (y, 'S', key, name)
            if k in links and links[k] == t2q[title][0]:
                continue
            if k in links:
                clashes.append((y, key, name, links[k], t2q[title][0], title))
            links[k] = t2q[title][0]
            how[k] = 'infobox'
    log(f'  seat and infobox disagree (the infobox kept): {len(clashes)}')
    for c in clashes[:12]:
        log('    clash:', c)
    pres_links, pres_how = {}, {}   # (year, candidate name) -> qid, and how it was found
    for y, noms in pres_boxes.items():
        for title, shown in noms:
            name = pick(shown, title, [c['name'] for c in presidential.get(y, [])]) if title in t2q else None
            if name:
                pres_links[(y, name)] = t2q[title][0]
                pres_how[(y, name)] = 'infobox'
    by_infobox = len(pres_links)
    for r in listed:
        y, label = e2y[qid_of(r['e'])], r.get('cLabel', '')
        # A longer list than ours, with minor candidates in it: the same surname is not enough (William Wesley Cox is
        # not James M. Cox, 1920), so the given names must fit too, and only one of the year's candidates may fit.
        t = tokens(label)
        fits = [c['name'] for c in presidential.get(y, []) if same_surname(t, tokens(c['name'])) and compatible(given_names(label), given_names(c['name']))]
        if len(fits) == 1 and (y, fits[0]) not in pres_links:
            pres_links[(y, fits[0])] = qid_of(r['c'])
            pres_how[(y, fits[0])] = 'wikidata'
    by_wikidata = len(pres_links) - by_infobox
    # Last, the links on candidates' names elsewhere in the election's article (its results tables): the same full
    # name, linked to one article only. This finds the early elections' minor candidates, who won electoral votes but
    # are in neither the infobox nor Wikidata's list (Thomas Pinckney, 1796).
    found = {}
    for y, text in pres_texts.items():
        targets = {}
        for m in re.finditer(r'\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]', text):
            target, shown = m.group(1).strip().lstrip(':'), (m.group(2) or m.group(1)).strip()
            for c in presidential.get(y, []):
                full = ' '.join(tokens(c['name']))
                if full and (' '.join(tokens(shown)) == full or ' '.join(tokens(target)) == full):
                    targets.setdefault(c['name'], set()).add(target)
        for name, ts in targets.items():
            if len(ts) == 1 and (y, name) not in pres_links:
                found[(y, name)] = next(iter(ts))
    t2 = qids_of_titles(sorted(set(found.values())))
    for k, title in found.items():
        if title in t2:
            pres_links[k] = t2[title][0]
            pres_how[k] = 'article'
    log(f'  presidential candidates linked: {len(pres_links)} of {sum(len(v) for v in presidential.values())} '
        f'({by_infobox} through an infobox, {by_wikidata} through Wikidata, {len(pres_links) - by_infobox - by_wikidata} through the article)')

    people = set(links.values()) | set(pres_links.values()) | {t2q[c['wiki']][0] for _, c in runs26 if c['wiki'] in t2q}
    log(f'People: {len(people)} before details')
    info = people_details(people)
    people = {q for q in people if info[q].get('article') and info[q].get('human')}
    log(f'  {len(people)} are people with an English Wikipedia article')

    for q in people:
        x = info[q]
        x['names'] = [u for u in (tokens(n) for n in [x.get('label', '')] + sorted(x['aliases'])) if u]

    # A last check on every link: the archive's name and a name the person goes by share a surname, a typo apart at
    # most. It catches a link that leads to someone else, like the redirect from a losing candidate's name to the
    # winner's article (Bill Andersen, Tennessee 1988, to Jim Sasser).
    def agrees(name, q):
        t = tokens(name)
        return any(same_surname(t, u) or close_surname(t, u) for u in info[q]['names'])
    dropped = []
    for k in list(links):
        if links[k] in people and not agrees(k[3], links[k]):
            dropped.append((k, info[links[k]].get('label')))
            del links[k]
    for k in list(pres_links):
        if pres_links[k] in people and not agrees(k[1], pres_links[k]):
            dropped.append((k, info[pres_links[k]].get('label')))
            del pres_links[k]
    kept26 = []
    for r, c in runs26:
        q = t2q.get(c['wiki'], (None,))[0]
        if q in people and not agrees(c['name'], q):
            dropped.append(((2026, r['id'], c['name']), info[q].get('label')))
        else:
            kept26.append((r, c))
    runs26 = kept26
    log(f'  links dropped because the names disagree: {len(dropped)}')
    for d in dropped[:60]:
        log('    dropped:', d)

    # Other runs, by name: a race in a state where the person ran or served, the same surname, a first name they go
    # by (not a middle name: Bob Casey Jr.'s brother Pat ran in 1998), no other middle initial (John T Anderson is not John B. Anderson), not for a major party they never
    # belonged to (the Republican Mike Doyle of 2022 is not the Democratic congressman), old enough to run (25 for
    # the House, 30 for the Senate) and alive. Further from their known races (gap: years to the nearest one tied to
    # them by a seat or a link), more care: no suffix of another generation (W. J. "Billy" Tauzin III, 2004, is the
    # congressman's son), and beyond 10 years no suffix they never use (William J Hughes Jr., 2014) and no age over
    # 80 (James "Jim" Wright, 2004, is not the Speaker); beyond 20 years the first name must be the one they go by,
    # not a legal name (John Wright, 1980, is not Ron Wright). Never two runs in one year (two candidates in one race,
    # or two districts) except a state's regular and special Senate elections held the same day.
    home = {}
    for (y, kind, key, name), q in links.items():
        home.setdefault(q, set()).add(key[:2])
    for r, c in runs26:
        if c['wiki'] in t2q:
            home.setdefault(t2q[c['wiki']][0], set()).add(r['state'])
    by_state = {}
    for q in people:
        x = info[q]
        x['calls'] = set().union(*[call_names(n) for n in [x.get('label', '')] + sorted(x['aliases'])])
        x['sur'] = {u[-1] for u in x['names']}
        x['mid'] = set().union(*[middles(u) for u in x['names'] if len(u) >= 3])
        x['suffix'] = set().union(*[suffixes(n) for n in [x.get('label', '')] + sorted(x['aliases'])])
        x['major'] = {'D' if p == 'Democratic Party' else 'R' for p, _, _ in x['parties'] if p in ('Democratic Party', 'Republican Party')}
        x['years'] = []
        for st in home.get(q, ()):
            by_state.setdefault(st, []).append(q)
    party_of = {(r['year'], r['kind'], r['key'], c[0]): c[1] for r in races for c in r['cands']}
    for (y, kind, key, name), q in links.items():
        if q in people:
            x = info[q]
            if len(tokens(name)) >= 3:
                x['mid'] |= middles(tokens(name))
            x['suffix'] |= suffixes(name)
            x['years'].append(y)
            if party_of.get((y, kind, key, name)) in ('D', 'R'):
                x['major'].add(party_of[(y, kind, key, name)])
    for (y, name), q in pres_links.items():
        if q in people:
            info[q]['years'].append(y)
    for r, c in runs26:
        q = t2q.get(c['wiki'], (None,))[0]
        if q in people:
            info[q]['years'].append(2026)
            if c.get('party') in ('D', 'R'):
                info[q]['major'].add(c['party'])
    proposals = {}
    for r in races:
        for c in r['cands']:
            k = (r['year'], r['kind'], r['key'], c[0])
            t = tokens(c[0])
            if k in links or len(t) < 2:
                continue
            fits = []
            for q in by_state.get(r['state'], []):
                x = info[q]
                born = int(x['born'][:4]) if x.get('born') else None
                died = int(x['died'][:4]) if x.get('died') else None
                sfx = suffixes(c[0])
                gap = min(abs(r['year'] - yy) for yy in x['years']) if x['years'] else 0
                age = r['year'] - born if born is not None else None
                first = (tokens(x.get('label', '')) or [''])[0]
                usual = t[0] == first or t[0] in NICK.get(first, ()) or first in NICK.get(t[0], ())
                if t[-1] in x['sur'] and compatible(call_names(c[0]), x['calls'], initials=False) \
                        and not (middles(t) and x['mid'] and not middles(t) & x['mid']) \
                        and not (c[1] in ('D', 'R') and x['major'] and c[1] not in x['major']) \
                        and (age is None or age >= (25 if r['kind'] == 'H' else 30)) and (died is None or r['year'] <= died) \
                        and not (sfx and x['suffix'] and not sfx & x['suffix']) \
                        and not (gap > 10 and ((sfx and not x['suffix']) or (age is not None and age > 80))) \
                        and not (gap > 20 and not usual):
                    fits.append(q)
            if len(fits) == 1:
                proposals[k] = fits[0]

    def clash(a, b):
        """Two runs the same person can't both have made: the same year, unless a state's two Senate races."""
        return a[0] == b[0] and not (a[1] == b[1] == 'S' and a[2][:2] == b[2][:2] and a[2] != b[2])
    runs_of = {}
    for k, q in list(links.items()) + list(proposals.items()):
        runs_of.setdefault(q, []).append(k)
    added, refused = 0, []
    for k, q in proposals.items():
        if any(clash(k, o) for o in runs_of[q] if o != k):
            refused.append((k, info[q].get('label')))
            continue
        links[k] = q
        how[k] = 'name'
        added += 1
    log(f'  other runs found by name in the same state: {added}; refused as a second run that year: {len(refused)}')
    for x in refused[:8]:
        log('    refused:', x)

    log('Summaries and infoboxes (Wikipedia)')
    ex = extracts([info[q]['article'] for q in people])
    leads = lead_texts([info[q]['article'] for q in people])
    wp_rows, wp_left = {}, []
    for q in people:
        rows, left = infobox_offices(leads.get(info[q]['article']), info[q].get('born'), info[q].get('died'))
        wp_rows[q] = rows
        wp_left += [(info[q].get('label'), x) for x in left]
    log(f"  infobox offices: {sum(len(r) for r in wp_rows.values())} terms for {sum(1 for r in wp_rows.values() if r)} people; "
        f"{len(wp_left)} left out as impossible dates")
    for x in wp_left[:12]:
        log('    left out:', x)
    photos = json.load(open(os.path.join(ROOT, 'data', 'photos.json')))['people']

    # Each person's races, newest first.
    history = {q: [] for q in people}
    for r in races:
        for c in r['cands']:
            q = links.get((r['year'], r['kind'], r['key'], c[0]))
            if q in history:
                share = round(100 * c[2] / r['total'], 2) if r['total'] and c[2] is not None else None
                row = {'y': r['year'], 'o': r['kind'], 'k': r['key'], 'p': c[1], 'v': c[2], 's': share,
                       'w': bool(r['winner'] and c[0] == r['winner']), 'n': c[0]}
                if r.get('unopposed'):
                    row['u'] = True   # no votes counted for an unopposed race in the returns
                if r.get('void'):
                    row['void'] = True   # never certified (North Carolina's 9th, 2018): neither won nor lost
                history[q].append(row)
    for (y, name), q in pres_links.items():
        if q in history:
            c = next(x for x in presidential[y] if x['name'] == name)
            share = round(100 * c['pv'] / c['total'], 2) if c.get('pv') and c.get('total') else None
            row = {'y': y, 'o': 'P', 'k': None, 'p': c['party'], 'v': c.get('pv'), 's': share, 'ev': c['ev'], 'w': c['won'], 'n': name}
            if c.get('vp'):
                row['vp'] = True
            history[q].append(row)
    for r, c in runs26:
        q = t2q.get(c['wiki'], (None,))[0]
        if q in history:
            kind = KIND_2026.get(r['type'], r['type'])
            history[q].append({'y': 2026, 'o': kind, 'k': r['id'], 'p': c.get('party'), 'n': c['name'], 'race': r['id']})
    for q in history:
        history[q].sort(key=lambda h: (-h['y'], ORDER.index(h['o']) if h['o'] in ORDER else 9))
    people = {q for q in people if history[q]}

    # Slugs from article titles: stable, and unique because titles are.
    slug_of, seen = {}, {}
    for q in sorted(people):
        s = slugify(info[q]['article'])
        if s in seen:
            s = f'{s}-{q.lower()}'
        seen[s] = q
        slug_of[q] = s

    # Written to data/people.new and swapped in at the end, so a failed run never leaves a half-written folder.
    new = OUT + '.new'
    shutil.rmtree(new, ignore_errors=True)
    os.makedirs(os.path.join(new, 'p'))
    os.makedirs(os.path.join(new, 'years'))
    index, raw_offices = [], {}
    for q in sorted(people):
        x, s = info[q], slug_of[q]
        art = x['article']
        photo = photos.get(art)
        wins = [(h['o'], h['k'], h['y']) for h in history[q] if h['o'] in 'HS' and h.get('w') and h['y'] <= 2024]
        offices = offices_shown(x['offices'] + wp_rows.get(q, []), died=x.get('died'), wins=wins, qid=q)
        raw_offices[s] = x['offices'] + wp_rows.get(q, [])
        # A description whose years contradict the birth date (Wikidata has "(1745-1828)" for Thomas Pinckney, born
        # in 1750) loses the years.
        desc = x.get('desc')
        m = re.search(r'\s*\((\d{4})\s*[–-]\s*(\d{4})\)\s*$', desc or '')
        if m and ((x.get('born') and m.group(1) != x['born'][:4]) or (x.get('died') and m.group(2) != x['died'][:4])):
            desc = desc[:m.start()]
        prof = {
            'slug': s, 'qid': q, 'name': x.get('label') or art, 'desc': desc, 'article': art,
            'born': (x.get('born') or '')[:10] or None, 'died': (x.get('died') or '')[:10] or None, 'birthplace': x.get('bpLabel') if x.get('bpLabel') and not re.match(r'^(Q\d+$|https?://)', x['bpLabel']) else None,
            'parties': party_order(x['parties']),
            'offices': offices, 'summary': ex.get(art), 'photo': photo, 'history': history[q],
        }
        with open(os.path.join(new, 'p', s + '.json'), 'w') as f:
            json.dump(prof, f, ensure_ascii=False, separators=(',', ':'))
        years = sorted({h['y'] for h in history[q]})
        states = sorted({(h['k'] or '')[:2] for h in history[q] if h['o'] != 'P' and h['k']})
        index.append({'s': s, 'n': prof['name'], 'd': x.get('desc') or '', 'st': states, 'y': [years[0], years[-1]] if years else None})
    index.sort(key=lambda e: (surname(e['n']), e['n'], e['s']))   # the slug settles ties, so every run writes the same file
    with open(os.path.join(new, 'index.json'), 'w') as f:
        json.dump({'built': time.strftime('%Y-%m-%d'), 'source': 'Wikidata (CC0) and Wikipedia (CC BY-SA 4.0); results from the archive',
                   'people': index}, f, ensure_ascii=False, separators=(',', ':'))

    # The names on each archive page (and the 2026 race pages) that have a profile.
    years = {}
    for (y, kind, key, name), q in links.items():
        if q in slug_of:
            sec = {'S': 'senate', 'H': 'house'}[kind]
            years.setdefault(y, {}).setdefault(sec, {}).setdefault(key, {})[name] = slug_of[q]
    for (y, name), q in pres_links.items():
        if q in slug_of:
            years.setdefault(y, {}).setdefault('president', {})[name] = slug_of[q]
    for r, c in runs26:
        q = t2q.get(c['wiki'], (None,))[0]
        if q in slug_of:
            years.setdefault(2026, {}).setdefault('races', {}).setdefault(r['id'], {})[c['name']] = slug_of[q]
    # A file for every year with names on its page, empty or not, so a page never asks for one that isn't there.
    for y in {r['year'] for r in races} | set(presidential) | {2026}:
        years.setdefault(y, {})
    for y, d in sorted(years.items()):
        with open(os.path.join(new, 'years', f'{y}.json'), 'w') as f:
            json.dump(d, f, ensure_ascii=False, separators=(',', ':'))
    audit = [{'y': y, 'o': kind, 'k': key, 'n': name, 'q': q, 's': slug_of[q], 'how': how.get((y, kind, key, name), '?')}
             for (y, kind, key, name), q in links.items() if q in slug_of]
    audit += [{'y': y, 'o': 'P', 'k': None, 'n': name, 'q': q, 's': slug_of[q], 'how': pres_how.get((y, name), '?')} for (y, name), q in pres_links.items() if q in slug_of]
    audit += [{'y': 2026, 'o': KIND_2026.get(r['type'], r['type']), 'k': r['id'], 'n': c['name'], 'q': t2q[c['wiki']][0], 's': slug_of[t2q[c['wiki']][0]], 'how': 'link'}
              for r, c in runs26 if c['wiki'] in t2q and t2q[c['wiki']][0] in slug_of]
    with open(os.path.join(ROOT, 'pipeline', '.cache', 'people-links.json'), 'w') as f:
        json.dump(audit, f, ensure_ascii=False, indent=0)
    # Each profile's office rows from both sources before they are merged, for checking.
    with open(os.path.join(ROOT, 'pipeline', '.cache', 'people-offices.json'), 'w') as f:
        json.dump(raw_offices, f, ensure_ascii=False)
    old = OUT + '.old'
    shutil.rmtree(old, ignore_errors=True)
    if os.path.exists(OUT):
        os.rename(OUT, old)
    os.rename(new, OUT)
    shutil.rmtree(old, ignore_errors=True)
    log(f'Wrote {len(index)} profiles, {len(years)} year files to data/people')


if __name__ == '__main__':
    main()
