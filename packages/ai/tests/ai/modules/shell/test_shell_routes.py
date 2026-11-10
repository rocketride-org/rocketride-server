"""
Unit tests for the shell module's public pages and SEO endpoints.

Mounts the handlers from ``ai.modules.shell`` on a minimal FastAPI app the
way ``initModule`` + ``register_public_pages`` do (``/`` and the SEO files
first, the public-page catch-all LAST) and drives them through the
synchronous ``TestClient``:

  - every page the aggregate claims (the legacy page list until a published
    manifest declares pages) serves the shell document with its head
    metadata injected, so deep links survive a hard reload;
  - /sitemap.xml and /llms.txt 404 unless RR_APP_URL is set, and derive
    all absolute URLs exclusively from it (never from request headers);
  - served-vs-advertised is driven by each page's ``listed`` flag;
  - /robots.txt allows crawlers (one named group per rostered crawler) and
    points at the sitemap on the hosted SaaS (RR_APP_URL set), and
    disallows all crawling otherwise;
  - the catch-all registers last, real routes win, it never makes a private
    route public, and it keeps the router's own answers for unclaimed paths;
  - WebServer.add_route rejects duplicate (method, path) registrations.
"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse
from fastapi.testclient import TestClient

import ai.modules.shell.pages as pages_mod
import ai.modules.shell.public_pages as pp
import ai.modules.shell.shell as shell_mod
from ai.modules.shell.crawlers import CRAWLERS
from ai.modules.shell.pages import FALLBACK_PATH, public_page
from ai.modules.shell.public_pages import Aggregate, Page, legacy_aggregate
from ai.modules.shell.shell import (
    llms_txt,
    robots_txt,
    shell_static,
    sitemap_xml,
)

# Base URL used whenever the hosted-SaaS mode (RR_APP_URL set) is under test.
BASE = 'https://rocketride.example'

# Marker of the built shell's index.html (head injection replaces its title).
SHELL_BODY = '<div id="root">shell</div>'

GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _client() -> TestClient:
    """
    Build a minimal FastAPI app mirroring the shell module's route table.

    ``/`` and the three SEO endpoints first (``initModule``), the public-page
    catch-all LAST (``register_public_pages``).

    Returns:
        TestClient: ready to send synchronous requests to the app.
    """
    app = FastAPI()
    app.get('/')(public_page)
    app.get('/sitemap.xml')(sitemap_xml)
    app.get('/robots.txt')(robots_txt)
    app.get('/llms.txt')(llms_txt)
    app.get(FALLBACK_PATH)(public_page)
    return TestClient(app)


def _shell_client() -> TestClient:
    """
    Build an app with only the shell asset route, as ``initModule`` registers it.

    Returns:
        TestClient: client for ``GET /shell/{file_path:path}``.
    """
    app = FastAPI()
    app.get('/shell/{file_path:path}')(shell_static)
    return TestClient(app)


@pytest.fixture
def shell_root(tmp_path, monkeypatch):
    """
    Point the module's shell root at a temp dir containing an index.html.
    """
    index = tmp_path / 'index.html'
    index.write_text(f'<!doctype html><html><head><title>shell</title></head><body>{SHELL_BODY}</body></html>')
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


def _use(*pages, site=None, redirects=None):
    """Swap in an aggregate holding exactly ``pages`` (and ``redirects``)."""
    pp.swap(Aggregate(exact={p.path: p for p in pages}, site=site or {}, redirects=redirects or {}))


LEGACY = legacy_aggregate()
LEGACY_PATHS = [p.path for p in LEGACY.pages()]
LISTED_PATHS = [p.path for p in LEGACY.pages() if p.listed]
UNLISTED_PATHS = [p.path for p in LEGACY.pages() if not p.listed]


# ---------------------------------------------------------------------------
# Public pages: the legacy page list (until a published manifest declares pages)
# ---------------------------------------------------------------------------


def test_legacy_pages_contain_home_ui_pages():
    # Mirrors the home-ui route manifest (apps/home-ui/src/routes.ts): a page
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
        '/mcp-server',
        '/extension',
        '/sdk',
        '/blog',
        '/events',
        '/about',
        '/careers',
        '/contact',
        '/superfans',
    ):
        assert route in LEGACY.exact


LEGAL_PAGES = (
    '/legal',
    '/legal/terms',
    '/legal/privacy-policy',
    '/legal/dpa',
    '/legal/acceptable-use',
    '/legal/subprocessors',
    '/legal/trademark-policy',
    '/legal/cookie-policy',
    '/legal/marketplace-terms',
)


def test_legal_pages_are_public_pages_and_listed():
    for route in LEGAL_PAGES:
        assert route in LEGACY.exact
        assert route in LISTED_PATHS


def test_legal_pages_are_exact_paths():
    # Only the published documents are pages: a slug that is not a document (a
    # typo, an unpublished slug) is a 404 like any other unclaimed path.
    legal = [route for route in LEGACY_PATHS if route == '/legal' or route.startswith('/legal/')]
    assert sorted(legal) == sorted(LEGAL_PAGES)
    assert '/legal/not-a-document' not in LEGACY.exact


def test_legal_index_description_mirrors_the_client_manifest():
    # The description is the client's string (routes.ts), character for character.
    assert LEGACY.exact['/legal'].description == (
        'The policies and terms that govern RocketRide Cloud - each document with its version, '
        'effective date, and latest change.'
    )


def test_superfans_page_is_an_exact_public_listed_page():
    assert '/superfans' in LEGACY.exact
    assert '/superfans' in LISTED_PATHS
    assert [route for route in LEGACY_PATHS if route.startswith('/superfans')] == ['/superfans']


def test_superfans_entry_mirrors_the_client_manifest():
    page = LEGACY.exact['/superfans']
    assert page.title == 'Superfans'
    assert page.head_title == 'Superfans | RocketRide'  # routes.ts document title
    assert page.description == (
        'The developers who build with RocketRide and tell us the truth. Earn early builds, '
        'a hand on the roadmap, and artifacts you can only be given.'
    )


def test_mcp_api_paths_are_not_shell_pages():
    # /mcp and /mcp/* are the MCP API (a Starlette Mount in ai.modules.mcp).
    for route in LEGACY_PATHS:
        assert route != '/mcp' and not route.startswith('/mcp/'), route


def test_unlisted_pages_are_served_but_not_listed():
    # /oss, /mcp-server, /marketplace and /build-publish-earn are `unlisted` on
    # the client, and /store is the legacy alias of /marketplace.
    assert sorted(UNLISTED_PATHS) == sorted(['/oss', '/mcp-server', '/store', '/marketplace', '/build-publish-earn'])


def test_marketplace_pair_is_hidden_for_now():
    for route in ('/marketplace', '/store', '/build-publish-earn'):
        assert route in LEGACY.exact
        assert route not in LISTED_PATHS


def test_pages_have_titles_and_descriptions():
    for page in LEGACY.pages():
        assert page.path.startswith('/')
        assert page.title
        assert page.description


@pytest.mark.parametrize('route', LEGACY_PATHS)
def test_public_pages_serve_the_shell_document(shell_root, route):
    resp = _client().get(route)
    assert resp.status_code == 200
    assert SHELL_BODY in resp.text
    assert f'<title>{LEGACY.exact[route].head_title}</title>' in resp.text.replace('&amp;', '&')


def test_googlebot_gets_the_page_title_not_the_shells(shell_root):
    resp = _client().get('/pricing', headers={'User-Agent': GOOGLEBOT})
    assert resp.status_code == 200
    assert '<title>Pricing | RocketRide</title>' in resp.text and '<title>shell</title>' not in resp.text


# ---------------------------------------------------------------------------
# /sitemap.xml
# ---------------------------------------------------------------------------


def test_sitemap_404_without_app_url(no_app_url):
    resp = _client().get('/sitemap.xml')
    assert resp.status_code == 404


def test_sitemap_lists_exactly_the_listed_pages(app_url):
    resp = _client().get('/sitemap.xml')
    assert resp.status_code == 200
    assert resp.headers['content-type'].startswith('application/xml')
    assert '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' in resp.text
    for route in LISTED_PATHS:
        assert f'<loc>{BASE}{route}</loc>' in resp.text
    for route in UNLISTED_PATHS:
        assert f'<loc>{BASE}{route}</loc>' not in resp.text
    # Deterministic: sorted by path.
    paths = [line.split(BASE, 1)[1].split('</loc>')[0] for line in resp.text.splitlines() if '<loc>' in line]
    assert paths == sorted(paths)


def test_sitemap_follows_the_listed_flag_of_published_pages(app_url):
    _use(Page('/', 'rocketride.home', 'Home'), Page('/hidden', 'rocketride.home', 'H', listed=False))
    text = _client().get('/sitemap.xml').text
    assert f'<loc>{BASE}/</loc>' in text and '/hidden' not in text


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
    assert resp.text == 'User-agent: *\nDisallow: /\n'


def test_robots_allows_all_and_points_at_sitemap(app_url):
    resp = _client().get('/robots.txt')
    assert resp.status_code == 200
    assert resp.headers['content-type'].startswith('text/plain')
    assert 'User-agent: *' in resp.text
    assert 'Allow: /' in resp.text
    assert 'Disallow:' not in resp.text
    assert f'Sitemap: {BASE}/sitemap.xml' in resp.text


def test_robots_named_groups_come_from_the_roster(app_url):
    text = _client().get('/robots.txt').text
    for token, _ in CRAWLERS:
        assert f'User-agent: {token}\nAllow: /\n' in text
    assert text.endswith(f'User-agent: *\nAllow: /\n\nSitemap: {BASE}/sitemap.xml\n')


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


def test_llms_lists_listed_pages_with_absolute_urls(app_url):
    resp = _client().get('/llms.txt')
    assert resp.status_code == 200
    assert resp.headers['content-type'] == 'text/plain; charset=utf-8'
    assert resp.text.startswith('# RocketRide\n\n> Build, run, and harness AI at rocket speed.')
    assert '## Pages' in resp.text
    for page in LEGACY.pages():
        line = f'- [{page.title}]({BASE}{page.path}): {page.description}'
        assert (line in resp.text) == page.listed, page.path
    assert resp.text.endswith('## Documentation\n\n- [Docs](https://docs.rocketride.org/llms.txt)\n')


def test_llms_header_and_docs_link_come_from_the_site_block(app_url):
    _use(
        Page('/', 'rocketride.home', 'Home', 'Root.'),
        site={'title': 'Acme Cloud', 'blurb': 'Hello.', 'docsUrl': 'https://docs.acme.example/llms.txt'},
    )
    text = _client().get('/llms.txt').text
    assert text == (
        '# Acme Cloud\n\n> Hello.\n\n## Pages\n\n'
        f'- [Home]({BASE}/): Root.\n\n'
        '## Documentation\n\n- [Docs](https://docs.acme.example/llms.txt)\n'
    )


def test_llms_neutralises_markdown_injection(app_url):
    _use(Page('/', 'rocketride.home', 'A [link](https://evil.example)', 'line one\n## Heading\n- [x](https://evil)'))
    text = _client().get('/llms.txt').text
    assert '\n## Heading' not in text
    assert not re.search(r'(?<!\\)\]\(https://evil', text)  # no unescaped link syntax
    assert r'- [A \[link\](https://evil.example)]' in text


@pytest.mark.parametrize('site', [{}, {'title': ''}, {'title': ' \n '}])
def test_llms_heading_falls_back_to_the_origin_host(app_url, site):
    _use(Page('/', 'rocketride.home', 'Home', 'Root.'), site=site)
    text = _client().get('/llms.txt').text
    assert text.startswith('# rocketride.example\n\n## Pages\n')
    assert '## Documentation' not in text


def test_llms_docs_link_is_neutralised_like_every_manifest_string(app_url):
    _use(Page('/', 'rocketride.home', 'Home'), site={'title': 'R', 'docsUrl': 'https://docs.example/x](https://evil)'})
    text = _client().get('/llms.txt').text
    assert not re.search(r'(?<!\\)\]\(https://evil', text)
    assert text.endswith('- [Docs](https://docs.example/x\\](https://evil))\n')


def test_llms_sets_cache_control(app_url):
    resp = _client().get('/llms.txt')
    assert resp.headers['cache-control'] == 'public, max-age=3600'


def test_sitemap_and_llms_list_the_legal_and_superfans_pages(app_url):
    # Named here rather than read from the aggregate, so the test fails if one
    # of these pages drops out of the advertised subset. The expected titles and
    # descriptions are pinned copies of the client's strings (routes.ts and the
    # documents' front matter).
    expected = {
        '/legal': (
            'Legal',
            'The policies and terms that govern RocketRide Cloud - each document with its version, effective '
            'date, and latest change.',
        ),
        '/legal/terms': (
            'RocketRide Cloud Terms of Service',
            'The agreement governing use of RocketRide Cloud, including accounts, payments, and acceptable '
            'service use.',
        ),
        '/legal/privacy-policy': (
            'Privacy Policy',
            'How RocketRide collects, uses, and shares personal information across its websites and RocketRide Cloud.',
        ),
        '/legal/dpa': (
            'Data Processing Agreement',
            'The data processing terms that apply when RocketRide processes personal data on behalf of business '
            'customers.',
        ),
        '/legal/acceptable-use': (
            'Acceptable Use Policy',
            'The rules for what may and may not be done with RocketRide Cloud and its services.',
        ),
        '/legal/subprocessors': (
            'RocketRide Cloud Sub-processors',
            'The third-party sub-processors RocketRide uses to provide RocketRide Cloud, and how the list changes.',
        ),
        '/legal/trademark-policy': (
            'Trademark & Brand Usage Policy',
            'How the RocketRide name, logo, and brand assets may and may not be used.',
        ),
        '/legal/cookie-policy': (
            'Cookie Policy',
            'How RocketRide uses cookies, similar technologies, and website analytics on its websites and '
            'RocketRide Cloud, and the choices you have.',
        ),
        '/legal/marketplace-terms': (
            'Marketplace Publisher Terms',
            'The terms for publishing apps on the RocketRide Marketplace, including eligibility, revenue share, '
            'payouts, and taxes.',
        ),
        '/superfans': (
            'Superfans',
            'The developers who build with RocketRide and tell us the truth. Earn early builds, a hand on the '
            'roadmap, and artifacts you can only be given.',
        ),
    }
    assert sorted(expected) == sorted(LEGAL_PAGES + ('/superfans',))
    sitemap = _client().get('/sitemap.xml').text
    llms = _client().get('/llms.txt').text
    for route, (title, description) in expected.items():
        assert f'<loc>{BASE}{route}</loc>' in sitemap
        assert f'- [{title}]({BASE}{route}): {description}' in llms


@pytest.mark.parametrize('fixture', ['no_app_url', 'app_url'])
def test_crawler_files_answer_head_like_get(web_server, shell_root, monkeypatch, request, fixture):
    request.getfixturevalue(fixture)
    client = _start_engine(web_server, monkeypatch)
    for path in ('/sitemap.xml', '/robots.txt', '/llms.txt'):
        get, head = client.get(path), client.head(path)
        assert head.status_code == get.status_code, path
        assert head.content == b'', path
        for name in ('content-type', 'content-length', 'cache-control'):
            assert head.headers.get(name) == get.headers.get(name), (path, name)
    assert client.head('/robots.txt').status_code == 200


def test_crawler_files_trigger_the_refresh_backstop(monkeypatch, app_url):
    calls = []
    monkeypatch.setattr(pp, 'maybe_refresh', lambda: calls.append(1))
    _client().get('/sitemap.xml')
    _client().get('/llms.txt')
    assert len(calls) == 2


# ---------------------------------------------------------------------------
# The public-page catch-all: UA classes, head metadata, misses
# ---------------------------------------------------------------------------


def test_human_gets_the_shell_document_with_head_metadata(shell_root, app_url):
    _use(Page('/pricing', 'rocketride.home', 'Pricing | RocketRide', 'Plans & prices.'))
    resp = _client().get('/pricing', headers={'User-Agent': BROWSER})
    assert resp.status_code == 200
    assert SHELL_BODY in resp.text
    assert '<title>Pricing | RocketRide</title>' in resp.text and '<title>shell</title>' not in resp.text
    assert '<meta name="description" content="Plans &amp; prices.">' in resp.text
    assert f'<link rel="canonical" href="{BASE}/pricing">' in resp.text
    assert resp.headers['vary'] == 'User-Agent'
    # People's document names the current build's bundles: no shared cache may keep it.
    assert resp.headers['cache-control'] == 'private, no-cache'
    assert 'x-robots-tag' not in resp.headers and 'name="robots"' not in resp.text


def test_crawler_gets_the_same_document_with_cache_headers(shell_root, app_url):
    _use(Page('/pricing', 'rocketride.home', 'Pricing', 'Plans.'))
    human = _client().get('/pricing', headers={'User-Agent': BROWSER})
    resp = _client().get('/pricing', headers={'User-Agent': GOOGLEBOT})
    assert resp.status_code == 200
    assert resp.text == human.text and '<title>Pricing</title>' in resp.text
    assert resp.headers['cache-control'] == 'public, max-age=3600'
    assert resp.headers['vary'] == 'User-Agent'


def test_the_shell_document_is_read_once_per_page_and_build(shell_root, app_url, monkeypatch):
    # Reading and rewriting the shell file on every request would put disk I/O
    # and regex passes on the hottest public path.
    reads = []
    real = Path.read_text
    monkeypatch.setattr(Path, 'read_text', lambda self, *a, **k: reads.append(self.name) or real(self, *a, **k))
    _use(Page('/pricing', 'rocketride.home', 'Pricing', 'Plans.'))
    client = _client()
    for _ in range(3):
        assert client.get('/pricing', headers={'User-Agent': BROWSER}).status_code == 200
    assert reads == ['index.html']
    _use(Page('/pricing', 'rocketride.home', 'Pricing v2', 'Plans.'))  # a swap
    assert '<title>Pricing v2</title>' in client.get('/pricing', headers={'User-Agent': BROWSER}).text
    index = shell_root / 'index.html'
    stat = index.stat()
    os.utime(index, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))  # a new shell build
    client.get('/pricing', headers={'User-Agent': BROWSER})
    assert reads == ['index.html'] * 3


@pytest.mark.parametrize('ua', [GOOGLEBOT, BROWSER])
def test_unlisted_pages_carry_noindex_for_both_ua_classes(shell_root, ua):
    _use(Page('/store', 'rocketride.home', 'Store', listed=False))
    resp = _client().get('/store', headers={'User-Agent': ua})
    assert resp.status_code == 200
    assert resp.headers['x-robots-tag'] == 'noindex'
    assert '<meta name="robots" content="noindex">' in resp.text


def test_canonical_only_from_rr_app_url_never_forwarded_headers(shell_root, no_app_url):
    _use(Page('/pricing', 'rocketride.home', 'Pricing'))
    resp = _client().get('/pricing', headers={'X-Forwarded-Host': 'evil.example.com', 'X-Forwarded-Proto': 'http'})
    assert 'canonical' not in resp.text and 'evil.example.com' not in resp.text


def test_unclaimed_paths_404(shell_root):
    _use(Page('/pricing', 'rocketride.home', 'Pricing'))
    for path in ('/nope', '/pricing/extra', '/Pricing', '/pricing//', '/nope/'):
        assert _client().get(path).status_code == 404, path
    resp = _client().get('/pricing/', follow_redirects=False)  # the page's slash twin
    assert resp.status_code == 301 and resp.headers['location'] == '/pricing'
    assert resp.headers['cache-control'] == 'public, max-age=86400'


def test_root_unclaimed_still_serves_the_shell(shell_root):
    _use(Page('/pricing', 'rocketride.home', 'Pricing'))
    resp = _client().get('/')
    assert resp.status_code == 200 and '<title>shell</title>' in resp.text


def test_unbuilt_shell_is_503(tmp_path, monkeypatch):
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path / 'not-built'))
    _use(Page('/pricing', 'rocketride.home', 'Pricing'))
    resp = _client().get('/pricing')
    assert resp.status_code == 503 and 'shell:build' in resp.text


def test_hostile_page_titles_are_escaped_in_the_head(shell_root):
    _use(Page('/x', 'rocketride.home', '</title><script>alert(1)</script>', '"><img src=x onerror=alert(1)>'))
    text = _client().get('/x').text
    assert '<script>alert' not in text and '<img src=x' not in text


def test_pages_trigger_the_refresh_backstop(monkeypatch, shell_root):
    calls = []
    monkeypatch.setattr(pp, 'maybe_refresh', lambda: calls.append(1))
    _client().get('/pricing')
    _client().get('/nope')
    assert len(calls) == 2


def test_is_public_path_is_true_wherever_a_page_handler_answers(monkeypatch):
    app = FastAPI()
    app.get('/status')(_real_route)
    app.get('/')(public_page)
    app.get(FALLBACK_PATH)(public_page)
    monkeypatch.setattr(pages_mod, '_web_server', SimpleNamespace(app=app))
    _use(Page('/pricing', 'rocketride.home', 'Pricing'))
    # A page, or a path only the catch-all answers (with a 404): no credentials needed.
    for path in ('/', '/pricing', '/pricing/extra', '/nope'):
        assert pages_mod.is_public_path(path), path
    # A path a real route's pattern matches stays private.
    assert not pages_mod.is_public_path('/status')


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


def test_add_route_rejects_duplicate_method_within_single_call(web_server):
    # Methods are normalized to uppercase, so ['GET', 'get'] is one pair
    # repeated — it must be rejected within a single add_route() call.
    with pytest.raises(ValueError, match='GET /dupe'):
        web_server.add_route('/dupe', _handler, ['GET', 'get'])


def test_add_route_registry_unchanged_when_router_rejects(web_server, monkeypatch):
    # If FastAPI rejects the registration itself, the pairs must not be
    # recorded — a retry with the same route has to remain possible.
    def _boom(*args, **kwargs):
        raise RuntimeError('router rejected')

    monkeypatch.setattr(web_server.app.router, 'add_api_route', _boom)
    with pytest.raises(RuntimeError, match='router rejected'):
        web_server.add_route('/rejected', _handler, ['GET'])

    monkeypatch.undo()
    web_server.add_route('/rejected', _handler, ['GET'])


async def _real_route(request: Request):
    """A module/API route registered before the catch-all."""
    return PlainTextResponse('real route')


def _start_engine(web_server, monkeypatch, *, before_fallback=()):
    """Start the engine routes in eaas order: initModule, other routes, register_public_pages (no store reads)."""
    from ai.modules.shell import initModule, register_public_pages

    async def no_rebuild(acct=None):
        return True

    monkeypatch.setattr(pp.page_map, 'rebuild', no_rebuild)
    initModule(web_server, {})
    for path, handler, methods, kwargs in before_fallback:
        web_server.add_route(path, handler, methods, **kwargs)
    asyncio.run(register_public_pages(web_server))
    return TestClient(web_server.app, follow_redirects=False)


def test_page_routes_answer_404_off_their_exact_paths(web_server, shell_root, monkeypatch):
    # The routes as initModule + register_public_pages register them, behind
    # the server's own auth middleware: each page serves the SPA without
    # credentials, a sub-path or a slug that is not a document answers 404
    # (not the SPA, not a 401), and a trailing slash redirects to the page.
    client = _start_engine(web_server, monkeypatch)
    for route in LEGAL_PAGES + ('/superfans',):
        resp = client.get(route)
        assert resp.status_code == 200, route
        assert SHELL_BODY in resp.text
    for path in ('/legal/not-a-document', '/legal/terms/extra', '/superfans/extra'):
        assert client.get(path).status_code == 404, path
    for path in ('/legal/', '/legal/terms/', '/superfans/'):
        resp = client.get(path)
        assert resp.status_code == 301 and resp.headers['location'] == path[:-1], path


def test_fallback_registers_last_and_loses_to_every_real_route(web_server, shell_root, monkeypatch):
    # A public real route at a path the aggregate ALSO claims: the real route
    # must win because the catch-all registered after it.
    client = _start_engine(
        web_server, monkeypatch, before_fallback=[('/claimed', _real_route, ['GET'], {'public': True})]
    )
    _use(Page('/claimed', 'rocketride.home', 'Claimed'), Page('/pricing', 'rocketride.home', 'Pricing'))
    routes = web_server.app.router.routes
    assert getattr(routes[-1], 'path', None) == FALLBACK_PATH
    assert routes[-1].endpoint is public_page
    assert sum(1 for r in routes if getattr(r, 'path', None) == FALLBACK_PATH) == 1
    assert client.get('/claimed').text == 'real route'
    assert SHELL_BODY in client.get('/pricing').text


def test_a_route_added_after_the_fallback_is_shadowed(web_server, shell_root, monkeypatch):
    # Why the ordering is load-bearing: GET routes registered AFTER the
    # catch-all never match. eaas registers the catch-all after init_account.
    client = _start_engine(web_server, monkeypatch)
    _use(Page('/late', 'rocketride.home', 'Late'))
    web_server.add_route('/late', _real_route, ['GET'], public=True)
    assert client.get('/late').text != 'real route'


def test_a_late_non_get_route_never_rides_a_claimed_paths_auth_exemption(web_server, shell_root, monkeypatch):
    client = _start_engine(web_server, monkeypatch)
    _use(Page('/late', 'rocketride.home', 'Late'))
    web_server.add_route('/late', _real_route, ['POST'])  # private, registered after the catch-all
    resp = client.post('/late')
    assert resp.status_code == 405 and resp.text != 'real route'


def test_fallback_never_makes_a_private_route_public(web_server, shell_root, monkeypatch):
    # The catch-all is not registered public; a private route stays behind
    # auth even though the catch-all's path pattern matches every path.
    client = _start_engine(web_server, monkeypatch, before_fallback=[('/private-thing', _real_route, ['GET'], {})])
    assert client.get('/private-thing').status_code == 401
    assert client.get('/status').status_code == 401
    assert not web_server.is_public_route('/private-thing')


def test_private_routes_override_public_pages(web_server, shell_root, monkeypatch):
    client = _start_engine(
        web_server, monkeypatch, before_fallback=[('/secret', _real_route, ['GET'], {'private': True})]
    )
    _use(Page('/secret', 'rocketride.home', 'S'))
    assert client.get('/secret').status_code == 401


def test_a_claimed_page_never_opens_a_param_led_private_route(web_server, shell_root, monkeypatch):
    client = _start_engine(web_server, monkeypatch, before_fallback=[('/{org}/settings', _real_route, ['GET'], {})])
    # Claimed after registration, so the build-time live-route check never saw it.
    _use(Page('/foo/settings', 'rocketride.home', 'F'))
    assert not web_server.is_public_route('/foo/settings')
    resp = client.get('/foo/settings')
    assert resp.status_code == 401 and resp.text != 'real route'
    # A path no real route matches is public: the catch-all answers it.
    assert web_server.is_public_route('/foo/other-thing') is True


def test_routes_without_a_path_pattern_fail_closed(monkeypatch):
    class Hostish:
        endpoint = None

    fake = type('S', (), {'app': type('A', (), {'router': type('R', (), {'routes': [Hostish()]})()})()})()
    monkeypatch.setattr(pages_mod, '_web_server', fake)
    _use(Page('/x', 'rocketride.home', 'X'))
    assert pages_mod.is_public_path('/x') is False


def test_failing_public_predicate_fails_closed(web_server, monkeypatch):
    def boom(path):
        raise RuntimeError('broken')

    logged = []
    monkeypatch.setattr('ai.web.server.warning', logged.append)
    web_server.add_public_predicate(boom)
    assert web_server.is_public_route('/anything') is False
    # Every public page now answers 401: a warning, so production logs show it.
    assert len(logged) == 1 and "'/anything'" in logged[0] and 'broken' in logged[0]


def test_unknown_paths_404_for_every_method(web_server, shell_root, monkeypatch):
    client = _start_engine(
        web_server, monkeypatch, before_fallback=[('/only-post', _real_route, ['POST'], {'public': True})]
    )
    monkeypatch.setattr(web_server, 'is_public_route', lambda path: True)  # an authenticated caller
    for method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'PROPFIND'):
        assert client.request(method, '/nothing/here').status_code == 404, method
    # A real route's path with another method keeps the router's 405.
    for method in ('PUT', 'PROPFIND'):
        resp = client.request(method, '/only-post')
        assert resp.status_code == 405 and resp.headers['allow'] == 'POST', method
    assert client.post('/only-post').text == 'real route'


@pytest.mark.parametrize('method', ['TRACE', 'PROPFIND', 'MKCOL'])
def test_unknown_methods_404_off_pages_and_405_on_them(web_server, shell_root, monkeypatch, method):
    client = _start_engine(web_server, monkeypatch)  # anonymous: no route matches these paths
    assert client.request(method, '/nothing/here').status_code == 404
    for path in ('/', '/pricing'):
        resp = client.request(method, path)
        assert resp.status_code == 405 and resp.headers['allow'] == 'GET, HEAD', path


def test_pages_answer_405_to_methods_other_than_get_and_head(web_server, shell_root, monkeypatch):
    client = _start_engine(web_server, monkeypatch)
    for path in ('/', '/pricing'):  # '/' and a (legacy) page, both public
        for method in ('POST', 'DELETE', 'PUT'):
            resp = client.request(method, path)
            assert resp.status_code == 405 and resp.headers['allow'] == 'GET, HEAD', (method, path)
        assert client.get(path).status_code == 200


def test_head_on_a_page_is_its_get_without_the_body(web_server, shell_root, monkeypatch):
    # Link checkers, uptime monitors and unfurl prefetches send HEAD.
    client = _start_engine(web_server, monkeypatch)
    for path in ('/', '/pricing', '/store'):  # '/store' is unlisted: its X-Robots-Tag must survive
        for ua in (GOOGLEBOT, BROWSER):
            get = client.get(path, headers={'User-Agent': ua})
            head = client.head(path, headers={'User-Agent': ua})
            assert get.status_code == head.status_code == 200, (path, ua)
            assert head.content == b'', (path, ua)
            for name in ('content-type', 'content-length', 'cache-control', 'vary', 'x-robots-tag'):
                assert head.headers.get(name) == get.headers.get(name), (path, ua, name)


def test_head_on_an_unclaimed_path_is_still_a_404(web_server, shell_root, monkeypatch):
    client = _start_engine(web_server, monkeypatch)
    assert client.head('/nothing/here').status_code == 404


def test_router_outcomes_for_unclaimed_paths_are_preserved(web_server, shell_root, monkeypatch):
    client = _start_engine(
        web_server,
        monkeypatch,
        before_fallback=[
            ('/only-post', _real_route, ['POST'], {'public': True}),
            ('/only-get', _real_route, ['GET'], {'public': True}),
        ],
    )
    monkeypatch.setattr(web_server, 'is_public_route', lambda path: True)  # an authenticated caller
    resp = client.get('/only-post')
    assert resp.status_code == 405 and resp.headers['allow'] == 'POST'
    resp = client.get('/only-get/')
    assert resp.status_code == 307 and resp.headers['location'] == '/only-get'
    resp = client.get('/legal/')  # a page's trailing-slash twin: a permanent, relative 301
    assert resp.status_code == 301 and resp.headers['location'] == '/legal'
    resp = client.post('/legal/')  # other methods keep the method-preserving 307
    assert resp.status_code == 307 and resp.headers['location'] == '/legal'
    assert client.get('/nothing/here').status_code == 404


def test_a_slash_twin_redirect_is_never_protocol_relative(web_server, shell_root, monkeypatch):
    # A real route whose pattern ends in a slash serves '//evil.example/', the
    # twin of '//evil.example'. A relative Location of '//evil.example/' would
    # send the browser off-site, so no redirect is made.
    client = _start_engine(
        web_server, monkeypatch, before_fallback=[('/{rest:path}/', _real_route, ['GET'], {'public': True})]
    )
    monkeypatch.setattr(web_server, 'is_public_route', lambda path: True)
    resp = client.get('http://testserver//evil.example')
    assert resp.status_code == 404 and 'location' not in resp.headers
    resp = client.get('/fine')  # an ordinary twin still redirects
    assert resp.status_code == 307 and resp.headers['location'] == '/fine/'


def test_live_route_conflict_reads_the_route_table(web_server, shell_root, monkeypatch):
    _start_engine(web_server, monkeypatch, before_fallback=[('/thing/{x}', _real_route, ['GET'], {})])
    assert pages_mod.live_route_conflict('/status') == 'GET /status'
    assert pages_mod.live_route_conflict('/thing/abc') == 'GET /thing/{x}'
    assert pages_mod.live_route_conflict('/apps/x') is not None
    assert pages_mod.live_route_conflict('/pricing') is None  # the catch-all is the claim space
    assert pages_mod.live_route_conflict('/') is None  # '/' is the root page handler
    # initModule installed it for the gate and the aggregate builder.
    assert pp.live_conflict() is pages_mod.live_route_conflict


def test_boot_serves_the_legacy_list_filtered_against_the_route_table(web_server, shell_root, monkeypatch):
    # The store is down at boot, and a later module owns a legacy path as a
    # PRIVATE route: the legacy page must not open it to anonymous callers.
    from ai.modules.shell import initModule, register_public_pages

    async def failed_rebuild(acct=None):
        return False

    monkeypatch.setattr(pp.page_map, 'rebuild', failed_rebuild)
    initModule(web_server, {})
    web_server.add_route('/contact', _real_route, ['GET'])
    asyncio.run(register_public_pages(web_server))
    client = TestClient(web_server.app)
    assert client.get('/contact').status_code == 401
    assert '/contact' not in pp.current().exact and '/pricing' in pp.current().exact


# ---------------------------------------------------------------------------
# site.redirects: 301 to the page, query kept
# ---------------------------------------------------------------------------

REDIRECTS = {'/terms': '/legal/terms', '/master-saas-agreement/': '/legal/terms'}


@pytest.mark.parametrize('method', ['GET', 'HEAD'])
def test_redirect_sources_answer_301_to_the_page_keeping_the_query(web_server, shell_root, monkeypatch, method):
    client = _start_engine(web_server, monkeypatch)
    _use(Page('/', 'rocketride.home', 'H'), Page('/legal/terms', 'rocketride.home', 'T'), redirects=REDIRECTS)
    for source, query in (('/terms', ''), ('/master-saas-agreement/', '?utm_source=x&a=%20b')):
        for ua in (GOOGLEBOT, BROWSER):
            resp = client.request(method, source + query, headers={'User-Agent': ua})
            assert resp.status_code == 301, (source, ua)
            assert resp.headers['location'] == '/legal/terms' + query
            assert resp.headers['cache-control'] == 'public, max-age=86400'
            assert SHELL_BODY not in resp.text


def test_redirect_sources_refuse_other_methods_and_never_enumerate(web_server, shell_root, monkeypatch, app_url):
    client = _start_engine(web_server, monkeypatch)
    _use(Page('/', 'rocketride.home', 'H'), Page('/legal/terms', 'rocketride.home', 'T'), redirects=REDIRECTS)
    for method in ('POST', 'PROPFIND'):
        resp = client.request(method, '/terms')
        assert resp.status_code == 405 and resp.headers['allow'] == 'GET, HEAD', method
    for crawler_file in ('/sitemap.xml', '/llms.txt'):
        text = client.get(crawler_file).text
        assert f'{BASE}/legal/terms' in text
        assert f'{BASE}/terms' not in text and '/master-saas-agreement' not in text
    # The aggregate's redirects stop the moment it is swapped out.
    _use(Page('/', 'rocketride.home', 'H'), Page('/legal/terms', 'rocketride.home', 'T'))
    assert client.get('/terms').status_code == 404


# ---------------------------------------------------------------------------
# Missing /shell/static/* assets 404 (do not fall through to index.html)
# ---------------------------------------------------------------------------


def test_missing_shell_static_asset_404s(shell_root):
    """A missing /shell/static/* asset must 404, not the index.html SPA fallback.

    Behind the staging CloudFront the /shell/static/* behavior is edge-cached +
    immutable; a 200 index.html served under a .js/.css URL gets cached as
    HTML-under-a-JS-URL and poisons every viewer, breaking app boot. Regression
    guard: content-hashed asset misses must be a real 404.
    """
    r = _shell_client().get('/shell/static/js/does-not-exist.deadbeef.js')
    assert r.status_code == 404


def test_shell_navigation_route_still_serves_index(shell_root):
    """A non-static /shell/* route still gets the SPA index.html fallback."""
    r = _shell_client().get('/shell/some/client/route')
    assert r.status_code == 200
    assert '<title>shell</title>' in r.text


def test_existing_shell_static_asset_is_served(shell_root):
    """A present /shell/static/* bundle is still served as a file.

    Guards the ordering fix: the 404 check now runs before the serve step, so
    a check that rejected every /shell/static/* path would otherwise pass.
    """
    asset = shell_root / 'static' / 'js' / 'main.abc123.js'
    asset.parent.mkdir(parents=True)
    asset.write_text('console.log(1)')
    r = _shell_client().get('/shell/static/js/main.abc123.js')
    assert r.status_code == 200
    assert 'console.log(1)' in r.text


def test_shell_static_traversal_does_not_serve_index(shell_root):
    """A traversal-shaped /shell/static/* URL must 404, never index.html.

    Percent-encoded on purpose: httpx resolves a literal ``../`` before sending,
    so only ``%2e%2e`` reaches the handler decoded, as a real client's would.
    """
    r = _shell_client().get('/shell/static/js/%2e%2e/%2e%2e/%2e%2e/etc/passwd.js')
    assert r.status_code == 404
    assert '<title>shell</title>' not in r.text


@pytest.mark.parametrize(
    'url',
    [
        '/shell//static/js/missing.abc123.js',  # double slash
        '/shell/%2e/static/js/missing.abc123.js',  # dot segment
        '/shell/x/%2e%2e/static/js/missing.abc123.js',  # walks back into static/
    ],
)
def test_shell_static_other_spellings_do_not_serve_index(shell_root, url):
    """Every spelling that maps into static/ gets the 404, not just '/shell/static/'."""
    r = _shell_client().get(url)
    assert r.status_code == 404
    assert '<title>shell</title>' not in r.text


def test_shell_static_unbuilt_shell_is_503(tmp_path, monkeypatch):
    """With no shell build, an asset URL still gets the 503 that names the build command."""
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path / 'not-built'))
    r = _shell_client().get('/shell/static/js/main.abc123.js')
    assert r.status_code == 503
    assert 'shell:build' in r.text


def test_shell_static_partial_build_is_503(tmp_path, monkeypatch):
    """A shell dir with no index.html is an unfinished build: 503, not 404."""
    (tmp_path / 'static' / 'js').mkdir(parents=True)
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path))
    r = _shell_client().get('/shell/static/js/missing.abc123.js')
    assert r.status_code == 503
    assert 'shell:build' in r.text


def test_shell_static_asset_is_cached_immutable_but_index_is_not(shell_root):
    """Content-hashed static files may be cached for good; the SPA index must not."""
    asset = shell_root / 'static' / 'js' / 'main.abc123.js'
    asset.parent.mkdir(parents=True)
    asset.write_text('console.log(1)')
    r = _shell_client().get('/shell/static/js/main.abc123.js')
    assert r.status_code == 200
    assert r.headers['cache-control'] == 'public, max-age=31536000, immutable'
    index = _shell_client().get('/shell/some/client/route')
    assert index.status_code == 200
    assert 'immutable' not in index.headers.get('cache-control', '')


def _capture(shell_root, route: str, marker: str) -> None:
    """Ship a prerendered capture for ``route`` in the shell build ('' is '/')."""
    folder = shell_root / '_prerender' / route if route else shell_root / '_prerender'
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'index.html').write_text(f'<html><head><title>capture</title></head><body>{marker}</body></html>')


@pytest.mark.parametrize('ua', [GOOGLEBOT, BROWSER])
def test_prerender_capture_served_when_present(web_server, shell_root, monkeypatch, ua):
    """A page with a capture gets the capture under its head; '/' maps to _prerender/index.html."""
    _capture(shell_root, 'pricing', 'captured pricing')
    _capture(shell_root, '', 'captured home')
    client = _start_engine(web_server, monkeypatch)
    pricing = client.get('/pricing', headers={'User-Agent': ua}).text
    assert 'captured pricing' in pricing and SHELL_BODY not in pricing
    assert '<title>Pricing | RocketRide</title>' in pricing and '<title>capture</title>' not in pricing
    home = client.get('/', headers={'User-Agent': ua}).text
    assert 'captured home' in home and '<title>RocketRide</title>' in home


def test_no_capture_falls_back_to_spa(web_server, shell_root, monkeypatch):
    """No capture for the page: the SPA index, under the page's head."""
    _capture(shell_root, 'pricing', 'captured pricing')
    r = _start_engine(web_server, monkeypatch).get('/cloud')
    assert r.status_code == 200
    assert SHELL_BODY in r.text and '<title>Cloud | RocketRide</title>' in r.text


def test_an_unclaimed_root_still_gets_its_capture(web_server, shell_root, monkeypatch):
    _capture(shell_root, '', 'captured home')
    client = _start_engine(web_server, monkeypatch)
    _use(Page('/pricing', 'rocketride.home', 'Pricing'))
    r = client.get('/')
    assert r.status_code == 200 and 'captured home' in r.text and '<title>capture</title>' in r.text


def test_oauth_callback_on_root_gets_the_app_not_the_capture(web_server, shell_root, monkeypatch):
    """?code/?state on '/' must reach the SPA so PKCE can complete."""
    _capture(shell_root, '', 'captured home')
    r = _start_engine(web_server, monkeypatch).get('/?code=abc&state=xyz')
    assert SHELL_BODY in r.text and 'captured home' not in r.text


def test_any_query_string_gets_the_app_not_the_capture(web_server, shell_root, monkeypatch):
    """Invite and verification links carry a token the app must read."""
    _capture(shell_root, 'pricing', 'captured pricing')
    client = _start_engine(web_server, monkeypatch)
    assert SHELL_BODY in client.get('/pricing?token=abc').text
    assert 'captured pricing' in client.get('/pricing').text
