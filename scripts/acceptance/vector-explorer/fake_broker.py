# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Local stand-in for the DB broker's /provision endpoint, for disposable tests only.

Answers ``POST {"tenant_id": ...}`` with a DSN for a local test database when the
request carries the expected bearer token, and 401 otherwise. Start the engine
with ``ROCKETRIDE_DB_BROKER_URL=http://127.0.0.1:<port>/provision`` and
``ROCKETRIDE_DB_BROKER_TOKEN=<token>`` so ``rocketride_vector`` resolves its tenant
database here. Logs only tenant ids and status codes, never the token or the DSN.

The defaults are the Vector Explorer lanes' (port 18788, the throwaway token
``local-broker-placeholder``, the gx-pgvector container directly). For the
pooled pass, point ``--dsn`` at the vx-pgbouncer container instead
(``--pooler`` is a shortcut): ``postgresql://rruser:rrpass@127.0.0.1:56434/rrtenant?sslmode=disable``. Every default is a
LOCAL-ONLY test value for a disposable container, not a secret.

Usage: python fake_broker.py [--port 18788] [--token TOKEN] [--dsn DSN | --pooler]
"""

import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

DEFAULT_PORT = 18788
DEFAULT_TOKEN = 'local-broker-placeholder'
# sslmode=disable: the local test containers serve no TLS.
DIRECT_DSN = 'postgresql://rruser:rrpass@127.0.0.1:55432/rrtenant?sslmode=disable'
POOLER_DSN = 'postgresql://rruser:rrpass@127.0.0.1:56434/rrtenant?sslmode=disable'


def make_handler(token: str, dsn: str):
    """Build a request handler bound to one token and one DSN."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 - http.server API
            length = int(self.headers.get('Content-Length') or 0)
            try:
                body = json.loads(self.rfile.read(length) or b'{}')
            except ValueError:
                body = {}
            tenant = body.get('tenant_id') if isinstance(body, dict) else None
            if self.headers.get('Authorization') != f'Bearer {token}':
                self.send_response(401)
                self.end_headers()
                print(f'provision tenant={tenant!r} -> 401', flush=True)
                return
            payload = json.dumps({'dsn': dsn}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            print(f'provision tenant={tenant!r} -> 200', flush=True)

        def log_message(self, *args):  # silence the default access log
            pass

    return Handler


def main():
    """Parse the options and serve until interrupted."""
    parser = argparse.ArgumentParser(description='Local stand-in for the DB broker (disposable tests only).')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--token', default=DEFAULT_TOKEN)
    parser.add_argument('--dsn', default=None, help='default: the direct gx-pgvector DSN')
    parser.add_argument('--pooler', action='store_true', help='answer with the vx-pgbouncer DSN')
    args = parser.parse_args()
    args.dsn = args.dsn or (POOLER_DSN if args.pooler else DIRECT_DSN)
    server = HTTPServer(('127.0.0.1', args.port), make_handler(args.token, args.dsn))
    print(f'fake broker on http://127.0.0.1:{args.port}/provision', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
