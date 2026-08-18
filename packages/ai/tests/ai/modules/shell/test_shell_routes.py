"""
Unit tests for the shell module's public SPA routes and SEO endpoints.

Mounts the handlers from ``ai.modules.shell.shell`` on a minimal FastAPI
app and drives them through the synchronous ``TestClient``:

  - every PUBLIC_ROUTES path (e.g. /pricing) serves the SPA index.html
    so deep links survive a hard reload;
  - /sitemap.xml and /llms.txt 404 unless RR_APP_URL is set, and derive
    all absolute URLs exclusively from it (never from request headers);
  - /robots.txt allows crawlers and points at the sitemap on the hosted
    SaaS (RR_APP_URL set), and disallows all crawling otherwise;
  - WebServer.add_route rejects duplicate (method, path) registrations.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai.modules.shell.shell as shell_mod
from ai.modules.shell.shell import (
    DOCS_URL,
    LISTED_ROUTE_MANIFEST,
    LISTED_ROUTES,
    PUBLIC_ROUTE_MANIFEST,
    PUBLIC_ROUTES,
    UNLISTED_ROUTES,
    llms_txt,
    robots_txt,
    shell_static,
    sitemap_xml,
)

# Base URL used whenever the hosted-SaaS mode (RR_APP_URL set) is under test.
BASE = 'https://rocketride.example'


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _client() -> TestClient:
    """
    Build a minimal FastAPI app mirroring the shell module's route table.

    Registers one GET route per PUBLIC_ROUTES entry (same loop as
    ``ai.modules.shell.initModule``) plus the three SEO endpoints.

    Returns:
        TestClient: ready to send synchronous requests to the app.
    """
    app = FastAPI()
    for route in PUBLIC_ROUTES:
        app.get(route)(shell_static)
    app.get('/sitemap.xml')(sitemap_xml)
    app.get('/robots.txt')(robots_txt)
    app.get('/llms.txt')(llms_txt)
    return TestClient(app)


@pytest.fixture
def shell_root(tmp_path, monkeypatch):
    """
    Point the module's shell root at a temp dir containing an index.html.
    """
    index = tmp_path / 'index.html'
    index.write_text('<!doctype html><title>shell</title>')
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path))
    return tmp_path


@pytest.fixture
def no_app_url(monkeypatch):
    """
    Ensure RR_APP_URL is unset — the OSS / self-hosted / desktop mode.
    """
    monkeypatch.delenv('RR_APP_URL', raising=False)


@pytest.fixture
def app_url(monkeypatch):
    """
    Pin RR_APP_URL (with a trailing slash to prove it gets stripped) —
    the hosted SaaS mode.
    """
    monkeypatch.setenv('RR_APP_URL', BASE + '/')


# ---------------------------------------------------------------------------
# Public SPA routes
# ---------------------------------------------------------------------------


def test_public_routes_contains_home_ui_pages():
    # Mirrors the home-ui route manifest (apps/home-ui/src/routes.ts) — a page
    # deep-linkable on the client must also be served here, or a hard reload
    # 404s before the client can take over.
    for route in (
        '/',
        '/pricing',
        '/marketplace',
        '/build-publish-earn',
        '/store',
        '/oss',
        '/cloud',
        '/mcp',
        '/extension',
        '/sdk',
        '/blog',
        '/events',
        '/about',
        '/careers',
        '/contact',
    ):
        assert route in PUBLIC_ROUTES


def test_unlisted_routes_are_served_but_not_listed():
    # routes.ts marks /oss and /mcp `unlisted` (client stamps noindex), and
    # /store is the legacy alias canonicalized to /marketplace — all three must
    # keep serving while staying out of the advertised subset.
    for route in UNLISTED_ROUTES:
        assert route in PUBLIC_ROUTES
        assert route not in LISTED_ROUTES


def test_manifest_entries_have_titles_and_descriptions():
    for route, title, description in PUBLIC_ROUTE_MANIFEST:
        assert route.startswith('/')
        assert title
        assert description


@pytest.mark.parametrize('route', PUBLIC_ROUTES)
def test_public_routes_serve_index_html(shell_root, route):
    resp = _client().get(route)
    assert resp.status_code == 200
    assert '<title>shell</title>' in resp.text


# ---------------------------------------------------------------------------
# /sitemap.xml
# ---------------------------------------------------------------------------


def test_sitemap_404_without_app_url(no_app_url):
    resp = _client().get('/sitemap.xml')
    assert resp.status_code == 404


def test_sitemap_lists_all_listed_routes(app_url):
    resp = _client().get('/sitemap.xml')
    assert resp.status_code == 200
    assert resp.headers['content-type'].startswith('application/xml')
    assert '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' in resp.text
    for route in LISTED_ROUTES:
        assert f'<loc>{BASE}{route}</loc>' in resp.text
    for route in UNLISTED_ROUTES:
        assert f'<loc>{BASE}{route}</loc>' not in resp.text


def test_sitemap_ignores_forwarded_headers(app_url):
    # Forwarded headers are attacker-controlled — they must never leak into
    # sitemap URLs (cache-poisoning vector). RR_APP_URL is the only source.
    resp = _client().get(
        '/sitemap.xml',
        headers={
            'X-Forwarded-Proto': 'http',
            'X-Forwarded-Host': 'evil.example.com',
        },
    )
    assert 'evil.example.com' not in resp.text
    assert f'<loc>{BASE}/pricing</loc>' in resp.text


def test_sitemap_sets_cache_control(app_url):
    resp = _client().get('/sitemap.xml')
    assert resp.headers['cache-control'] == 'public, max-age=3600'


# ---------------------------------------------------------------------------
# /robots.txt
# ---------------------------------------------------------------------------


def test_robots_disallows_all_without_app_url(no_app_url):
    resp = _client().get('/robots.txt')
    assert resp.status_code == 200
    assert resp.headers['content-type'].startswith('text/plain')
    assert 'User-agent: *' in resp.text
    assert 'Disallow: /' in resp.text
    assert 'Allow:' not in resp.text
    assert 'Sitemap:' not in resp.text


def test_robots_allows_all_and_points_at_sitemap(app_url):
    resp = _client().get('/robots.txt')
    assert resp.status_code == 200
    assert resp.headers['content-type'].startswith('text/plain')
    assert 'User-agent: *' in resp.text
    assert 'Allow: /' in resp.text
    assert 'Disallow:' not in resp.text
    assert f'Sitemap: {BASE}/sitemap.xml' in resp.text


@pytest.mark.parametrize('fixture', ['no_app_url', 'app_url'])
def test_robots_sets_cache_control(fixture, request):
    request.getfixturevalue(fixture)
    resp = _client().get('/robots.txt')
    assert resp.headers['cache-control'] == 'public, max-age=3600'


# ---------------------------------------------------------------------------
# /llms.txt
# ---------------------------------------------------------------------------


def test_llms_404_without_app_url(no_app_url):
    resp = _client().get('/llms.txt')
    assert resp.status_code == 404


def test_llms_lists_all_pages_with_absolute_urls(app_url):
    resp = _client().get('/llms.txt')
    assert resp.status_code == 200
    assert resp.headers['content-type'] == 'text/plain; charset=utf-8'
    assert resp.text.startswith('# RocketRide\n')
    assert '## Pages' in resp.text
    for route, title, description in LISTED_ROUTE_MANIFEST:
        assert f'- [{title}]({BASE}{route}): {description}' in resp.text
    for route in UNLISTED_ROUTES:
        assert f'({BASE}{route})' not in resp.text
    assert '## Documentation' in resp.text
    assert f'- [Docs]({DOCS_URL}): Product and API documentation.' in resp.text


def test_llms_sets_cache_control(app_url):
    resp = _client().get('/llms.txt')
    assert resp.headers['cache-control'] == 'public, max-age=3600'


# ---------------------------------------------------------------------------
# WebServer.add_route duplicate detection
# ---------------------------------------------------------------------------


@pytest.fixture
def web_server():
    """
    Build a real WebServer instance for route-registration tests.

    ``ai.web.server`` transitively imports the engine-native ``engLib``
    module (via depends/rocketlib); when those stubs are unavailable the
    tests are skipped rather than erroring at collection.
    """
    server_mod = pytest.importorskip('ai.web.server', reason='requires engine-native module stubs')
    return server_mod.WebServer(config={'port': 0, 'host': '127.0.0.1'})


async def _handler(request):
    """Minimal route handler used for registration tests."""


def test_add_route_rejects_duplicate_method_and_path(web_server):
    web_server.add_route('/shadowed', _handler, ['GET'], public=True)
    with pytest.raises(ValueError, match='GET /shadowed'):
        web_server.add_route('/shadowed', _handler, ['GET'])


def test_add_route_allows_same_path_different_method(web_server):
    # task_http registers /task under POST/GET/DELETE/PUT — same path with
    # distinct methods must keep working.
    web_server.add_route('/multi', _handler, ['POST'])
    web_server.add_route('/multi', _handler, ['GET'])
    web_server.add_route('/multi', _handler, ['DELETE'])


def test_add_route_rejects_overlap_within_method_list(web_server):
    web_server.add_route('/mixed', _handler, ['GET', 'POST'])
    with pytest.raises(ValueError, match='POST /mixed'):
        web_server.add_route('/mixed', _handler, ['POST', 'PATCH'])
