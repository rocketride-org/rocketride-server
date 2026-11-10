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
``site.notFound``: the root owner's branded 404 for paths nothing serves.

With it declared, a GET or HEAD on a path that is neither a page, a feed, a
redirect nor a server route (and is outside the reserved prefixes) answers
404 with a head titled ``Page not found | <site.title>``, noindex and no
canonical URL. Crawlers get the snapshot, rendered like a page's (``{{assets}}``
resolves to the root owner's production version); people get the shell's
``index.html``, so the app renders its own 404. The body does not depend on
the path, so the server renders it once per UA class and page map; a fallback
on a storage error is retried, and warned about, at most once a minute.
Without ``site.notFound`` the 404 is unchanged.
"""

from __future__ import annotations

import asyncio
import copy
import re
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai.modules.shell.pages as pages
import ai.modules.shell.public_pages as pp
import ai.modules.shell.shell as shell_mod
from ai.modules.shell.contract import MAX_SNAPSHOT_BYTES
from ai.modules.shell.pages import FALLBACK_PATH, public_page

from .hostile_fixtures import FILES, HOME_MANIFEST, dist_of, hostile_account, install

GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'
APP_URL = 'https://cloud.example'
SHELL_BODY = '<div id="root">shell</div>'
DIST = dist_of('00000000-platform', 'rocketride.home', 3)
NOT_FOUND = (
    '<!doctype html><html><head><title>404</title><meta name="description" content="own">'
    '<link rel="canonical" href="https://cloud.example/404"></head>'
    '<body><h1>Lost in space</h1><img src="{{assets}}/seo-assets/logo.svg" alt=""></body></html>'
)


@pytest.fixture
def shell_root(tmp_path, monkeypatch):
    (tmp_path / 'index.html').write_text(f'<html><head><title>shell</title></head><body>{SHELL_BODY}</body></html>')
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path))
    return tmp_path


@pytest.fixture
def warned(monkeypatch):
    lines = []
    monkeypatch.setattr(pages, 'warning', lines.append)
    return lines


def _serve(monkeypatch, *, not_found='pages/404.html', site_title='RocketRide', seed=True):
    """Publish the home app at v3 with ``site.notFound`` (absent when None) through the real loader."""
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    home = copy.deepcopy(HOME_MANIFEST)
    if not_found is not None:
        home['site']['notFound'] = not_found
    if site_title is None:
        del home['site']['title']
    else:
        home['site']['title'] = site_title
    install(monkeypatch, hostile_account(home=home, home_version=3))
    assert asyncio.run(pp.rebuild())
    if seed:
        FILES[f'{DIST}/pages/404.html'] = NOT_FOUND.encode()
    app = FastAPI()
    app.add_api_route('/', public_page, methods=['GET', 'HEAD'])
    app.add_api_route(FALLBACK_PATH, public_page, methods=['GET', 'HEAD', 'POST'])
    return TestClient(app, follow_redirects=False)


def _assert_branded(resp):
    assert resp.status_code == 404
    assert resp.headers['content-type'].startswith('text/html')
    assert resp.headers['cache-control'] == 'private, no-cache'
    assert resp.headers['x-robots-tag'] == 'noindex'
    assert resp.headers['vary'] == 'User-Agent'


def _head_of(text):
    return text[: text.index('</head>')]


def _counted(monkeypatch, owner, name):
    """Replace ``owner.<name>`` with a wrapper that logs each call; returns the log."""
    calls = []
    real = getattr(owner, name)

    def wrapper(*args, **kwargs):
        calls.append(args)
        return real(*args, **kwargs)

    monkeypatch.setattr(owner, name, wrapper)
    return calls


@pytest.fixture
def clock(monkeypatch):
    """The monotonic clock ``pages`` reads, moved by hand."""
    now = [1000.0]
    monkeypatch.setattr(pages, 'time', SimpleNamespace(monotonic=lambda: now[0]))
    return now


def test_a_crawler_gets_the_not_found_snapshot_with_status_404(monkeypatch, shell_root):
    resp = _serve(monkeypatch).get('/nope', headers={'User-Agent': GOOGLEBOT})
    _assert_branded(resp)
    assert '<h1>Lost in space</h1>' in resp.text and SHELL_BODY not in resp.text
    assert '<img src="/apps/rocketride.home/v3/seo-assets/logo.svg"' in resp.text
    head = _head_of(resp.text)
    assert re.findall(r'<title>(.*?)</title>', head) == ['Page not found | RocketRide']
    assert '<meta name="robots" content="noindex">' in head
    assert 'canonical' not in head and 'og:url' not in head and 'name="description"' not in head


def test_a_person_gets_the_shell_index_with_status_404(monkeypatch, shell_root):
    # A stale prerendered capture for the path is not served: the app renders its 404.
    capture = shell_root / '_prerender' / 'nope'
    capture.mkdir(parents=True)
    (capture / 'index.html').write_text('<html><head></head><body>captured</body></html>')
    resp = _serve(monkeypatch).get('/nope', headers={'User-Agent': BROWSER})
    _assert_branded(resp)
    assert SHELL_BODY in resp.text and 'Lost in space' not in resp.text and 'captured' not in resp.text
    head = _head_of(resp.text)
    assert '<title>Page not found | RocketRide</title>' in head and '<meta name="robots" content="noindex">' in head


@pytest.mark.parametrize('ua', [GOOGLEBOT, BROWSER])
def test_head_answers_like_get(monkeypatch, shell_root, ua):
    resp = _serve(monkeypatch).head('/nope', headers={'User-Agent': ua})
    _assert_branded(resp)
    assert resp.content == b''


def test_every_unserved_path_gets_it_except_reserved_ones_and_other_methods(monkeypatch, shell_root):
    client = _serve(monkeypatch)
    for path in ('/pricing/extra', '/nope/', '/Pricing', '/a/b/c'):
        resp = client.get(path, headers={'User-Agent': GOOGLEBOT})
        _assert_branded(resp)
        assert 'Lost in space' in resp.text, path
    # A page's slash twin and a redirect source are unchanged.
    assert client.get('/pricing/').headers['location'] == '/pricing'
    assert client.get('/plans').headers['location'] == '/pricing'
    # API-shaped paths and discovery probes (OAuth, MCP) keep the plain 404, and so
    # does any method but GET and HEAD.
    for path in ('/api/nope', '/task/x', '/mcp/x', '/.well-known', '/.well-known/oauth-authorization-server'):
        resp = client.get(path, headers={'User-Agent': GOOGLEBOT})
        assert resp.status_code == 404 and resp.json() == {'detail': 'Not Found'}, path
    resp = client.post('/nope', headers={'User-Agent': GOOGLEBOT})
    assert resp.status_code == 404 and resp.json() == {'detail': 'Not Found'}


def test_behind_a_root_path_it_decides_on_the_path_the_router_matched(monkeypatch, shell_root):
    client = TestClient(_serve(monkeypatch).app, follow_redirects=False, root_path='/api')
    _assert_branded(client.get('/api/nope', headers={'User-Agent': GOOGLEBOT}))
    resp = client.get('/api/api/x', headers={'User-Agent': GOOGLEBOT})
    assert resp.status_code == 404 and resp.json() == {'detail': 'Not Found'}


@pytest.mark.parametrize('ua', [GOOGLEBOT, BROWSER])
def test_a_second_miss_neither_rereads_nor_rerenders(monkeypatch, shell_root, ua):
    client = _serve(monkeypatch)
    documents = _counted(monkeypatch, pages.Path, 'read_text')
    snapshots = _counted(monkeypatch, pp, 'read_artifact_file')
    renders = _counted(monkeypatch, pages, 'inject_head')
    first = client.get('/nope', headers={'User-Agent': ua})
    # Another path, the same body: scanners probing random paths cost one render.
    second = client.get('/wp-admin/setup.php', headers={'User-Agent': ua})
    _assert_branded(second)
    assert second.text == first.text and len(renders) == 1
    # One read in all: the snapshot for a crawler, index.html for a person.
    assert len(documents) + len(snapshots) == 1


def test_one_cached_response_per_ua_class_dropped_on_a_swap(monkeypatch, shell_root):
    client = _serve(monkeypatch)
    for path, ua in (('/nope', GOOGLEBOT), ('/a/b', GOOGLEBOT), ('/nope', BROWSER), ('/.env', BROWSER)):
        _assert_branded(client.get(path, headers={'User-Agent': ua}))
    assert sorted(key[:2] for key in pages._render_cache.keys()) == [('site.notFound', False), ('site.notFound', True)]
    # A page served afterwards is cached beside them, as before.
    client.get('/pricing', headers={'User-Agent': GOOGLEBOT})
    assert len(pages._render_cache) == 3
    # A new page map drops them with the pages.
    _serve(monkeypatch, site_title='RocketRide Cloud')
    assert len(pages._render_cache) == 0
    text = client.get('/nope', headers={'User-Agent': GOOGLEBOT}).text
    assert '<title>Page not found | RocketRide Cloud</title>' in text


def test_without_not_found_the_404_is_unchanged(monkeypatch, shell_root):
    client = _serve(monkeypatch, not_found=None)
    for ua in (GOOGLEBOT, BROWSER):
        resp = client.get('/nope', headers={'User-Agent': ua})
        assert resp.status_code == 404 and resp.json() == {'detail': 'Not Found'}


def test_an_unreadable_snapshot_is_retried_at_most_once_a_minute(monkeypatch, shell_root, warned, clock):
    # A seeded row never passes the publish gate, so the file may be missing.
    client = _serve(monkeypatch, seed=False)
    for path in ('/nope', '/other'):
        resp = client.get(path, headers={'User-Agent': GOOGLEBOT})
        _assert_branded(resp)
        assert SHELL_BODY in resp.text and '<title>Page not found | RocketRide</title>' in resp.text
    assert len(warned) == 1 and warned[0].startswith("[public_pages] site.notFound: snapshot 'pages/404.html'")
    # Once the file is there, the first miss after the retry interval serves it.
    FILES[f'{DIST}/pages/404.html'] = NOT_FOUND.encode()
    clock[0] += pages._NOT_FOUND_RETRY_SECONDS - 1
    assert 'Lost in space' not in client.get('/nope', headers={'User-Agent': GOOGLEBOT}).text
    clock[0] += 1
    assert 'Lost in space' in client.get('/nope', headers={'User-Agent': GOOGLEBOT}).text
    assert len(warned) == 1


def test_an_oversized_snapshot_is_warned_about_once_per_version(monkeypatch, shell_root, warned, clock):
    client = _serve(monkeypatch, seed=False)
    FILES[f'{DIST}/pages/404.html'] = b'x' * (MAX_SNAPSHOT_BYTES + 1)
    stats = _counted(monkeypatch, pp, 'artifact_file_info')
    for path in ('/nope', '/other'):
        resp = client.get(path, headers={'User-Agent': GOOGLEBOT})
        _assert_branded(resp)
        assert SHELL_BODY in resp.text
    clock[0] += pages._NOT_FOUND_RETRY_SECONDS
    client.get('/nope', headers={'User-Agent': GOOGLEBOT})
    # A new page map on the same version: still never read, nor warned about again.
    _serve(monkeypatch, site_title='RocketRide Cloud', seed=False)
    assert SHELL_BODY in client.get('/nope', headers={'User-Agent': GOOGLEBOT}).text
    assert len(stats) == 1 and len(warned) == 1 and 'over the' in warned[0]


def test_the_title_is_escaped_and_falls_back_without_a_site_title(monkeypatch, shell_root):
    hostile = '</title><script>alert(1)</script>'
    text = _serve(monkeypatch, site_title=hostile).get('/nope', headers={'User-Agent': GOOGLEBOT}).text
    assert '<script>alert' not in text
    assert '<title>Page not found | &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>' in text
    text = _serve(monkeypatch, site_title=None).get('/nope', headers={'User-Agent': GOOGLEBOT}).text
    assert re.findall(r'<title>(.*?)</title>', _head_of(text)) == ['Page not found']
