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

"""A fake HTTPS database broker (the data-core provisioner) for the acceptance tests.

TEST ONLY. It stands in for the provisioner so a real engine can be driven
without cloud resources:

* real TLS, certificate from the throwaway CA of ``pki`` (names ``localhost``);
* answers ``POST /provision`` with the DSN of a synthetic tenant database on the
  TLS PostgreSQL of ``pg_tls``, exactly as the provisioner does (``sslmode=require``);
* a rendezvous barrier: with ``arm_barrier(n)`` the broker answers only once ``n``
  provision calls are in flight at the same time, so overlapping tenants are
  forced by synchronisation, never assumed from timing;
* scripted failures per tenant (``set_mode``): 500, 409, malformed answers, no
  DSN, or a DSN that belongs to another tenant (the deliberate swap that proves
  the isolation checks can see a mix-up);
* a request log that records WHICH tenant asked and whether the bearer token was
  right, never the token or a DSN.
"""

from __future__ import annotations

import json
import ssl
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Optional


@dataclass
class BrokerCall:
    """One provision request, as the broker saw it (no secrets)."""

    tenant: str  # 'org-aaa' for the org body; 'team:org-aaa:team-aaa' for a scoped body
    body_keys: tuple
    authorized: bool
    request_id: str
    at: float = field(default_factory=time.monotonic)


class FakeBroker:
    """See the module docstring."""

    def __init__(
        self,
        *,
        cert: Path,
        key: Path,
        token: str,
        dsn_for_tenant: Callable[[str], Optional[str]],
    ):
        self.token = token
        self._dsn_for_tenant = dsn_for_tenant
        self.calls: list[BrokerCall] = []
        self._modes: dict[str, str] = {}
        self._barrier: Optional[threading.Barrier] = None
        self.barrier_released: dict[str, bool] = {}
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(length) if length else b'{}'
                status, payload = outer._answer(
                    self.path, raw, self.headers.get('Authorization', ''), self.headers.get('X-Request-Id', '')
                )
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self._server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(cert), str(key))
        self._server.socket = context.wrap_socket(self._server.socket, server_side=True)
        self.port = self._server.server_address[1]
        self.url = f'https://localhost:{self.port}/provision'
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True)
        self._thread.start()

    # -- control ----------------------------------------------------------

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def reset(self) -> None:
        """Forget calls, modes and any barrier between tests."""
        with self._lock:
            self.calls.clear()
            self._modes.clear()
            self._barrier = None
            self.barrier_released = {}

    def set_mode(self, tenant: str, mode: str) -> None:
        """``ok`` | ``error500`` | ``conflict409`` | ``malformed`` | ``no-dsn`` | ``dsn-of:<tenant>`` | ``raw-dsn:<dsn>``."""
        with self._lock:
            self._modes[tenant] = mode

    def arm_barrier(self, parties: int, timeout: float = 30.0) -> None:
        """Hold every provision answer until ``parties`` calls are in flight at once."""
        with self._lock:
            self._barrier = threading.Barrier(parties, timeout=timeout)
            self.barrier_released = {}

    def calls_for(self, tenant: str) -> list[BrokerCall]:
        return [c for c in self.calls if c.tenant == tenant]

    # -- the provisioner's answer ------------------------------------------

    def _answer(self, path: str, raw: bytes, authorization: str, request_id: str):
        try:
            body = json.loads(raw or b'{}')
        except ValueError:
            body = {}
        if body.get('scope') in ('team', 'user'):
            tenant = f'{body["scope"]}:{body.get("org_id", "")}:{body.get("owner_id", "")}'
        else:
            tenant = body.get('tenant_id', '')
        authorized = authorization == f'Bearer {self.token}'
        with self._lock:
            self.calls.append(BrokerCall(tenant, tuple(sorted(body)), authorized, request_id))
            barrier = self._barrier
            mode = self._modes.get(tenant, 'ok')
        if barrier is not None:
            try:
                barrier.wait()
                released = True
            except threading.BrokenBarrierError:
                released = False
            with self._lock:
                self.barrier_released[tenant] = released
        if not authorized:
            return 401, {'error': 'unauthorized'}
        if mode == 'error500':
            return 500, {'error': 'boom'}
        if mode == 'conflict409':
            return 409, {'error': 'tenant is retained'}
        if mode == 'malformed':
            return 200, b'<html>not json</html>'
        if mode == 'no-dsn':
            return 200, {'database': 'x'}
        if mode.startswith('raw-dsn:'):
            return 200, {'database': 'synthetic', 'role': 'synthetic', 'dsn': mode.split(':', 1)[1], 'created': False}
        source = tenant
        if mode.startswith('dsn-of:'):
            source = mode.split(':', 1)[1]
        dsn = self._dsn_for_tenant(source)
        if not dsn:
            return 404, {'error': 'unknown tenant'}
        return 200, {'database': 'synthetic', 'role': 'synthetic', 'dsn': dsn, 'created': False}
