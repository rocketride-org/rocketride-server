# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Stub-broker integration test: BrokerUserAuth.token() over a real in-process
HTTP server (no _urlopen mocking) verifying the refresh contract end to end.
"""

from __future__ import annotations

import contextlib
import http.server
import json
import sys
import threading
import time
from pathlib import Path

import pytest

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

# Self-sufficient bootstrap: importing the nodes package pulls engine runtime
# modules (depends/rocketlib); stub them if absent so this file never depends
# on a sibling test having run first, then drop what we added.
from unittest.mock import MagicMock

_added = []
for _name in ('depends', 'rocketlib', 'ai', 'ai.common', 'ai.common.utils', 'ai.common.config'):
    if _name not in sys.modules:
        _stub = MagicMock()
        if _name == 'depends':
            _stub.depends = lambda *a, **k: None
        if _name == 'rocketlib':
            _stub.IInstanceBase = object
            _stub.IGlobalBase = object
            _stub.tool_function = lambda **kw: lambda f: f
        sys.modules[_name] = _stub
        _added.append(_name)

_fresh_nodes = 'nodes' not in sys.modules
from nodes.tool_microsoft_365 import graph_client as gc

for _name in _added:
    sys.modules.pop(_name, None)
if _fresh_nodes:
    for _name in [k for k in list(sys.modules) if k == 'nodes' or k.startswith('nodes.')]:
        sys.modules.pop(_name, None)
# Keep a direct reference; tests only touch graph_client's pure functions.

SVC = gc.GraphService(product='Excel')


def _make_handler(mode: str, received: dict) -> type[http.server.BaseHTTPRequestHandler]:
    """Build a ``/refresh`` handler for one stub run.

    Records the raw body/content-type into ``received`` rather than asserting
    inside the handler thread (assertion failures there would not fail the
    test — they would just print to a background thread's stderr).
    """

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 - stdlib method name
            length = int(self.headers.get('Content-Length', 0))
            received['body'] = self.rfile.read(length)
            received['content_type'] = self.headers.get('Content-Type')

            if mode == 'success':
                status, payload = 200, {'access_token': 'fresh', 'expiry_date': int((time.time() + 3600) * 1000)}
            elif mode == '401':
                status, payload = 401, {'error': 'invalid_grant'}
            elif mode == 'no_token':
                status, payload = 200, {'ok': True}
            else:
                raise ValueError(f'unknown stub mode {mode!r}')

            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):  # noqa: A002 - stdlib signature
            pass  # keep the stub quiet; test output shouldn't include request logs

    return Handler


@contextlib.contextmanager
def _stub_broker(mode: str):
    """Run a real HTTPServer on 127.0.0.1:0 for the duration of the `with` block."""
    received: dict = {}
    server = http.server.HTTPServer(('127.0.0.1', 0), _make_handler(mode, received))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        yield f'http://127.0.0.1:{port}/refresh', received
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _auth(broker_url: str) -> gc.BrokerUserAuth:
    # resolve_refresh_url (exercised directly in test_graph_client.py) rejects
    # any non-https URL unconditionally, including one whose host is trusted
    # via RR_OAUTH_BROKER_URL — the env var only extends the trusted *host*
    # allowlist, it does not relax the https requirement on the payload URL.
    # So a plain-http stub can never pass through build_auth/resolve_refresh_url,
    # and it shouldn't: that guard is what test_graph_client.py's
    # TestHostValidation already covers. This test's job is the real-HTTP
    # refresh *contract* of BrokerUserAuth.token() itself (request shape,
    # response parsing, error handling), so BrokerUserAuth is constructed
    # directly, bypassing the URL-trust layer on purpose.
    return gc.BrokerUserAuth(
        SVC,
        access_token='STALE',
        refresh_token='R',
        broker_url=broker_url,
        expiry_ms=int((time.time() - 10) * 1000),  # already expired -> forces a refresh
    )


class TestStubBroker:
    def test_happy_path_refreshes_over_real_http(self):
        with _stub_broker('success') as (broker_url, received):
            auth = _auth(broker_url)
            assert auth.token() == 'fresh'
            assert json.loads(received['body']) == {'refresh_token': 'R'}
            assert received['content_type'] == 'application/json'

    def test_broker_401_is_reported_as_rejection(self):
        with _stub_broker('401') as (broker_url, _received):
            auth = _auth(broker_url)
            with pytest.raises(ValueError, match='rejected by the broker'):
                auth.token()

    def test_broker_200_without_access_token_is_contract_violation(self):
        with _stub_broker('no_token') as (broker_url, _received):
            auth = _auth(broker_url)
            with pytest.raises(ValueError, match='no access token'):
                auth.token()
