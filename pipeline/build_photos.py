#!/usr/bin/env python3
"""Candidate photos: the lead image of each candidate's Wikipedia article, when it is freely licensed.

The race tables on Wikipedia link each candidate's name to their article, and only that link is used, so a
photo is never matched on a name alone (Alaska has two unrelated Dan Sullivans on the ballot; Michigan's and
Alabama's Mike Rogers are different people). For each linked article: its free lead image (PageImages), kept
only under a license that allows reuse with credit (public domain, CC0, CC BY, CC BY-SA). A 500px rendition is
downloaded, pipeline/facecrop.swift crops a square around the face (or rejects the image: no face, several
faces, too small) and a 192px JPEG is written to assets/img/people/.

data/photos.json = {"people": {article: {f, by, lic, licUrl, page}}, "races": {race id: {candidate name: article}}}

Every linked article must be about a person (Wikidata: instance of human), so a link to a party, a place or the
race itself can never supply a picture.

Usage (macOS, needs Swift):  python3 pipeline/build_photos.py [--limit N]
Re-run when the candidate list changes; the race list freezes when polls close, so this is a pre-election job.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html import unescape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_races as B  # noqa: E402
from wikitables import tables  # noqa: E402

ROOT = B.ROOT
OUT_DIR = os.path.join(ROOT, 'assets', 'img', 'people')
RAW = os.path.join(B.CACHE, 'photos')
OUT = os.path.join(ROOT, 'data', 'photos.json')
FACECROP = os.path.join(ROOT, 'pipeline', 'facecrop.swift')
UA = 'BallotDesk/1.0 (https://ballotdesk.org; https://github.com/YutongHanOfficial/ballot-desk)'
API = 'https://en.wikipedia.org/w/api.php'
SIZE = 192


def get(url, binary=False, tries=5):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            return data if binary else json.loads(data)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == tries - 1:
                raise
            time.sleep(int(e.headers.get('Retry-After') or 0) or 5 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError):
            if attempt == tries - 1:
                raise
            time.sleep(3 * (attempt + 1))


def query(**params):
    q = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'formatversion': 2, **params})
    time.sleep(0.2)
    return get(f'{API}?{q}')['query']


def humans(qids):
    """The Wikidata items in qids that are instances of human (Q5)."""
    found = set()
    for batch in chunks(sorted(qids), 300):
        sparql = 'SELECT ?i WHERE { VALUES ?i { %s } ?i wdt:P31 wd:Q5 }' % ' '.join(f'wd:{q}' for q in batch)
        req = urllib.request.Request('https://query.wikidata.org/sparql', data=urllib.parse.urlencode({'query': sparql}).encode(),
                                     headers={'User-Agent': UA, 'Accept': 'application/sparql-results+json'})
        with urllib.request.urlopen(req, timeout=120) as r:
            rows = json.load(r)['results']['bindings']
        found |= {row['i']['value'].rsplit('/', 1)[-1] for row in rows}
        time.sleep(1)
    return found


def chunks(xs, n=50):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def plain(html, limit=120):
    s = unescape(re.sub(r'<[^>]+>', ' ', html or ''))
    s = ' '.join(s.split())
    return s if len(s) <= limit else s[:limit - 1].rstrip() + '…'


def license_name(short):
    """A license we can use with credit, as shown on the site; None for anything else."""
    s = (short or '').strip().lower()
    if s.startswith('cc0') or s == 'cc-zero':
        return 'CC0'
    if s in ('public domain', 'pd') or s.startswith(('pd-', 'public domain')):
        return 'Public domain'
    m = re.match(r'^cc[ -]by(-sa)?[ -](\d\.\d)', s)
    if m:
        return f"CC BY{'-SA' if m.group(1) else ''} {m.group(2)}"
    if s == 'attribution':
        return 'Attribution'
    if s == 'copyrighted free use':   # the holder allows any use (Commons {{Copyrighted free use}})
        return 'Free use'
    if s == 'wtfpl':
        return 'WTFPL'
    return None


def slug(title):
    s = unicodedata.normalize('NFKD', title).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


def linked_candidates():
    """{race id: [candidates with `wiki`]} from the race tables, parsed exactly as build_races does."""
    html = {k: B.wiki(B.PAGES[k]) for k in ('senate', 'house', 'house_ratings', 'governor', 'ltgov', 'ag', 'sos')}
    groups = [B.parse_senate(html['senate']), B.parse_house(html['house'], html['house_ratings']),
              B.parse_statewide(tables(html['governor']), 'gov', 'States', ['Governor', 'Candidates']),
              B.parse_statewide(tables(html['ltgov']), 'ltgov', 'Race summary', ['Candidates']),
              B.parse_statewide(tables(html['ag']), 'ag', 'States', ['Candidates']),
              B.parse_statewide(tables(html['sos']), 'sos', 'Race summary', ['Candidates'])]
    return {r['id']: r['candidates'] for g in groups for r in g.values()}


def article_for(name, party, parsed):
    """The article linked for this candidate in the race's own table, or None."""
    exact = [p for p in parsed if p['name'] == name]
    if exact:   # an unlinked exact name stays unlinked: no falling back to a namesake
        return exact[0].get('wiki')
    loose = [p for p in parsed if B.same_person(p['name'], name) and p['party'] == party]
    return loose[0].get('wiki') if len(loose) == 1 else None


def main():
    limit = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else None
    races = json.load(open(os.path.join(ROOT, 'data', 'races.json'), encoding='utf-8'))['races']
    parsed = linked_candidates()
    wanted = {}   # race id -> {name: article}
    for r in races:
        for c in r.get('candidates') or []:
            t = c.get('wiki') or article_for(c['name'], c['party'], parsed.get(r['id'], []))
            if t:
                wanted.setdefault(r['id'], {})[c['name']] = t
    titles = sorted({t for m in wanted.values() for t in m.values()})
    if limit:
        titles = titles[:limit]
    print(f'{len(titles)} linked candidate articles in {len(wanted)} races')

    # Article -> final title (after redirects) and its free lead image.
    page = {}
    for batch in chunks(titles):
        q = query(prop='pageimages|pageprops', piprop='name', pilicense='free', pilimit=50,
                  ppprop='disambiguation|wikibase_item', redirects=1, titles='|'.join(batch))
        norm = {x['from']: x['to'] for x in q.get('normalized', [])}
        redir = {x['from']: x['to'] for x in q.get('redirects', [])}
        pages = {p['title']: p for p in q.get('pages', [])}
        for t in batch:
            final = redir.get(norm.get(t, t), norm.get(t, t))
            p = pages.get(final)
            if p and not p.get('missing') and 'disambiguation' not in (p.get('pageprops') or {}):
                page[t] = {'final': final, 'image': p.get('pageimage'), 'qid': (p.get('pageprops') or {}).get('wikibase_item')}
    people_q = humans({p['qid'] for p in page.values() if p['qid']})
    rejected = {t: 'not a person article' for t, p in page.items() if p['qid'] not in people_q}
    page = {t: p for t, p in page.items() if p['qid'] in people_q}

    files = sorted({p['image'] for p in page.values() if p['image']})
    meta = {}
    for batch in chunks(files):
        q = query(prop='imageinfo', iiprop='url|extmetadata|mime', iiurlwidth=500,
                  iiextmetadatafilter='Artist|Credit|LicenseShortName|LicenseUrl',
                  titles='|'.join('File:' + f for f in batch))
        norm = {x['from']: x['to'] for x in q.get('normalized', [])}
        pages = {p['title']: p for p in q.get('pages', [])}
        for f in batch:
            p = pages.get(norm.get('File:' + f, 'File:' + f))
            if not p or not p.get('imageinfo'):
                continue
            ii, em = p['imageinfo'][0], p['imageinfo'][0].get('extmetadata') or {}
            val = lambda k: (em.get(k) or {}).get('value') or ''  # noqa: E731
            meta[f] = {'thumb': ii.get('thumburl') or ii.get('url'), 'page': ii.get('descriptionurl'), 'mime': ii.get('mime'),
                       'by': plain(val('Artist')) or plain(val('Credit')), 'lic': license_name(val('LicenseShortName')),
                       'licRaw': val('LicenseShortName'), 'licUrl': val('LicenseUrl') or None}

    os.makedirs(RAW, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    jobs = {}     # final title -> (raw path, out file)
    for t, p in page.items():
        m = meta.get(p['image']) if p['image'] else None
        if not m:
            rejected[t] = 'no free lead image'
            continue
        if not m['lic']:
            rejected[t] = f"license {m['licRaw'] or 'unknown'}"
            continue
        if not (m['mime'] or '').startswith('image/') or not m['thumb']:
            rejected[t] = f"not a photo ({m['mime']})"
            continue
        if p['final'] in jobs:
            continue
        ext = os.path.splitext(urllib.parse.urlparse(m['thumb']).path)[1].lower() or '.jpg'
        raw = os.path.join(RAW, hashlib.sha1(m['thumb'].encode()).hexdigest()[:16] + ext)
        if not os.path.exists(raw):
            try:
                data = get(m['thumb'], binary=True)
            except Exception as e:  # one failed download must not stop the rest
                rejected[t] = f'download failed: {e}'
                continue
            with open(raw, 'wb') as fh:
                fh.write(data)
            time.sleep(0.1)
        jobs[p['final']] = (raw, slug(p['final']) + '.jpg')
    print(f'{len(meta)} lead images, {len(jobs)} downloaded with a usable license')

    tsv = ''.join(f'{raw}\t{os.path.join(OUT_DIR, out)}\n' for raw, out in jobs.values())
    run = subprocess.run(['swift', FACECROP, str(SIZE)], input=tsv, capture_output=True, text=True, timeout=1800)
    if run.returncode:
        sys.exit(f'facecrop failed: {run.stderr[-2000:]}')
    crops = {}
    for line in run.stdout.splitlines():
        if line.startswith('{'):
            d = json.loads(line)
            crops[d['in']] = d

    people = {}
    for final, (raw, out) in jobs.items():
        d = crops.get(raw) or {'ok': False, 'reason': 'not processed'}
        if not d['ok']:
            rejected[final] = d['reason']
            continue
        m = meta[next(p['image'] for p in page.values() if p['final'] == final)]
        people[final] = {'f': out, 'by': m['by'] or 'Unknown author', 'lic': m['lic'], 'licUrl': m['licUrl'], 'page': m['page']}
    races_out = {}
    for rid, names in wanted.items():
        for name, t in names.items():
            final = page.get(t, {}).get('final')
            if final in people:
                races_out.setdefault(rid, {})[name] = final

    keep = {p['f'] for p in people.values()}
    for f in os.listdir(OUT_DIR):
        if f.endswith('.jpg') and f not in keep and not limit:
            os.remove(os.path.join(OUT_DIR, f))
    out = {'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'size': SIZE,
           'source': 'Lead images of the candidates’ English Wikipedia articles, from Wikimedia Commons or Wikipedia',
           'people': dict(sorted(people.items())), 'races': dict(sorted(races_out.items()))}
    if not limit:
        with open(OUT, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    kb = sum(os.path.getsize(os.path.join(OUT_DIR, p['f'])) for p in people.values()) / 1024
    print(f'{len(people)} photos ({kb:.0f}KB) for {sum(len(v) for v in races_out.values())} candidacies in {len(races_out)} races')
    reasons = {}
    for t, why in rejected.items():
        reasons.setdefault(re.sub(r'\s*\(.*', '', why.split(':')[0]), []).append(t)
    for why, ts in sorted(reasons.items(), key=lambda x: -len(x[1])):
        print(f'  skipped {len(ts):3d}  {why}: {", ".join(ts[:8])}{" …" if len(ts) > 8 else ""}')


if __name__ == '__main__':
    main()
