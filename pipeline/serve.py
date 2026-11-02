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

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8026
    print(f'Serving {ROOT} at http://127.0.0.1:{port}')
    http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCache).serve_forever()
