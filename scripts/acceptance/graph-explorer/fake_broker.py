# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Local stand-in for the DB broker's /provision endpoint, for disposable tests only.

Answers ``POST {"tenant_id": ...}`` (an organization database) or
``POST {"scope": ..., "org_id": ..., "owner_id": ...}`` (a team or personal one)
with the same DSN for a local test database when the
request carries the expected bearer token, and 401 otherwise. Start the engine
with ``ROCKETRIDE_DB_BROKER_URL=http://127.0.0.1:<port>/provision`` and
``ROCKETRIDE_DB_BROKER_TOKEN=<token>`` so rocketride_graph / rocketride_sql resolve
their database here. Logs only the requested database's ids and status codes, never the
token or the DSN.

Usage: python fake_broker.py <port> <expected_token> <dsn>
       (the token is any local-only placeholder you choose; the DSN points at a
       disposable container, e.g. the AGE container or a PgBouncer in front of it)
"""

import json
import sys

from http.server import BaseHTTPRequestHandler, HTTPServer

if len(sys.argv) != 4:
    sys.exit(__doc__)

PORT = int(sys.argv[1])
TOKEN = sys.argv[2]
DSN = sys.argv[3]


def _requested(body):
    """Which database a request names, for the log line."""
    if 'tenant_id' in body:
        return f'tenant={body.get("tenant_id")!r}'
    return f'scope={body.get("scope")!r} org={body.get("org_id")!r} owner={body.get("owner_id")!r}'


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 - http.server API
        length = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(length) or b'{}')
        if self.headers.get('Authorization') != f'Bearer {TOKEN}':
            self.send_response(401)
            self.end_headers()
            print(f'provision {_requested(body)} -> 401', flush=True)
            return
        payload = json.dumps({'dsn': DSN}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        print(f'provision {_requested(body)} -> 200', flush=True)

    def log_message(self, *args):  # silence the default access log
        pass


HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
