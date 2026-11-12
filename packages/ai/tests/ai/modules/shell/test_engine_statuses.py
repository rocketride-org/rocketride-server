# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Statuses of the real engine wiring: ``ai.eaas.run`` builds the server (every
module, the account layer, the public-page catch-all last, the auth
middleware in front) and only ``serve`` is stubbed out.

Without the catch-all, every path no route claimed answered 401 from the auth
middleware before routing: unknown paths, trailing-slash variants of pages
and moved URLs alike, and every page got the shell's generic title. These
pin what an anonymous caller gets instead. The aggregate is a trimmed view of
home-ui's manifest; ``bare_engine`` has none, as an OSS engine without home-ui.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

import ai.modules.shell.public_pages as pp

from .engine_boot import SHELL_BODY, boot_engine
from .home_ui_fixture import home_ui_manifest

GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'


HOME_MANIFEST = home_ui_manifest('/', '/pricing', '/legal/terms', '/legal/privacy-policy')


def _engine(monkeypatch, tmp_path, published):
    """The app ``eaas.run`` serves, over the given published manifests."""
    return TestClient(boot_engine(monkeypatch, tmp_path, published).app, follow_redirects=False)


@pytest.fixture
def engine(monkeypatch, tmp_path):
    """The engine with home-ui's manifest published."""
    client = _engine(monkeypatch, tmp_path, [pp.Published('rocketride.home', HOME_MANIFEST)])
    assert pp.current().exact
    return client


@pytest.fixture
def bare_engine(monkeypatch, tmp_path):
    """The engine with no published manifest: an OSS engine without home-ui."""
    client = _engine(monkeypatch, tmp_path, [])
    assert not pp.current().exact
    return client


@pytest.fixture
def engine_under_root_path(engine):
    """The same app behind a proxy prefix: uvicorn --root-path /api sends scope path '/api/...'."""
    return TestClient(engine.app, follow_redirects=False, root_path='/api')


@pytest.mark.parametrize('ua', [GOOGLEBOT, BROWSER])
def test_every_page_gets_its_own_title(engine, ua):
    for path, title in (
        ('/pricing', 'Pricing | RocketRide'),
        ('/legal/terms', 'RocketRide Cloud Terms of Service | RocketRide'),
    ):
        resp = engine.get(path, headers={'User-Agent': ua})
        assert resp.status_code == 200, path
        assert f'<title>{title}</title>' in resp.text and '<title>shell</title>' not in resp.text, path
        assert SHELL_BODY in resp.text
    assert '<title>RocketRide</title>' in engine.get('/', headers={'User-Agent': ua}).text


@pytest.mark.parametrize('method', ['GET', 'HEAD'])
def test_unknown_paths_are_404_not_401(engine, method):
    for path in ('/nope/nope', '/index.html', '/home', '/legal/not-a-document'):
        resp = engine.request(method, path)
        assert resp.status_code == 404, path


def test_pages_serve_and_private_routes_still_401(engine):
    resp = engine.get('/pricing')
    assert resp.status_code == 200 and SHELL_BODY in resp.text
    # Paths a real route's pattern matches stay behind auth, whatever the method.
    for method, path in (('GET', '/status'), ('POST', '/status'), ('POST', '/mcp'), ('GET', '/mcp/anything')):
        assert engine.request(method, path).status_code == 401, (method, path)


@pytest.mark.parametrize('method', ['GET', 'HEAD'])
def test_a_pages_trailing_slash_twin_is_301_to_the_page(engine, method):
    for path, location in (
        ('/pricing/', '/pricing'),
        ('/legal/terms/', '/legal/terms'),
        ('/pricing/?utm_source=x&b=1', '/pricing?utm_source=x&b=1'),
    ):
        resp = engine.request(method, path)
        assert resp.status_code == 301 and resp.headers['location'] == location, path
    # '/' itself is untouched; a slash twin of a non-page is a plain 404.
    assert engine.request(method, '/').status_code == 200
    assert engine.request(method, '/nope/').status_code == 404


@pytest.mark.parametrize('method', ['GET', 'HEAD'])
def test_moved_urls_are_301_to_their_documents(engine, method):
    for path, location in (
        ('/terms', '/legal/terms'),
        ('/terms/', '/legal/terms'),
        ('/privacy-policy', '/legal/privacy-policy'),
        ('/privacy-policy/', '/legal/privacy-policy'),
        ('/privacy', '/legal/privacy-policy'),
        ('/privacy/', '/legal/privacy-policy'),
        ('/terms?ref=deck', '/legal/terms?ref=deck'),
    ):
        resp = engine.request(method, path)
        assert resp.status_code == 301 and resp.headers['location'] == location, path
    assert engine.get('/terms', follow_redirects=True).status_code == 200


def test_auth_decides_on_the_path_the_router_matches(engine_under_root_path):
    # The router strips root_path before matching; the auth decision must too,
    # or '/api/status' looks unrouted (public) while the router serves /status.
    client = engine_under_root_path
    for method, path in (('GET', '/api/status'), ('POST', '/api/task'), ('GET', '/api/mcp/anything')):
        assert client.request(method, path).status_code == 401, (method, path)
    assert client.get('/api/nope/nope').status_code == 404


@pytest.mark.parametrize('ua', [GOOGLEBOT, BROWSER])
def test_pages_and_redirects_serve_under_a_root_path(engine_under_root_path, ua):
    client = engine_under_root_path
    resp = client.get('/api/pricing', headers={'User-Agent': ua})
    assert resp.status_code == 200 and '<title>Pricing | RocketRide</title>' in resp.text
    # Locations keep the prefix the proxy routes on.
    for path, location in (('/api/terms', '/api/legal/terms'), ('/api/pricing/?a=1', '/api/pricing?a=1')):
        resp = client.get(path, headers={'User-Agent': ua})
        assert resp.status_code == 301 and resp.headers['location'] == location, path
    # The router's own answers keep the prefix too: a real route's slash twin, a page's other methods.
    resp = client.get('/api/status/', headers={'User-Agent': ua})
    assert resp.status_code == 307 and resp.headers['location'] == '/api/status'
    assert client.post('/api/pricing', headers={'User-Agent': ua}).status_code == 405


def test_a_real_routes_slash_twin_redirects_relatively_never_via_the_host_header(engine):
    for path, location in (('/status/', '/status'), ('/status/?a=1', '/status?a=1')):
        resp = engine.get(path, headers={'host': 'evil.example'})
        assert resp.status_code == 307 and resp.headers['location'] == location, path


@pytest.mark.parametrize('method', ['GET', 'HEAD'])
@pytest.mark.parametrize('ua', [GOOGLEBOT, BROWSER])
def test_the_root_still_serves_the_shell_without_a_root_owner_manifest(bare_engine, method, ua):
    resp = bare_engine.request(method, '/', headers={'User-Agent': ua})
    assert resp.status_code == 200
    if method == 'GET':
        assert SHELL_BODY in resp.text


def test_without_a_root_owner_manifest_public_paths_and_moved_urls_are_404(bare_engine):
    for path in ('/pricing', '/legal/terms', '/terms', '/privacy'):
        assert bare_engine.get(path).status_code == 404, path
    # Real routes stay behind auth.
    assert bare_engine.get('/status').status_code == 401


def test_a_root_app_the_store_cannot_read_keeps_every_page_and_redirect(engine, monkeypatch):
    async def unreadable_home(acct=None, strict=False, exclude='', unreadable=None):
        unreadable.add('rocketride.home')  # still published, its manifest unreadable for now
        return []

    monkeypatch.setattr(pp, 'load_published', unreadable_home)
    assert asyncio.run(pp.rebuild())
    for path in ('/', '/pricing', '/legal/terms', '/legal/privacy-policy'):
        assert engine.get(path).status_code == 200, path
    assert engine.get('/terms').headers['location'] == '/legal/terms'
