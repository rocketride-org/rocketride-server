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

"""Network-policy tests for the scraper_beautifulsoup fetcher.

A local HTTP server stands in for the web. The public-host resolver is
injected, so tests allow 127.0.0.1 explicitly and prove that every redirect
hop goes back through the resolver and the allow-list. Requests go through the
real shared ``pinned_http`` session, loaded standalone from packages/ai.
"""

from __future__ import annotations

import importlib.util
import json
import re
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

pytest.importorskip('requests')
pytest.importorskip('bs4')

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'scraper_beautifulsoup'))

from scrape_fetch import Fetcher, FetchError, compile_patterns  # noqa: E402

_PINNED_PATH = (
    Path(__file__).resolve().parents[3] / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils' / 'pinned_http.py'
)
_spec = importlib.util.spec_from_file_location('scraper_test_pinned_http', _PINNED_PATH)
pinned_http = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pinned_http)


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence test output
        pass

    def _send(self, status, body=b'', headers=None):
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/redirect-to?'):
            self._send(302, headers={'Location': parse_qs(urlparse(self.path).query)['to'][0]})
        elif self.path == '/headers':
            self._send(200, json.dumps(dict(self.headers.items())).encode(), {'Content-Type': 'application/json'})
        elif self.path == '/ok':
            self._send(200, b'hello', {'Content-Type': 'text/plain; charset=utf-8'})
        elif self.path == '/json':
            self._send(
                200, json.dumps({'ua': self.headers.get('User-Agent')}).encode(), {'Content-Type': 'application/json'}
            )
        elif self.path == '/redirect-local':
            self._send(302, headers={'Location': '/ok'})
        elif self.path == '/redirect-evil':
            self._send(302, headers={'Location': 'http://evil.internal/secret'})
        elif self.path == '/loop':
            self._send(302, headers={'Location': '/loop'})
        elif self.path == '/big':
            self._send(200, b'x' * 5000)
        elif self.path == '/huge-declared':
            self.send_response(200)
            self.send_header('Content-Length', '999999999')
            self.end_headers()
        elif self.path == '/404':
            self._send(404, b'nope')
        else:
            self._send(500)

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        payload = json.loads(self.rfile.read(length) or b'null')
        if self.path == '/post-303':
            self._send(303, headers={'Location': '/json'})
        else:
            self._send(200, json.dumps({'got': payload}).encode(), {'Content-Type': 'application/json'})


def _serve():
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, f'http://127.0.0.1:{httpd.server_address[1]}'


@pytest.fixture(scope='module')
def server():
    httpd, url = _serve()
    yield url
    httpd.shutdown()


@pytest.fixture(scope='module')
def other_server():
    """A second origin (same host, different port)."""
    httpd, url = _serve()
    yield url
    httpd.shutdown()


class Validator:
    """Allows only 127.0.0.1, records every URL it was asked about."""

    def __init__(self):
        self.seen = []

    def __call__(self, url):
        self.seen.append(url)
        if '127.0.0.1' not in url:
            raise ValueError(f'Blocked non-public URL host: {url}')
        return pinned_http.resolve_addresses(url, is_allowed=lambda address: address.is_loopback)


def make(validator=None, **kw):
    return Fetcher(resolve_url=validator or Validator(), open_session=pinned_http.pinned_session, timeout=5, **kw)


def test_basic_get(server):
    result = make().fetch(f'{server}/ok')
    assert result.status == 200
    assert result.text() == 'hello'
    assert result.content_type == 'text/plain'


def test_user_agent_sent(server):
    data = make(user_agent='pulsar-test/1').fetch(f'{server}/json').json()
    assert data['ua'] == 'pulsar-test/1'


def test_connects_only_to_pinned_address(server):
    """The hostname never reaches DNS again: the socket goes to the validated address."""
    port = int(server.rsplit(':', 1)[1])
    pinned = ((socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ('127.0.0.1', port)),)
    fetcher = Fetcher(resolve_url=lambda url: pinned, open_session=pinned_http.pinned_session, timeout=5)
    result = fetcher.fetch(f'http://rebind.invalid:{port}/headers')
    assert result.json()['Host'] == f'rebind.invalid:{port}'


def test_redirect_revalidated(server):
    v = Validator()
    result = make(v).fetch(f'{server}/redirect-local')
    assert result.text() == 'hello'
    assert result.url.endswith('/ok')
    assert len(v.seen) == 2  # original + redirect hop


def test_redirect_to_blocked_host_fails(server):
    with pytest.raises(FetchError, match='Blocked'):
        make().fetch(f'{server}/redirect-evil')


def test_same_origin_redirect_keeps_headers(server):
    headers = {'Authorization': 'Bearer secret', 'X-Api-Key': 'k'}
    got = make().fetch(f'{server}/redirect-to?to=/headers', headers=headers).json()
    assert got['Authorization'] == 'Bearer secret'
    assert got['X-Api-Key'] == 'k'


def test_cross_origin_redirect_drops_credentials(server, other_server):
    headers = {'Authorization': 'Bearer secret', 'X-Api-Key': 'k', 'Accept': 'application/json'}
    got = make(user_agent='ua/1').fetch(f'{server}/redirect-to?to={other_server}/headers', headers=headers).json()
    assert 'Authorization' not in got
    assert 'X-Api-Key' not in got
    assert got['Accept'] == 'application/json'
    assert got['User-Agent'] == 'ua/1'


def test_redirect_loop_capped(server):
    with pytest.raises(FetchError, match='Too many redirects'):
        make(max_redirects=3).fetch(f'{server}/loop')


def test_blocked_initial_url():
    with pytest.raises(FetchError, match='Blocked'):
        make().fetch('http://169.254.169.254/latest/meta-data')


def test_scheme_rejected():
    with pytest.raises(FetchError, match='http'):
        make().fetch('file:///etc/passwd')


def test_allow_list(server):
    fetcher = make(allow_patterns=compile_patterns([r'/ok$']))
    assert fetcher.fetch(f'{server}/ok').status == 200
    with pytest.raises(FetchError, match='allow-list'):
        fetcher.fetch(f'{server}/json')


def test_allow_list_applies_to_redirect_target(server):
    fetcher = make(allow_patterns=compile_patterns([r'/redirect-local$']))
    with pytest.raises(FetchError, match='allow-list'):
        fetcher.fetch(f'{server}/redirect-local')


def test_size_cap_truncates(server):
    result = make(max_bytes=1000).fetch(f'{server}/big')
    assert len(result.content) == 1000
    assert result.truncated


def test_short_body_is_fetch_error(server):
    # Server declares a huge body then closes: surfaces as FetchError, not a raw requests error.
    with pytest.raises(FetchError):
        make(max_bytes=1000).fetch(f'{server}/huge-declared')


def test_error_status(server):
    with pytest.raises(FetchError, match='HTTP 404'):
        make().fetch(f'{server}/404')
    assert make().fetch(f'{server}/404', raise_for_status=False).status == 404


def test_post_json_and_303(server):
    data = make().fetch(f'{server}/echo', method='POST', json_body={'q': 1}).json()
    assert data == {'got': {'q': 1}}
    # 303 converts POST to GET on the redirect target.
    assert 'ua' in make().fetch(f'{server}/post-303', method='POST', json_body={}).json()


def test_unsupported_method(server):
    with pytest.raises(FetchError, match='Unsupported'):
        make().fetch(f'{server}/ok', method='DELETE')


def test_pacing(server):
    fetcher = make(min_interval=0.2)
    start = time.monotonic()
    for _ in range(3):
        fetcher.fetch(f'{server}/ok')
    assert time.monotonic() - start >= 0.38


def test_compile_patterns_forms():
    assert compile_patterns(None) == []
    assert compile_patterns('') == []
    assert [p.pattern for p in compile_patterns('^a\n\n^b')] == ['^a', '^b']
    assert [p.pattern for p in compile_patterns([{'allowPattern': '^c'}, {'allowPattern': ''}])] == ['^c']
    with pytest.raises(ValueError, match='Invalid'):
        compile_patterns(['('])
    assert isinstance(compile_patterns(['x'])[0], re.Pattern)
