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
Atom feeds of dated pages (``site.feeds``), served by the public-page catch-all.

A feed lists the listed pages strictly under its ``prefix`` that declare
``published``, newest first (then by path), at most 50, with absolute URLs
from ``RR_APP_URL`` only (404 without it). Every page under the prefix, and
the prefix page itself, links to it from its head, for people and crawlers.
Manifest text stays text: the document is well-formed XML whatever a title,
description or author holds.
"""

from __future__ import annotations

import asyncio
import copy
import re
import xml.etree.ElementTree as ET

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai.modules.shell.public_pages as pp
import ai.modules.shell.shell as shell_mod
from ai.modules.shell.pages import FALLBACK_PATH, public_page
from ai.modules.shell.public_pages import Aggregate, Page, Published, build_aggregate

from .hostile_fixtures import hostile_account, install

GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'
APP_URL = 'https://cloud.example'
A = '{http://www.w3.org/2005/Atom}'
FEED = {'path': '/blog/feed.xml', 'prefix': '/blog/', 'title': 'RocketRide blog'}
LINK = f'<link rel="alternate" type="application/atom+xml" title="RocketRide blog" href="{APP_URL}/blog/feed.xml">'


def _post(path, title, published='', **fields):
    return {'path': path, 'title': title, 'published': published, **fields}


BLOG_HOME = {
    'id': 'rocketride.home',
    'name': 'RocketRide Cloud',
    'publicPages': [
        {'path': '/', 'title': 'RocketRide', 'description': 'Home.'},
        {'path': '/blog', 'title': 'Blog | RocketRide', 'description': 'News.'},
        _post(
            '/blog/launch',
            'Launch',
            '2026-11-09',
            description='We launched.',
            modified='2026-11-10T09:00:00Z',
            authors=[{'name': 'Ansh', 'url': 'https://rocketride.ai/team/ansh'}, {'name': 'Rod'}],
        ),
        _post('/blog/hello', 'Hello | RocketRide', '2026-10-01T08:00:00+02:00'),
        _post('/blog/draft', 'Draft', '2026-11-11', listed=False),
        _post('/blog/undated', 'Undated'),
        _post('/blogger', 'Blogger', '2026-11-12'),
        _post('/news/x', 'Elsewhere', '2026-11-12'),
    ],
    'site': {'title': 'RocketRide', 'feeds': [FEED]},
}


@pytest.fixture
def shell_root(tmp_path, monkeypatch):
    (tmp_path / 'index.html').write_text('<html><head><title>shell</title></head><body>SPA</body></html>')
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path))
    return tmp_path


def _client():
    app = FastAPI()
    app.add_api_route('/', public_page, methods=['GET', 'HEAD'])
    app.add_api_route(FALLBACK_PATH, public_page, methods=['GET', 'HEAD', 'POST'])
    return TestClient(app)


def _publish(monkeypatch, home=BLOG_HOME):
    install(monkeypatch, hostile_account(home=home))
    assert asyncio.run(pp.rebuild())


@pytest.fixture
def blog(monkeypatch, shell_root):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    _publish(monkeypatch)
    return _client()


def _feed(client, path='/blog/feed.xml'):
    resp = client.get(path)
    assert resp.status_code == 200, resp.text
    return ET.fromstring(resp.content)


def _entries(feed):
    return [entry.findtext(f'{A}id') for entry in feed.findall(f'{A}entry')]


def test_feed_lists_only_dated_listed_pages_under_prefix(blog):
    resp = blog.get('/blog/feed.xml')
    assert resp.headers['content-type'] == 'application/atom+xml; charset=utf-8'
    assert resp.headers['cache-control'] == 'public, max-age=3600'
    # Not the prefix page, an undated or unlisted page, or a page beside the prefix.
    assert _entries(_feed(blog)) == [f'{APP_URL}/blog/launch', f'{APP_URL}/blog/hello']


def test_feed_document_carries_every_atom_field(blog):
    feed = _feed(blog)
    assert feed.tag == f'{A}feed'
    assert feed.findtext(f'{A}id') == f'{APP_URL}/blog/feed.xml'
    assert feed.findtext(f'{A}title') == 'RocketRide blog'
    # The newest change among the entries.
    assert feed.findtext(f'{A}updated') == '2026-11-10T09:00:00Z'
    links = {link.get('rel'): (link.get('type'), link.get('href')) for link in feed.findall(f'{A}link')}
    assert links == {
        'self': ('application/atom+xml', f'{APP_URL}/blog/feed.xml'),
        'alternate': ('text/html', f'{APP_URL}/blog'),
    }
    # Entries without authors are the site's.
    assert [a.findtext(f'{A}name') for a in feed.findall(f'{A}author')] == ['RocketRide']
    launch, hello = feed.findall(f'{A}entry')
    assert launch.findtext(f'{A}title') == 'Launch'
    assert launch.find(f'{A}link').attrib == {'rel': 'alternate', 'type': 'text/html', 'href': f'{APP_URL}/blog/launch'}
    assert launch.findtext(f'{A}published') == '2026-11-09T00:00:00Z'
    assert launch.findtext(f'{A}updated') == '2026-11-10T09:00:00Z'
    assert launch.findtext(f'{A}summary') == 'We launched.'
    authors = [(a.findtext(f'{A}name'), a.findtext(f'{A}uri')) for a in launch.findall(f'{A}author')]
    assert authors == [('Ansh', 'https://rocketride.ai/team/ansh'), ('Rod', None)]
    # An entry is titled by the page's own title, without the site's suffix.
    assert hello.findtext(f'{A}title') == 'Hello'
    assert hello.findtext(f'{A}published') == hello.findtext(f'{A}updated') == '2026-10-01T08:00:00+02:00'
    assert hello.find(f'{A}summary') is None and hello.find(f'{A}author') is None


def test_entries_are_newest_first_then_by_path_and_at_most_fifty(shell_root, monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    posts = [
        Page(f'/blog/p{i:02d}', 'rocketride.home', f'P{i}', published=f'2026-01-{i % 28 + 1:02d}') for i in range(60)
    ]
    # One instant written two ways, and a later one on an earlier calendar day.
    posts += [
        Page('/blog/z', 'rocketride.home', 'Z', published='2026-02-01T00:00:00Z'),
        Page('/blog/y', 'rocketride.home', 'Y', published='2026-02-01'),
        Page('/blog/x', 'rocketride.home', 'X', published='2026-02-01T23:00:00-05:00'),
    ]
    pp.swap(Aggregate(exact={p.path: p for p in posts}, feeds={FEED['path']: FEED}))
    ids = [i[len(APP_URL) :] for i in _entries(_feed(_client()))]
    assert len(ids) == 50
    assert ids[:3] == ['/blog/x', '/blog/y', '/blog/z']
    assert ids[3:6] == ['/blog/p27', '/blog/p55', '/blog/p26']


def test_a_feed_is_as_new_as_its_latest_change(shell_root, monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    posts = [
        Page('/blog/new', 'rocketride.home', 'New', published='2026-11-09'),
        Page('/blog/old', 'rocketride.home', 'Old', published='2026-10-01', modified='2026-12-01T10:00:00+01:00'),
    ]
    pp.swap(Aggregate(exact={p.path: p for p in posts}, feeds={FEED['path']: FEED}))
    feed = _feed(_client())
    assert _entries(feed) == [f'{APP_URL}/blog/new', f'{APP_URL}/blog/old']
    assert feed.findtext(f'{A}updated') == '2026-12-01T10:00:00+01:00'


def test_a_feed_of_every_page_leaves_out_the_home_page(shell_root, monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    everything = {'path': '/feed.xml', 'prefix': '/', 'title': 'All'}
    posts = [
        Page('/', 'rocketride.home', 'Home', published='2026-11-10'),
        Page('/blog/a', 'rocketride.home', 'A', published='2026-11-09'),
        Page('/news', 'rocketride.home', 'News', published='2026-11-08'),
    ]
    pp.swap(Aggregate(exact={p.path: p for p in posts}, feeds={'/feed.xml': everything}))
    feed = _feed(_client(), '/feed.xml')
    assert _entries(feed) == [f'{APP_URL}/blog/a', f'{APP_URL}/news']
    links = {link.get('rel'): link.get('href') for link in feed.findall(f'{A}link')}
    assert links == {'self': f'{APP_URL}/feed.xml', 'alternate': f'{APP_URL}/'}
    # Every page links to it, the home page included.
    for path in ('/', '/blog/a', '/news'):
        assert 'href="https://cloud.example/feed.xml"' in _client().get(path).text, path


def test_a_feed_without_entries_is_as_new_as_the_aggregate(shell_root, monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    pp.swap(
        Aggregate(
            exact={'/blog': Page('/blog', 'rocketride.home', 'Blog')},
            feeds={FEED['path']: FEED},
            built_at=1_700_000_100.5,
        )
    )
    feed = _feed(_client())
    assert _entries(feed) == [] and feed.findtext(f'{A}updated') == '2023-11-14T22:15:00Z'


def test_hostile_strings_keep_feed_well_formed(shell_root, monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    hostile = '</script><script>alert(1)</script> ]]> <!-- & "q" \'a\' <![CDATA[x]]> &amp; \x00\x1b\ufffe end'
    # Characters XML 1.0 cannot carry (C0 controls, U+FFFE) are dropped.
    clean = re.sub('[\x00\x1b\ufffe]', '', hostile)
    home = copy.deepcopy(BLOG_HOME)
    home['site'].update(title=hostile, feeds=[{**FEED, 'title': hostile}])
    home['publicPages'][2].update(title=hostile, description=hostile, authors=[{'name': hostile}])
    _publish(monkeypatch, home=home)
    resp = _client().get('/blog/feed.xml')
    assert b'<script>' not in resp.content and b'<!--' not in resp.content
    feed = ET.fromstring(resp.content)
    assert feed.findtext(f'{A}title') == clean
    assert feed.find(f'{A}author').findtext(f'{A}name') == clean
    launch = feed.find(f'{A}entry')
    assert launch.findtext(f'{A}title') == launch.findtext(f'{A}summary') == clean
    assert launch.find(f'{A}author').findtext(f'{A}name') == clean
    assert len(feed.findall(f'{A}entry')) == 2


def test_a_lone_surrogate_that_reaches_the_aggregate_is_dropped_from_the_feed(shell_root, monkeypatch):
    # The validator refuses lone surrogates; the feed drops them anyway, as it
    # does every character XML 1.0 cannot carry.
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    odd = 'A \ud83d B \udc00 \x01 C \uffff'
    post = Page('/blog/a', 'rocketride.home', odd, odd, published='2026-11-09', authors=((odd, ''),))
    pp.swap(Aggregate(exact={post.path: post}, site={'title': odd}, feeds={FEED['path']: {**FEED, 'title': odd}}))
    resp = _client().get('/blog/feed.xml')
    assert resp.status_code == 200
    feed = ET.fromstring(resp.content)
    entry = feed.find(f'{A}entry')
    texts = [
        feed.findtext(f'{A}title'),
        feed.find(f'{A}author').findtext(f'{A}name'),
        entry.findtext(f'{A}title'),
        entry.findtext(f'{A}summary'),
        entry.find(f'{A}author').findtext(f'{A}name'),
    ]
    assert texts == ['A  B   C '] * 5


def test_a_feed_titled_with_a_lone_surrogate_is_refused_and_pages_still_serve(shell_root, monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    home = copy.deepcopy(BLOG_HOME)
    home['site']['feeds'] = [{**FEED, 'title': 'Blog \ud83d'}]
    _publish(monkeypatch, home=home)
    client = _client()
    assert pp.current().feeds == {} and client.get('/blog/feed.xml').status_code == 404
    for path in ('/blog', '/blog/launch'):
        for ua in (GOOGLEBOT, BROWSER):
            resp = client.get(path, headers={'User-Agent': ua})
            assert resp.status_code == 200 and 'application/atom+xml' not in resp.text, (path, ua)


def test_feed_404_without_rr_app_url(shell_root, monkeypatch):
    monkeypatch.delenv('RR_APP_URL', raising=False)
    _publish(monkeypatch)
    assert _client().get('/blog/feed.xml').status_code == 404


def test_feed_answers_head_like_get_and_refuses_other_methods(blog):
    get, head = blog.get('/blog/feed.xml'), blog.head('/blog/feed.xml')
    assert head.status_code == 200 and head.content == b''
    for name in ('content-type', 'content-length', 'cache-control'):
        assert head.headers[name] == get.headers[name], name
    resp = blog.post('/blog/feed.xml')
    assert resp.status_code == 405 and resp.headers['allow'] == 'GET, HEAD'


@pytest.mark.parametrize('ua', [GOOGLEBOT, BROWSER])
def test_the_prefix_page_and_every_page_under_it_link_to_the_feed(blog, ua):
    for path in ('/blog', '/blog/launch', '/blog/undated', '/blog/draft'):
        text = blog.get(path, headers={'User-Agent': ua}).text
        head = text[: text.index('</head>')]
        assert head.count(LINK) == 1, path
    for path in ('/', '/blogger', '/news/x'):
        assert 'application/atom+xml' not in blog.get(path, headers={'User-Agent': ua}).text, path


def test_without_rr_app_url_no_page_links_to_a_feed(shell_root, monkeypatch):
    monkeypatch.delenv('RR_APP_URL', raising=False)
    _publish(monkeypatch)
    assert 'application/atom+xml' not in _client().get('/blog/launch', headers={'User-Agent': GOOGLEBOT}).text


def test_a_hostile_feed_title_stays_escaped_in_the_head(shell_root, monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    home = copy.deepcopy(BLOG_HOME)
    home['site']['feeds'] = [{**FEED, 'title': '"><script>alert(1)</script>'}]
    _publish(monkeypatch, home=home)
    text = _client().get('/blog', headers={'User-Agent': BROWSER}).text
    assert '<script>alert' not in text
    assert 'title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"' in text


def test_a_feed_path_another_app_serves_is_dropped_at_build(monkeypatch):
    monkeypatch.setenv('RR_PUBLIC_ROOT_APPS', 'rocketride.home,rocketride.other')
    feeds = [{**FEED, 'path': '/taken.xml'}, FEED]
    home = Published(
        'rocketride.home', {'publicPages': [{'path': '/', 'title': 'H'}], 'site': {'feeds': feeds}}, published_at=2
    )
    # Published earlier, so its page wins the path.
    other = Published('rocketride.other', {'publicPages': [{'path': '/taken.xml', 'title': 'T'}]}, published_at=1)
    agg = build_aggregate([home, other])
    assert agg.exact['/taken.xml'].app_id == 'rocketride.other'
    assert agg.feeds == {FEED['path']: FEED} and 'feeds' not in agg.site


def test_the_build_time_never_makes_two_aggregates_differ():
    one = Aggregate(exact={}, built_at=1.0)
    assert one == Aggregate(exact={}, built_at=2.0) and one != Aggregate(exact={}, feeds={FEED['path']: FEED})


def test_the_feed_answers_anonymous_callers_through_the_real_server(shell_root, monkeypatch):
    server_mod = pytest.importorskip('ai.web.server', reason='requires engine-native module stubs')
    from ai.modules.shell import initModule, register_public_pages

    async def no_rebuild(acct=None):
        return True

    monkeypatch.setenv('RR_APP_URL', APP_URL)
    monkeypatch.setattr(pp.page_map, 'rebuild', no_rebuild)
    server = server_mod.WebServer(config={'port': 0, 'host': '127.0.0.1'})
    initModule(server, {})
    asyncio.run(register_public_pages(server))
    pp.swap(
        Aggregate(
            exact={'/blog/a': Page('/blog/a', 'rocketride.home', 'A', published='2026-11-09')},
            feeds={FEED['path']: FEED},
        )
    )
    client = TestClient(server.app, follow_redirects=False)
    resp = client.get('/blog/feed.xml')
    assert resp.status_code == 200 and resp.headers['content-type'] == 'application/atom+xml; charset=utf-8'
    assert _entries(ET.fromstring(resp.content)) == [f'{APP_URL}/blog/a']
    assert client.head('/blog/feed.xml').status_code == 200
    assert client.get('/blog/feed.xml/').status_code == 404
