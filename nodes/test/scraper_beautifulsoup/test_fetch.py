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


sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'scraper_beautifulsoup'))

from scrape_fetch import SAFE_REDIRECT_HEADERS, Fetcher, FetchError, _redirect_step, compile_patterns  # noqa: E402

_PINNED_PATH = (
    Path(__file__).resolve().parents[3] / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils' / 'pinned_http.py'
)
_spec = importlib.util.spec_from_file_location('scraper_test_pinned_http', _PINNED_PATH)
pinned_http = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pinned_http)

_spec = importlib.util.spec_from_file_location('scraper_test_url_policy', _PINNED_PATH.with_name('url_policy.py'))
url_policy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(url_policy)


# Every POST any test server received: (server port, path, decoded JSON body).
RECEIVED_POSTS = []


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
        elif urlparse(self.path).path == '/json':
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
        elif self.path.startswith('/404'):
            self._send(404, b'nope')
        elif self.path == '/redirect-big':
            # A redirect whose body is far larger than any cap the tests set.
            body = b'x' * (2 * 1024 * 1024)
            self.send_response(302)
            self.send_header('Location', '/ok')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except OSError:
                pass
        elif self.path == '/slow-headers':
            # Status line, then one header byte every 100 ms (10 s): each byte
            # restarts a per-read socket timeout.
            try:
                self.wfile.write(b'HTTP/1.1 200 OK\r\nX-Pad: ')
                self.wfile.flush()
                for _ in range(100):
                    self.wfile.write(b'a')
                    self.wfile.flush()
                    time.sleep(0.1)
                self.wfile.write(b'\r\nContent-Length: 0\r\n\r\n')
            except OSError:
                pass  # the client gave up
            self.close_connection = True
        elif self.path.startswith('/trickle'):
            # Declares 100 bytes, then sends one every 100 ms (10 s in total).
            self.send_response(200)
            if self.path == '/trickle':
                self.send_header('Content-Length', '100')
            else:
                self.send_header('Connection', 'close')
            self.end_headers()
            try:
                for _ in range(100):
                    self.wfile.write(b'x')
                    self.wfile.flush()
                    time.sleep(0.1)
            except OSError:
                pass  # the client gave up
        else:
            self._send(500)

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        payload = json.loads(self.rfile.read(length) or b'null')
        RECEIVED_POSTS.append((self.server.server_address[1], urlparse(self.path).path, payload))
        if self.path == '/post-303':
            self._send(303, headers={'Location': '/json'})
        elif self.path.startswith('/post-30'):
            # /post-307?to=<url> and /post-308?to=<url>: redirect that resends the body.
            status = int(urlparse(self.path).path.rsplit('-', 1)[1])
            self._send(status, headers={'Location': parse_qs(urlparse(self.path).query)['to'][0]})
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
    kw.setdefault('allow_match', url_policy.url_matches_pattern)
    kw.setdefault('canonicalize', url_policy.canonicalize_url)
    kw.setdefault('timeout', 5)
    return Fetcher(resolve_url=validator or Validator(), open_session=pinned_http.pinned_session, **kw)


def pinned(server, path):
    """An allow-list pattern for exactly ``path`` on the test server."""
    return re.escape(server) + re.escape(path) + '$'


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
    fetcher = make(allow_patterns=compile_patterns(['^' + pinned(server, '/ok')]))
    assert fetcher.fetch(f'{server}/ok').status == 200
    with pytest.raises(FetchError, match='allow-list'):
        fetcher.fetch(f'{server}/json')


def test_allow_list_applies_to_redirect_target(server):
    fetcher = make(allow_patterns=compile_patterns([pinned(server, '/redirect-local')]))
    with pytest.raises(FetchError, match='allow-list'):
        fetcher.fetch(f'{server}/redirect-local')


def test_allow_list_unanchored_pattern_never_matches(server):
    # Searched anywhere, '/ok' would match; the strict matcher needs scheme + host.
    fetcher = make(allow_patterns=compile_patterns([r'/ok$']))
    with pytest.raises(FetchError, match='allow-list'):
        fetcher.fetch(f'{server}/ok')


def test_allow_list_without_matcher_fails_closed(server):
    fetcher = make(allow_patterns=compile_patterns(['^' + pinned(server, '/ok')]), allow_match=None)
    with pytest.raises(FetchError, match='matcher'):
        fetcher.fetch(f'{server}/ok')


@pytest.mark.parametrize(
    'pattern,url',
    [
        (r'news\.ycombinator\.com', 'https://evil.example/?u=news.ycombinator.com'),
        (r'^https://news\.ycombinator\.com', 'https://news.ycombinator.com.evil.example/'),
        (r'^https://news\.ycombinator\.com/|^https://', 'https://evil.example/'),
    ],
)
def test_allow_list_bypass_patterns_do_not_match(pattern, url):
    assert not url_policy.url_matches_pattern(re.compile(pattern), url)


def test_allow_list_pinned_pattern_matches():
    pattern = re.compile(r'^https://news\.ycombinator\.com/')
    url_policy.check_allow_pattern(pattern)
    assert url_policy.url_matches_pattern(pattern, 'https://news.ycombinator.com/item?id=1')


@pytest.mark.parametrize('pattern', [r'news\.ycombinator\.com', r'^https://news\.ycombinator\.com', r'/ok$'])
def test_check_allow_pattern_rejects_unpinned(pattern):
    with pytest.raises(ValueError, match='literal http'):
        url_policy.check_allow_pattern(re.compile(pattern))


@pytest.mark.parametrize('name', ['Host', 'host', 'HOST'])
def test_host_header_override_refused(server, name):
    with pytest.raises(FetchError, match='Host header'):
        make().fetch(f'{server}/headers', headers={name: 'admin.example.com'})


def test_error_messages_omit_query_string(server):
    with pytest.raises(FetchError) as exc:
        make().fetch(f'{server}/404?apiKey=SECRET-KEY')
    assert 'SECRET-KEY' not in str(exc.value)
    assert f'{server}/404' in str(exc.value)


def test_transport_error_reports_type_not_url(server):
    port = int(server.rsplit(':', 1)[1])
    dead = ((socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ('127.0.0.1', 1)),)
    fetcher = Fetcher(resolve_url=lambda url: dead, open_session=pinned_http.pinned_session, timeout=5)
    with pytest.raises(FetchError) as exc:
        fetcher.fetch(f'http://127.0.0.1:{port}/ok?token=SECRET-KEY')
    assert 'SECRET-KEY' not in str(exc.value)
    assert 'ConnectionError' in str(exc.value)


@pytest.mark.parametrize('path', ['/trickle', '/trickle-close'])
def test_timeout_bounds_whole_body_read(server, path):
    # Each byte arrives well inside the per-read timeout; only a whole-fetch
    # deadline stops it.
    fetcher = make(timeout=1)
    start = time.monotonic()
    with pytest.raises(FetchError, match='timed out'):
        fetcher.fetch(f'{server}{path}')
    assert time.monotonic() - start < 3


def test_timeout_bounds_slow_response_headers(server):
    start = time.monotonic()
    with pytest.raises(FetchError, match='timed out'):
        make(timeout=1).fetch(f'{server}/slow-headers')
    assert time.monotonic() - start < 3


@pytest.mark.parametrize('suffix', ['/ok/../headers', '/ok/%2e%2e/headers', '/ok/%252e%252e/headers'])
def test_dot_segments_cannot_walk_out_of_a_path_scoped_pattern(server, suffix):
    fetcher = make(allow_patterns=compile_patterns(['^' + re.escape(server) + '/ok']))
    with pytest.raises(FetchError, match='dot segments'):
        fetcher.fetch(server + suffix)


def test_allow_list_is_matched_against_the_url_that_is_sent(server):
    # requests folds query params into the URL; the folded URL is what the pattern sees.
    fetcher = make(allow_patterns=compile_patterns([pinned(server, '/json?a=1')]))
    assert fetcher.fetch(f'{server}/json', params={'a': '1'}).json()['ua']


def test_allow_list_without_canonicalizer_fails_closed(server):
    fetcher = make(allow_patterns=compile_patterns(['^' + pinned(server, '/ok')]), canonicalize=None)
    with pytest.raises(FetchError, match='matcher'):
        fetcher.fetch(f'{server}/ok')


def test_redirect_body_does_not_count_against_or_bypass_the_size_cap(server):
    result = make(max_bytes=1000).fetch(f'{server}/redirect-big')
    assert result.text() == 'hello'


def test_dns_lookup_is_bounded_by_the_timeout(server):
    def slow_resolver(url):
        time.sleep(5)
        return Validator()(url)

    start = time.monotonic()
    with pytest.raises(FetchError, match='timed out'):
        make(validator=slow_resolver, timeout=1).fetch(f'{server}/ok')
    assert time.monotonic() - start < 3


def test_resolver_error_omits_query_string():
    # An out-of-range port passes the scheme and host checks and fails in the resolver.
    fetcher = Fetcher(resolve_url=pinned_http.resolve_public_addresses, open_session=pinned_http.pinned_session)
    with pytest.raises(FetchError) as exc_info:
        fetcher.fetch('https://api.example.com:99999/v1?apiKey=SECRET')
    assert 'SECRET' not in str(exc_info.value)


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


@pytest.mark.parametrize('status', [307, 308])
def test_cross_origin_body_redirect_refused(server, other_server, status):
    other_port = int(other_server.rsplit(':', 1)[1])
    with pytest.raises(FetchError, match='request body to a different origin'):
        make().fetch(f'{server}/post-{status}?to={other_server}/echo', method='POST', json_body={'key': 'secret'})
    assert not [post for post in RECEIVED_POSTS if post[0] == other_port], 'the second origin received the body'


def test_same_origin_307_keeps_body(server):
    data = make().fetch(f'{server}/post-307?to=/echo', method='POST', json_body={'q': 2}).json()
    assert data == {'got': {'q': 2}}


def test_truncated_json_names_the_size_limit(server):
    result = make(max_bytes=4).fetch(f'{server}/json')
    assert result.truncated
    with pytest.raises(ValueError, match='Max response size'):
        result.json()


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


# -- redirect rules, without a socket ---------------------------------------

_HEADERS = {'User-Agent': 'ua', 'Accept': '*/*', 'Authorization': 'Bearer k', 'X-Api-Key': 'k'}


def test_redirect_step_same_origin_keeps_everything():
    target, method, body, headers = _redirect_step(307, 'https://a.example/x', '/y', 'POST', {'q': 1}, _HEADERS)
    assert (target, method, body, headers) == ('https://a.example/y', 'POST', {'q': 1}, _HEADERS)


def test_redirect_step_other_origin_keeps_only_safe_headers():
    _target, _method, _body, headers = _redirect_step(
        302, 'https://a.example/x', 'https://b.example/y', 'GET', None, _HEADERS
    )
    assert {k.lower() for k in headers} <= SAFE_REDIRECT_HEADERS
    assert 'Authorization' not in headers and 'X-Api-Key' not in headers


@pytest.mark.parametrize('origin', ['https://b.example/y', 'http://a.example/y', 'https://a.example:8443/y'])
@pytest.mark.parametrize('status', [307, 308])
def test_redirect_step_refuses_a_body_to_another_origin(status, origin):
    with pytest.raises(FetchError, match='different origin'):
        _redirect_step(status, 'https://a.example/x', origin, 'POST', {'key': 'secret'}, _HEADERS)


@pytest.mark.parametrize(
    'status,method,expected',
    [
        (303, 'POST', 'GET'),
        (303, 'GET', 'GET'),
        (301, 'POST', 'GET'),
        (302, 'POST', 'GET'),
        (301, 'GET', 'GET'),
        (307, 'POST', 'POST'),
    ],
)
def test_redirect_step_method_rules(status, method, expected):
    _target, new_method, body, _headers = _redirect_step(
        status, 'https://a.example/x', '/y', method, {'q': 1}, _HEADERS
    )
    assert new_method == expected
    assert (body is None) == (expected == 'GET' and method == 'POST' or status == 303)


def test_redirect_step_invalid_location():
    with pytest.raises(FetchError, match='invalid Location'):
        _redirect_step(302, 'https://a.example/?key=secret', 'https://[', 'GET', None, _HEADERS)


# -- TLS: the watchdog reaches the live SSLSocket ----------------------------

_TLS_HELPER = _PINNED_PATH.parents[3].parent / 'tests' / 'ai' / 'common' / 'utils' / 'tls_test_server.py'
_spec = importlib.util.spec_from_file_location('scraper_test_tls_server', _TLS_HELPER)
tls_test_server = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tls_test_server)


@pytest.fixture(scope='module')
def https_server(tmp_path_factory):
    cert, key = tls_test_server.make_cert(tmp_path_factory.mktemp('tls'))
    httpd, port = tls_test_server.serve_https(cert, key)
    yield f'https://127.0.0.1:{port}', cert
    httpd.shutdown()


@pytest.mark.parametrize('path', ['/slow-headers', '/slow-body'])
def test_timeout_bounds_slow_https(https_server, monkeypatch, path):
    base, cert = https_server
    monkeypatch.setenv('REQUESTS_CA_BUNDLE', cert)
    start = time.monotonic()
    with pytest.raises(FetchError, match='timed out'):
        make(timeout=1).fetch(base + path)
    assert time.monotonic() - start < 3
