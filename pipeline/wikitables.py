"""Minimal HTML table extraction for Wikipedia article HTML (stdlib only).

Every <table> becomes a list of rows; each row is a list of cells with rowspans and colspans
expanded, so column N always means the same thing. Footnote markers and hidden sort keys are dropped.
"""
import re
from html.parser import HTMLParser

VOID = {'br', 'img', 'hr', 'meta', 'link', 'input', 'wbr', 'source', 'area', 'col', 'embed', 'param', 'track'}


class _TableParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []
        self.stack = []
        self.heading = None
        self._in_heading = False
        self._heading_text = ''
        self._skip_depth = 0

    def _should_skip(self, tag, cls, style):
        if tag in ('style', 'script'):
            return True
        if tag == 'sup' and 'reference' in cls:
            return True
        if tag == 'span' and ('sortkey' in cls or 'mw-editsection' in cls):
            return True
        return 'display:none' in style.replace(' ', '')

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get('class') or ''
        if self._skip_depth:
            if tag not in VOID:
                self._skip_depth += 1
            return
        if self._should_skip(tag, cls, a.get('style') or ''):
            if tag not in VOID:
                self._skip_depth = 1
            return
        if tag in ('h2', 'h3', 'h4'):
            self._in_heading = True
            self._heading_text = ''
        if tag == 'table':
            self.stack.append({'rows': [], 'row': None, 'cell': None, 'heading': self.heading, 'class': cls})
            return
        if not self.stack:
            return
        t = self.stack[-1]
        if tag == 'tr':
            t['row'] = []
        elif tag in ('td', 'th') and t['row'] is not None:
            def span(v):
                v = re.sub(r'\D', '', v or '1')
                return max(1, int(v)) if v else 1
            t['cell'] = {'tag': tag, 'text': '', 'links': [], 'rs': span(a.get('rowspan')),
                         'cs': span(a.get('colspan')), 'style': a.get('style', ''), 'class': cls}
        elif t['cell'] is not None:
            if tag == 'a':
                t['cell']['links'].append(a.get('href', ''))
            elif tag in ('br', 'li', 'p', 'div'):
                t['cell']['text'] += '\n'

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if self._skip_depth:
            self._skip_depth -= 1
            return
        if tag in ('h2', 'h3', 'h4') and self._in_heading:
            self._in_heading = False
            self.heading = self._heading_text.strip()
        if not self.stack:
            return
        t = self.stack[-1]
        if tag in ('td', 'th') and t['cell'] is not None:
            if t['row'] is not None:
                t['row'].append(t['cell'])
            t['cell'] = None
        elif tag == 'tr' and t['row'] is not None:
            if t['cell'] is not None:
                t['row'].append(t['cell'])
                t['cell'] = None
            t['rows'].append(t['row'])
            t['row'] = None
        elif tag == 'table':
            self.tables.append(self.stack.pop())

    def handle_data(self, data):
        if self._skip_depth:
            return
        if self._in_heading:
            self._heading_text += data
        if self.stack and self.stack[-1]['cell'] is not None:
            self.stack[-1]['cell']['text'] += data


def _grid(table):
    out, pending = [], {}
    for row in table['rows']:
        r, ci, cells = [], 0, list(row)
        while cells or any(k >= ci for k in pending):
            if ci in pending:
                rem, cell = pending[ci]
                r.append(cell)
                if rem > 1:
                    pending[ci] = (rem - 1, cell)
                else:
                    del pending[ci]
                ci += 1
                continue
            if not cells:
                if any(k > ci for k in pending):
                    r.append(None)
                    ci += 1
                    continue
                break
            cell = cells.pop(0)
            for _ in range(cell['cs']):
                r.append(cell)
                if cell['rs'] > 1:
                    pending[ci] = (cell['rs'] - 1, cell)
                ci += 1
        out.append(r)
    return out


def clean(s):
    s = (s or '').replace('\xa0', ' ')
    s = re.sub(r'[ \t]+', ' ', s)
    s = re.sub(r' *\n *', '\n', s)
    s = re.sub(r'\n+', '\n', s)
    return s.strip()


def tables(html):
    """Return [{'heading', 'class', 'rows': [[text, ...]], 'cells': [[cell, ...]]}] for every table."""
    p = _TableParser()
    p.feed(html)
    out = []
    for t in p.tables:
        g = _grid(t)
        out.append({'heading': t['heading'], 'class': t['class'], 'cells': g,
                    'rows': [[clean(c['text']) if c else '' for c in r] for r in g]})
    return out
