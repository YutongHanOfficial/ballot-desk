#!/usr/bin/env python3
"""Local preview server with caching disabled, so edits show up on reload. Usage: python3 pipeline/serve.py [port]"""
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCache(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def translate_path(self, path):
        # Like GitHub Pages: /race/GA-SEN is served from race/GA-SEN.html.
        local = super().translate_path(path)
        if not os.path.exists(local) and os.path.isfile(local + '.html'):
            return local + '.html'
        return local

    def send_error(self, code, message=None, explain=None):
        # Like GitHub Pages: paths that are not files get the site's own 404 page.
        page = os.path.join(ROOT, '404.html')
        if code != 404 or not os.path.exists(page):
            return super().send_error(code, message, explain)
        with open(page, 'rb') as f:
            body = f.read()
        self.send_response(404)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8026
    print(f'Serving {ROOT} at http://127.0.0.1:{port}')
    http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCache).serve_forever()
