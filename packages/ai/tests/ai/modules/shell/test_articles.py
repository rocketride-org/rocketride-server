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
Article metadata on public pages: link-preview tags for everyone, BlogPosting
JSON-LD for crawlers.

A page's ``image`` (else ``site.image``) becomes ``og:image`` and picks the
large Twitter card; ``site.title`` is ``og:site_name``; a page with
``published`` is an ``article`` with its publication and modification times.
People and crawlers get the same tags, since some preview fetchers look like
browsers. An image is an https URL as declared, a root path on ``RR_APP_URL``,
or a path inside the declaring app's build output, served from its production
version. Crawlers also get a BlogPosting for each dated page, published by
the site's organization.
"""

from __future__ import annotations

import asyncio
import copy
import json
import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai.modules.shell.public_pages as pp
import ai.modules.shell.shell as shell_mod
from ai.modules.shell.articles import blogposting
from ai.modules.shell.pages import FALLBACK_PATH, public_page
from ai.modules.shell.public_pages import Aggregate, Page

from .hostile_fixtures import hostile_account, install

GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'
APP_URL = 'https://cloud.example'

# home-ui with a blog: an index, a post with every article field, a post with
# a root-path image and no authors, and a site image inside the build output.
BLOG_HOME = {
    'id': 'rocketride.home',
    'name': 'RocketRide Cloud',
    'publicPages': [
        {'path': '/', 'title': 'RocketRide', 'description': 'Home.'},
        {'path': '/blog', 'title': 'Blog | RocketRide', 'description': 'News.'},
        {
            'path': '/blog/launch',
            'title': 'Launch | RocketRide',
            'description': 'We launched.',
            'image': 'blog/launch.png',
            'published': '2026-11-09',
            'modified': '2026-11-10T09:00:00Z',
            'authors': [{'name': 'Ansh', 'url': 'https://rocketride.ai/team/ansh'}, {'name': 'Rod'}],
        },
        {
            'path': '/blog/hello',
            'title': 'Hello | RocketRide',
            'description': 'First post.',
            'image': '/apps/rocketride.home/seo-assets/hello.png',
            'published': '2026-10-01T08:00:00+02:00',
        },
    ],
    'site': {'title': 'RocketRide', 'image': 'og/site.png'},
}


@pytest.fixture
def shell_root(tmp_path, monkeypatch):
    (tmp_path / 'index.html').write_text('<html><head><title>shell</title></head><body>SPA</body></html>')
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path))
    return tmp_path


def _client():
    app = FastAPI()
    app.add_api_route('/', public_page, methods=['GET', 'HEAD'])
    app.add_api_route(FALLBACK_PATH, public_page, methods=['GET', 'HEAD'])
    return TestClient(app)


def _publish(monkeypatch, home=BLOG_HOME, version=3):
    """Publish ``home`` at ``version`` through the real loader and aggregate build."""
    install(monkeypatch, hostile_account(home=home, home_version=version))
    assert asyncio.run(pp.rebuild())


@pytest.fixture
def blog(monkeypatch, shell_root):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    _publish(monkeypatch)
    return _client()


_META = re.compile(r'<meta (?:property|name)="((?:og|twitter|article):[a-z_:]+)" content="([^"]*)">')


def _meta(text: str) -> dict:
    """The head's og/twitter/article meta tags as {key: [content, ...]}."""
    out: dict = {}
    for key, content in _META.findall(text):
        out.setdefault(key, []).append(content)
    return out


@pytest.mark.parametrize('ua', [GOOGLEBOT, BROWSER])
def test_article_metadata_reaches_people_and_crawlers(blog, ua):
    meta = _meta(blog.get('/blog/launch', headers={'User-Agent': ua}).text)
    assert meta == {
        'og:title': ['Launch | RocketRide'],
        'og:description': ['We launched.'],
        'og:url': [f'{APP_URL}/blog/launch'],
        'og:type': ['article'],
        'og:site_name': ['RocketRide'],
        'og:image': [f'{APP_URL}/apps/rocketride.home/v3/blog/launch.png'],
        'twitter:card': ['summary_large_image'],
        'article:published_time': ['2026-11-09'],
        'article:modified_time': ['2026-11-10T09:00:00Z'],
    }


def test_image_root_path_made_absolute(blog):
    for ua in (GOOGLEBOT, BROWSER):
        meta = _meta(blog.get('/blog/hello', headers={'User-Agent': ua}).text)
        assert meta['og:image'] == [f'{APP_URL}/apps/rocketride.home/seo-assets/hello.png']
        # Never modified: the modification time is the publication time.
        assert meta['article:published_time'] == meta['article:modified_time'] == ['2026-10-01T08:00:00+02:00']


def test_undated_pages_are_websites_with_the_site_image(blog):
    for path in ('/', '/blog'):
        meta = _meta(blog.get(path, headers={'User-Agent': GOOGLEBOT}).text)
        assert meta['og:type'] == ['website'] and meta['og:site_name'] == ['RocketRide']
        # A relative site image lives in the root owner's production build output.
        assert meta['og:image'] == [f'{APP_URL}/apps/rocketride.home/v3/og/site.png']
        assert meta['twitter:card'] == ['summary_large_image']
        assert not any(key.startswith('article:') for key in meta), path


def test_relative_images_follow_the_production_version(blog, monkeypatch):
    _publish(monkeypatch, version=4)
    text = blog.get('/blog/launch', headers={'User-Agent': GOOGLEBOT}).text
    assert _meta(text)['og:image'] == [f'{APP_URL}/apps/rocketride.home/v4/blog/launch.png']
    assert _meta(blog.get('/', headers={'User-Agent': BROWSER}).text)['og:image'] == [
        f'{APP_URL}/apps/rocketride.home/v4/og/site.png'
    ]


def test_https_images_are_kept_as_declared(blog, monkeypatch):
    home = copy.deepcopy(BLOG_HOME)
    home['publicPages'][2]['image'] = 'https://cdn.example/launch.png?w=1200&h=630'
    _publish(monkeypatch, home=home)
    meta = _meta(blog.get('/blog/launch', headers={'User-Agent': GOOGLEBOT}).text)
    assert meta['og:image'] == ['https://cdn.example/launch.png?w=1200&amp;h=630']


def test_without_rr_app_url_only_https_images_are_kept(shell_root, monkeypatch):
    monkeypatch.delenv('RR_APP_URL', raising=False)
    home = copy.deepcopy(BLOG_HOME)
    home['site']['image'] = 'https://cdn.example/site.png'
    _publish(monkeypatch, home=home)
    client = _client()
    for path in ('/blog/launch', '/blog/hello'):
        meta = _meta(client.get(path, headers={'User-Agent': GOOGLEBOT}).text)
        # The page's own image cannot be made absolute, so the site image stands in.
        assert meta['og:image'] == ['https://cdn.example/site.png'], path
    _publish(monkeypatch)
    meta = _meta(client.get('/blog/launch', headers={'User-Agent': GOOGLEBOT}).text)
    assert 'og:image' not in meta and meta['twitter:card'] == ['summary']


def test_a_page_without_any_image_gets_the_summary_card(shell_root, monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    pp.swap(Aggregate(exact={'/x': Page('/x', 'rocketride.home', 'X')}, site={}))
    meta = _meta(_client().get('/x', headers={'User-Agent': GOOGLEBOT}).text)
    assert meta['og:type'] == ['website'] and meta['twitter:card'] == ['summary']
    assert 'og:image' not in meta and 'og:site_name' not in meta


@pytest.mark.parametrize(
    'field', ['site.title', 'site.blurb', 'site.image', 'title', 'description', 'image', 'authors.name', 'authors.url']
)
def test_a_lone_surrogate_is_refused_before_it_reaches_any_head(shell_root, monkeypatch, field):
    # Half of an emoji, as a JS .slice() through one leaves it: it has no UTF-8
    # encoding, so a head carrying it could not be sent.
    surrogate = '\ud83d'
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    home = copy.deepcopy(BLOG_HOME)
    post = home['publicPages'][2]
    url = f'https://cdn.example/{surrogate}.png'
    if field.startswith('site.'):
        home['site'][field[5:]] = url if field == 'site.image' else f'RocketRide {surrogate}'
    elif field.startswith('authors.'):
        post['authors'][0][field[8:]] = url if field == 'authors.url' else f'Ansh {surrogate}'
    else:
        post[field] = url if field == 'image' else f'Launch {surrogate}'
    _publish(monkeypatch, home=home)
    # A bad site field drops the site block; a bad page field drops the page.
    assert ('/blog/launch' in pp.current().exact) is field.startswith('site.')
    client = _client()
    for path in pp.current().exact:
        for ua in (GOOGLEBOT, BROWSER):
            resp = client.get(path, headers={'User-Agent': ua})
            assert resp.status_code == 200 and surrogate not in resp.text, (path, ua)


def test_a_hostile_site_title_stays_escaped_in_every_head(shell_root, monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    home = copy.deepcopy(BLOG_HOME)
    home['site']['title'] = '"><script>alert(1)</script><!--'
    _publish(monkeypatch, home=home)
    for ua in (GOOGLEBOT, BROWSER):
        text = _client().get('/blog/launch', headers={'User-Agent': ua}).text
        assert '<script>alert' not in text and '<!--' not in text
        assert _meta(text)['og:site_name'] == ['&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;!--']


# ---------------------------------------------------------------------------
# BlogPosting JSON-LD (crawlers only)
# ---------------------------------------------------------------------------

_LD = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)


def _jsonld(text: str) -> list:
    return [json.loads(block) for block in _LD.findall(text)]


def test_crawlers_get_a_blogposting_for_each_dated_page(blog):
    assert _jsonld(blog.get('/blog/launch', headers={'User-Agent': GOOGLEBOT}).text) == [
        {
            '@context': 'https://schema.org',
            '@type': 'BlogPosting',
            'headline': 'Launch',
            'description': 'We launched.',
            'datePublished': '2026-11-09',
            'dateModified': '2026-11-10T09:00:00Z',
            'author': [
                {'@type': 'Person', 'name': 'Ansh', 'url': 'https://rocketride.ai/team/ansh'},
                {'@type': 'Person', 'name': 'Rod'},
            ],
            'image': f'{APP_URL}/apps/rocketride.home/v3/blog/launch.png',
            'publisher': {'@type': 'Organization', 'name': 'RocketRide', 'url': f'{APP_URL}/'},
            'mainEntityOfPage': f'{APP_URL}/blog/launch',
        }
    ]


def test_a_post_without_authors_is_by_its_publisher(blog):
    [post] = _jsonld(blog.get('/blog/hello', headers={'User-Agent': GOOGLEBOT}).text)
    assert post['author'] == post['publisher'] == {'@type': 'Organization', 'name': 'RocketRide', 'url': f'{APP_URL}/'}
    assert post['datePublished'] == post['dateModified'] == '2026-10-01T08:00:00+02:00'
    assert post['image'] == f'{APP_URL}/apps/rocketride.home/seo-assets/hello.png'


def test_people_and_undated_pages_get_no_blogposting(blog):
    assert _jsonld(blog.get('/blog/launch', headers={'User-Agent': BROWSER}).text) == []
    for path in ('/', '/blog'):
        assert _jsonld(blog.get(path, headers={'User-Agent': GOOGLEBOT}).text) == [], path


def test_blogposting_escapes_script_close(shell_root, monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    hostile = '</script><script>alert(1)</script> ]]> <!-- & </SCRIPT >'
    home = copy.deepcopy(BLOG_HOME)
    home['site']['title'] = hostile
    home['publicPages'][2].update(title=hostile, description=hostile, authors=[{'name': hostile}])
    _publish(monkeypatch, home=home)
    text = _client().get('/blog/launch', headers={'User-Agent': GOOGLEBOT}).text
    assert '<script>alert' not in text and '</SCRIPT' not in text and '<!--' not in text
    [inner] = _LD.findall(text)
    assert not set('<>&') & set(inner)
    [post] = _jsonld(text)
    assert post['headline'] == post['description'] == post['author'][0]['name'] == post['publisher']['name'] == hostile


def test_a_post_leaves_out_the_fields_it_lacks():
    post = Page('/blog/x', 'rocketride.home', 'X', published='2026-11-09')
    out = blogposting(post, {'title': 'RocketRide'}, canonical='', image='')
    assert 'mainEntityOfPage' not in out and 'image' not in out and 'description' not in out


def test_a_declared_organization_is_referenced_by_its_id():
    post = Page('/blog/x', 'rocketride.home', 'X', published='2026-11-09')
    site = {'title': 'RocketRide', 'organization': {'name': 'RocketRide', 'url': 'https://rocketride.ai'}}
    out = blogposting(post, site, canonical='', image='')
    assert out['publisher'] == out['author'] == {'@id': 'https://rocketride.ai#organization'}


def test_without_rr_app_url_the_publisher_has_no_url(monkeypatch):
    monkeypatch.delenv('RR_APP_URL', raising=False)
    post = Page('/blog/x', 'rocketride.home', 'X', published='2026-11-09')
    assert blogposting(post, {'title': 'RocketRide'}, canonical='', image='')['publisher'] == {
        '@type': 'Organization',
        'name': 'RocketRide',
    }
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    # No site title: the organization is named after the origin.
    assert blogposting(post, {}, canonical='', image='')['publisher'] == {
        '@type': 'Organization',
        'name': 'cloud.example',
        'url': f'{APP_URL}/',
    }


@pytest.mark.parametrize(
    'title,site_title,headline',
    [
        ('Launch | RocketRide', 'RocketRide', 'Launch'),
        ('Launch | RocketRide | RocketRide', 'RocketRide', 'Launch | RocketRide'),
        ('Launch | Other', 'RocketRide', 'Launch | Other'),
        ('Launch | RocketRide', '', 'Launch | RocketRide'),
        ('Launch | ', '', 'Launch | '),
        # A title that is only the suffix stays whole.
        (' | RocketRide', 'RocketRide', ' | RocketRide'),
    ],
)
def test_the_headline_drops_the_site_suffix(title, site_title, headline):
    post = Page('/blog/x', 'rocketride.home', title, published='2026-11-09')
    assert blogposting(post, {'title': site_title}, canonical='', image='')['headline'] == headline


def test_the_head_keeps_the_full_title(blog):
    text = blog.get('/blog/launch', headers={'User-Agent': GOOGLEBOT}).text
    assert '<title>Launch | RocketRide</title>' in text and _meta(text)['og:title'] == ['Launch | RocketRide']
    assert _jsonld(text)[0]['headline'] == 'Launch'
