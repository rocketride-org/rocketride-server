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
The leak test: no unpublished, private, org-scoped, unlisted, unapproved,
unbuilt, permission-gated or pre-release app may ever appear in sitemap.xml,
llms.txt or a served page.

The hostile fixture set (``hostile_fixtures.py``) runs through the real
loaders, store walk, gate filters, aggregate build and HTTP handlers; only
storage is faked. Every hostile platform app is made a root claimant, so only
visibility keeps it out.
"""

from __future__ import annotations

import asyncio
import re
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai.modules.shell.pages as pages
import ai.modules.shell.public_pages as pp
import ai.modules.shell.shell as shell_mod
from ai.modules.shell.crawlers import CRAWLERS
from ai.modules.shell.pages import FALLBACK_PATH, is_public_path, public_page
from ai.modules.shell.shell import llms_txt, robots_txt, sitemap_xml

from .hostile_fixtures import LEAK_MARKERS, assert_no_leak, hostile_account, install

BASE = 'https://rocketride.example'
GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
BROWSER = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'
UAS = [GOOGLEBOT, BROWSER] + [f'Mozilla/5.0 (compatible; {token}/1.0)' for token, _ in CRAWLERS]


@pytest.fixture
def world(monkeypatch, tmp_path):
    """The hostile platform, built and served exactly as production would."""
    monkeypatch.setenv(
        'RR_PUBLIC_ROOT_APPS',
        'rocketride.home,rocketride.secret,rocketride.review,rocketride.building,rocketride.gated,'
        'rocketride.preview,evil.squatter',
    )
    monkeypatch.setenv('RR_APP_URL', BASE)
    acct = install(monkeypatch, hostile_account())
    (tmp_path / 'index.html').write_text('<html><head><title>shell</title></head><body>SPA</body></html>')
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path))
    assert asyncio.run(pp.rebuild())
    app = FastAPI()
    app.get('/')(public_page)
    app.get('/sitemap.xml')(sitemap_xml)
    app.get('/robots.txt')(robots_txt)
    app.get('/llms.txt')(llms_txt)
    app.get(FALLBACK_PATH)(public_page)
    return acct, TestClient(app)


def _locs(sitemap: str):
    return [m[len(BASE) :] for m in re.findall(r'<loc>(.*?)</loc>', sitemap)]


def test_nothing_hidden_reaches_any_crawler_surface(world):
    _, client = world
    sitemap = client.get('/sitemap.xml').text
    llms = client.get('/llms.txt').text
    robots = client.get('/robots.txt').text
    for text in (sitemap, llms, robots):
        assert_no_leak(text)
    urls = _locs(sitemap)
    assert urls == ['/', '/marketplace', '/pricing']
    # Every advertised URL serves, and leaks nothing, to every UA class.
    for url in urls + ['/store']:
        for ua in UAS:
            resp = client.get(url, headers={'User-Agent': ua})
            assert resp.status_code == 200, (url, ua)
            assert_no_leak(resp.text)
            assert_no_leak(str(resp.headers))


def test_hidden_platform_pages_are_not_served(world, monkeypatch):
    _, client = world
    monkeypatch.setattr(pages, '_web_server', SimpleNamespace(app=client.app))
    for marker in LEAK_MARKERS:
        if marker.islower():
            for path in (f'/{marker}', f'/{marker}-hidden'):
                assert path not in pp.current().exact
                # Public, so an anonymous caller gets the catch-all's 404, never a page or a 401.
                assert is_public_path(path)
                for ua in (GOOGLEBOT, BROWSER):
                    resp = client.get(path, headers={'User-Agent': ua})
                    assert resp.status_code == 404, (path, ua)
                    assert_no_leak(resp.text)


def test_squatter_never_owns_root_or_site(world):
    _, client = world
    root = client.get('/', headers={'User-Agent': GOOGLEBOT}).text
    assert '<title>RocketRide</title>' in root and 'SPA' in root
    assert client.get('/llms.txt').text.startswith('# RocketRide\n\n> The blurb.')


def test_an_unpublished_root_app_stops_serving_its_pages_after_the_rebuild(world):
    acct, client = world
    assert '<meta name="description" content="Plans and prices.">' in client.get('/pricing').text
    for row in acct.rows:
        if row['appId'] == 'rocketride.home':
            row['state'] = 'disabled'
    assert asyncio.run(pp.rebuild())
    # No visible platform manifest is left: the legacy page list serves.
    assert pp.current().legacy
    assert 'Plans and prices.' not in client.get('/pricing').text
    llms = client.get('/llms.txt').text
    assert 'The blurb.' not in llms
    assert_no_leak(llms)
